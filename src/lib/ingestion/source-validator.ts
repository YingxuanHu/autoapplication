import type {
  CompanySourcePollState,
  CompanySourceValidationState,
  ExtractionRouteKind,
} from "@/generated/prisma/client";
import {
  createCompanySiteConnector,
  inspectCompanySiteRoute,
  parseTaleoSourceToken,
  validateTaleoPortal,
} from "@/lib/ingestion/connectors";
import { createConnectorForCandidate } from "@/lib/ingestion/discovery/sources";
import type { SourceConnectorFetchResult } from "@/lib/ingestion/types";

const HARD_INVALID_STATUSES = new Set([404, 410]);
const BLOCKED_STATUSES = new Set([401, 403, 429]);
const TRANSIENT_ERROR_STATUSES = new Set([408, 500, 502, 503, 504]);
const DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS = new Set([
  "greenhouse",
  "lever",
  "ashby",
]);

type ValidationKind =
  | "VALIDATED"
  | "SUSPECT"
  | "INVALID"
  | "BLOCKED"
  | "NEEDS_REDISCOVERY";

export type SourceValidationResult = {
  kind: ValidationKind;
  validationState: CompanySourceValidationState;
  pollState: CompanySourcePollState;
  httpStatus: number | null;
  jobsFound: number;
  message: string;
  sourceQualityScore: number;
  recommendedCooldownMinutes: number;
};

type ValidatableCompanySource = {
  sourceName: string;
  connectorName: string;
  token: string;
  boardUrl: string;
  sourceType: string | null;
  extractionRoute: ExtractionRouteKind;
  parserVersion: string | null;
  validationState: CompanySourceValidationState;
  consecutiveFailures: number;
  company: {
    name: string;
  };
};

export async function validateCompanySource(
  source: ValidatableCompanySource,
  now: Date = new Date()
): Promise<SourceValidationResult> {
  if (source.connectorName === "company-site") {
    return validateCompanySiteSource(source, now);
  }

  if (source.connectorName === "taleo") {
    return validateTaleoSource(source);
  }

  const connector = createConnectorForCandidate({
    input: source.boardUrl,
    connectorName: source.connectorName as Parameters<typeof createConnectorForCandidate>[0]["connectorName"],
    token: source.token,
    sourceKey: `${source.connectorName}:${source.token}`.toLowerCase(),
    sourceName: source.sourceName,
    boardUrl: source.boardUrl,
    source: "url",
  });

  try {
    const result = await connector.fetchJobs({
      now,
      limit: 1,
      log: () => {},
    });
    return classifyConnectorFetch(source, result);
  } catch (error) {
    return classifyThrownError(source, error);
  }
}

async function validateTaleoSource(
  source: ValidatableCompanySource
): Promise<SourceValidationResult> {
  try {
    const target = parseTaleoSourceToken(source.token);
    const result = await validateTaleoPortal(target.tenant, target.careerSection);

    if (result.valid && result.sitemapEntryCount > 0) {
      const sourceQualityScore = clampQualityScore(
        result.sitemapEntryCount >= 25 ? 0.84 : result.sitemapEntryCount >= 5 ? 0.76 : 0.68
      );

      return {
        kind: "VALIDATED",
        validationState: "VALIDATED",
        pollState: "READY",
        httpStatus: 200,
        jobsFound: Math.min(result.sitemapEntryCount, 1),
        message: `Validated Taleo source via sitemap with ${result.sitemapEntryCount} ${result.sitemapEntryCount === 1 ? "entry" : "entries"}.`,
        sourceQualityScore,
        recommendedCooldownMinutes: 0,
      };
    }

    const shouldRediscover =
      source.validationState === "SUSPECT" || source.consecutiveFailures >= 1;
    const message = result.error
      ? `Taleo sitemap validation failed: ${result.error}`
      : "Taleo sitemap exposed no listings for this career section.";

    return {
      kind: shouldRediscover ? "NEEDS_REDISCOVERY" : "SUSPECT",
      validationState: shouldRediscover ? "NEEDS_REDISCOVERY" : "SUSPECT",
      pollState: shouldRediscover ? "QUARANTINED" : "BACKOFF",
      httpStatus: null,
      jobsFound: 0,
      message,
      sourceQualityScore: shouldRediscover ? 0.08 : 0.18,
      recommendedCooldownMinutes: shouldRediscover ? 720 : 360,
    };
  } catch (error) {
    return classifyThrownError(source, error);
  }
}

async function validateCompanySiteSource(
  source: ValidatableCompanySource,
  now: Date
): Promise<SourceValidationResult> {
  try {
    const inspection = await inspectCompanySiteRoute(source.boardUrl);
    if (inspection.extractionRoute === "UNKNOWN") {
      return {
        kind: "NEEDS_REDISCOVERY",
        validationState: "NEEDS_REDISCOVERY",
        pollState: "QUARANTINED",
        httpStatus: null,
        jobsFound: 0,
        message: "Career surface did not expose a stable ATS, structured feed, or HTML job listing.",
        sourceQualityScore: 0.12,
        recommendedCooldownMinutes: 360,
      };
    }

    const connector = createCompanySiteConnector({
      sourceName: source.sourceName,
      companyName: source.company.name,
      boardUrl: inspection.finalUrl,
      extractionRoute: inspection.extractionRoute,
      parserVersion: inspection.parserVersion,
    });
    const result = await connector.fetchJobs({
      now,
      limit: 1,
      log: () => {},
    });

    if (result.jobs.length > 0) {
      return {
        kind: "VALIDATED",
        validationState: "VALIDATED",
        pollState: "READY",
        httpStatus: 200,
        jobsFound: result.jobs.length,
        message:
          inspection.extractionRoute === "HTML_FALLBACK"
            ? "HTML careers surface exposed at least one valid listing."
            : "Structured company careers surface validated.",
        sourceQualityScore: clampQualityScore(
          inspection.extractionRoute === "HTML_FALLBACK" ? 0.58 : 0.83
        ),
        recommendedCooldownMinutes: 0,
      };
    }

    if (inspection.extractionRoute === "HTML_FALLBACK") {
      return {
        kind: "SUSPECT",
        validationState: "SUSPECT",
        pollState: "BACKOFF",
        httpStatus: 200,
        jobsFound: 0,
        message: "Careers page is reachable, but HTML fallback did not extract a listing yet.",
        sourceQualityScore: 0.34,
        recommendedCooldownMinutes: 240,
      };
    }

    return {
      kind: "VALIDATED",
      validationState: "VALIDATED",
      pollState: "READY",
      httpStatus: 200,
      jobsFound: 0,
      message: "Structured careers endpoint responded successfully with an empty board.",
      sourceQualityScore: 0.62,
      recommendedCooldownMinutes: 0,
    };
  } catch (error) {
    return classifyThrownError(source, error);
  }
}

function classifyConnectorFetch(
  source: ValidatableCompanySource,
  result: SourceConnectorFetchResult
): SourceValidationResult {
  const metadata = asRecord(result.metadata);
  const errorMessage = readMetadataString(metadata, "error");
  const httpStatus = parseHttpStatus(errorMessage);

  if (httpStatus && HARD_INVALID_STATUSES.has(httpStatus)) {
    return escalateHardFailure(source, httpStatus, errorMessage ?? "Source endpoint returned a hard not-found response.");
  }

  if (httpStatus && BLOCKED_STATUSES.has(httpStatus)) {
    return {
      kind: "BLOCKED",
      validationState: "BLOCKED",
      pollState: "BACKOFF",
      httpStatus,
      jobsFound: 0,
      message: errorMessage ?? "Source endpoint blocked validation requests.",
      sourceQualityScore: 0.2,
      recommendedCooldownMinutes: 360,
    };
  }

  if (result.jobs.length > 0) {
    return {
      kind: "VALIDATED",
      validationState: "VALIDATED",
      pollState: "READY",
      httpStatus: httpStatus ?? 200,
      jobsFound: result.jobs.length,
      message: `Validated ${source.connectorName} source with at least one live posting.`,
      sourceQualityScore: baseQualityScoreForSource(source, true),
      recommendedCooldownMinutes: 0,
    };
  }

  if (errorMessage) {
    if (httpStatus && TRANSIENT_ERROR_STATUSES.has(httpStatus)) {
      return {
        kind: "SUSPECT",
        validationState: "SUSPECT",
        pollState: "BACKOFF",
        httpStatus,
        jobsFound: 0,
        message: errorMessage,
        sourceQualityScore: 0.28,
        recommendedCooldownMinutes: 180,
      };
    }

    return {
      kind: "SUSPECT",
      validationState: "SUSPECT",
      pollState: "BACKOFF",
      httpStatus,
      jobsFound: 0,
      message: errorMessage,
      sourceQualityScore: 0.3,
      recommendedCooldownMinutes: 240,
    };
  }

  return {
    kind: "VALIDATED",
    validationState: "VALIDATED",
    pollState: "READY",
    httpStatus: httpStatus ?? 200,
    jobsFound: 0,
    message: `Validated ${source.connectorName} source with a successful empty-board response.`,
    sourceQualityScore: baseQualityScoreForSource(source, false),
    recommendedCooldownMinutes: 0,
  };
}

function classifyThrownError(
  source: ValidatableCompanySource,
  error: unknown
): SourceValidationResult {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = parseHttpStatus(message);

  if (httpStatus && HARD_INVALID_STATUSES.has(httpStatus)) {
    return escalateHardFailure(source, httpStatus, message);
  }

  if (httpStatus && BLOCKED_STATUSES.has(httpStatus)) {
    return {
      kind: "BLOCKED",
      validationState: "BLOCKED",
      pollState: "BACKOFF",
      httpStatus,
      jobsFound: 0,
      message,
      sourceQualityScore: 0.2,
      recommendedCooldownMinutes: 360,
    };
  }

  return {
    kind: "SUSPECT",
    validationState: "SUSPECT",
    pollState: "BACKOFF",
    httpStatus,
    jobsFound: 0,
    message,
    sourceQualityScore: 0.22,
    recommendedCooldownMinutes: 180,
  };
}

function escalateHardFailure(
  source: ValidatableCompanySource,
  httpStatus: number,
  message: string
): SourceValidationResult {
  const isDeterministicHardInvalidVendor = DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS.has(
    source.connectorName
  );
  const shouldInvalidate =
    isDeterministicHardInvalidVendor ||
    source.validationState === "SUSPECT" ||
    source.consecutiveFailures >= 1;
  const vendorSpecificMessage = buildHardInvalidMessage(source, httpStatus, message);

  return {
    kind: shouldInvalidate ? "INVALID" : "SUSPECT",
    validationState: shouldInvalidate ? "INVALID" : "SUSPECT",
    pollState: shouldInvalidate ? "QUARANTINED" : "BACKOFF",
    httpStatus,
    jobsFound: 0,
    message: vendorSpecificMessage,
    sourceQualityScore: shouldInvalidate ? 0.05 : 0.15,
    recommendedCooldownMinutes: shouldInvalidate ? 720 : 240,
  };
}

function buildHardInvalidMessage(
  source: ValidatableCompanySource,
  httpStatus: number,
  fallbackMessage: string
) {
  if (!DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS.has(source.connectorName)) {
    return fallbackMessage;
  }

  const vendorLabel =
    source.connectorName === "greenhouse"
      ? "Greenhouse board"
      : source.connectorName === "lever"
        ? "Lever board"
        : source.connectorName === "ashby"
          ? "Ashby board"
          : `${source.connectorName} source`;

  return `${vendorLabel} returned HTTP ${httpStatus}. The token is likely invalid, retired, or no longer mapped to a live careers surface.`;
}

function baseQualityScoreForSource(
  source: ValidatableCompanySource,
  hasJob: boolean
) {
  let score =
    source.sourceType === "ATS"
      ? 0.92
      : source.sourceType === "COMPANY_JSON"
        ? 0.78
        : source.extractionRoute === "HTML_FALLBACK"
          ? 0.54
          : 0.66;

  if (!hasJob) score -= 0.12;
  return clampQualityScore(score);
}

function clampQualityScore(score: number) {
  return Math.max(0.01, Math.min(0.99, Number(score.toFixed(2))));
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readMetadataString(
  metadata: Record<string, unknown> | null,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseHttpStatus(message: string | null | undefined) {
  if (!message) return null;
  const statusMatch = message.match(/\b(401|403|404|408|410|429|500|502|503|504)\b/);
  if (!statusMatch) return null;
  return Number(statusMatch[1]);
}
