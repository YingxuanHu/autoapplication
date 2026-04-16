import { prisma } from "@/lib/db";
import {
  createCompanySiteConnector,
  inspectCompanySiteRoute,
} from "@/lib/ingestion/connectors";
import {
  buildCompanyDiscoveryCorpus,
  buildCompanyKey,
  cleanCompanyName,
} from "@/lib/ingestion/discovery/company-corpus";
import {
  discoverEnterpriseCareerPageCandidates,
} from "@/lib/ingestion/discovery/career-pages";
import {
  buildDiscoveredSourceName,
  createConnectorForCandidate,
  isKnownAtsHost,
  type DiscoveredSourceCandidate,
} from "@/lib/ingestion/discovery/sources";
import {
  ENTERPRISE_DISCOVERY_COMPANIES,
  type EnterpriseCompanyRecord,
} from "@/lib/ingestion/discovery/enterprise-catalog";
import { ensureCompanyRecord, assignCanonicalJobsToCompany } from "@/lib/ingestion/company-records";
import {
  seedCompaniesFromCanonicalInventory,
  seedCompanySourcesFromExistingAts,
} from "@/lib/ingestion/company-seeder";
import {
  ingestConnector,
  recoverStaleRunningIngestionRuns,
} from "@/lib/ingestion/pipeline";
import { validateCompanySource } from "@/lib/ingestion/source-validator";
import {
  claimSourceTasks,
  enqueueUniqueSourceTask,
  finishSourceTask,
} from "@/lib/ingestion/task-queue";
import type {
  CompanyDiscoveryStatus,
  CompanySourcePollState,
  CompanySourceStatus,
  CompanySourceValidationState,
  ExtractionRouteKind,
  Prisma,
  SourceTask,
} from "@/generated/prisma/client";

const DISCOVERY_TASK_LIMIT = 200;
const SOURCE_VALIDATION_TASK_LIMIT = 500;
const COMPANY_SOURCE_POLL_LIMIT = 500;
const REDISCOVERY_TASK_LIMIT = 80;
const DEFAULT_SOURCE_POLL_CADENCE_MINUTES = 180;
const MAX_CAREER_PAGE_INSPECTIONS = 6;
const MAX_CAREER_PAGE_INSPECTIONS_CSV_IMPORT = 10;
const REDISCOVERY_FAILURE_THRESHOLD = 3;
const DEFAULT_COMPANY_CATALOG_SEED_LIMIT = 1_000;
const DEFAULT_COMPANY_CORPUS_SEED_LIMIT = 5_000;
const DEFAULT_COMPANY_INVENTORY_SEED_LIMIT = 8_000;
const DEFAULT_EXISTING_ATS_SEED_LIMIT = 2_000;
const DISCOVERY_QUEUE_CONCURRENCY = 24;
const SOURCE_VALIDATION_QUEUE_CONCURRENCY = 32;
const COMPANY_SOURCE_POLL_CONCURRENCY = 32;
const COMPANY_SOURCE_POLL_LOW_TIME_CONCURRENCY = 4;
const COMPANY_SOURCE_POLL_CRITICAL_TIME_CONCURRENCY = 1;
const HARD_FAILURE_REDISCOVERY_THRESHOLD = 2;
const WORKDAY_BLOCKED_REDISCOVERY_THRESHOLD = 2;
const WORKDAY_TIER_A_VALUE_SCORE = 60;
const WORKDAY_TIER_B_VALUE_SCORE = 20;
// Per-cycle cap on how many sources of a given connector can be polled.
// Workday's myworkdayjobs.com infrastructure rate-limits aggressively — hitting
// many tenants simultaneously triggers Cloudflare bot detection for all of them.
// Taleo is also intentionally capped because its headless+sitemap fallback path
// is much slower than the ATS APIs and can monopolize the cycle.
const CONNECTOR_POLL_CYCLE_CAPS: Record<string, number> = {
  workday: 4,
  taleo: 2,
};
// Per-source connector runtime cap (passed to ingestConnector).
// Kept below the stale-run recovery windows so a slow source fails within the
// same cycle instead of lingering as RUNNING into the next one.
const COMPANY_SOURCE_POLL_MAX_RUNTIME_MS = 4 * 60 * 1000;
// Wall-clock cap for the entire poll queue across all batches.
// With the daemon running every 10 minutes in dev and every 30 minutes in the
// standalone script, letting source polling consume 25+ minutes starves the
// rest of the cycle. Keep this tighter and adapt batch runtime as the queue
// approaches the deadline.
const COMPANY_SOURCE_POLL_QUEUE_WALL_CLOCK_MS = 12 * 60 * 1000;
const COMPANY_SOURCE_POLL_MIN_REMAINING_BUDGET_MS = 90 * 1000;
const COMPANY_SOURCE_POLL_BATCH_GRACE_MS = 90 * 1000;
const COMPANY_SOURCE_POLL_LATE_STAGE_WINDOW_MS = 5 * 60 * 1000;
const COMPANY_SOURCE_POLL_END_STAGE_WINDOW_MS = 2 * 60 * 1000;
const COMPANY_SOURCE_STALE_RUN_RECOVERY_INTERVAL_MS = 60 * 1000;
const COMPANY_SOURCE_POLL_ADMISSION_BUDGET_RATIO = 0.88;
const COMPANY_SOURCE_POLL_SOFT_STOP_RATIO = 0.88;
const COMPANY_SOURCE_POLL_TIER_1_BUDGET_RATIO = 0.65;
const COMPANY_SOURCE_POLL_TIER_2_BUDGET_RATIO = 0.25;
const COMPANY_SOURCE_POLL_TIER_3_BUDGET_RATIO = 0.1;
const COMPANY_SOURCE_POLL_PREVIEW_MULTIPLIER = 3;
const COMPANY_SOURCE_POLL_DEFER_TIER_2_MINUTES = 10;
const COMPANY_SOURCE_POLL_DEFER_TIER_3_MINUTES = 30;
const WORKDAY_HOST_BLOCK_STREAK_THRESHOLD = 3;
const WORKDAY_HOST_COOLDOWN_HOURS = 12;
const WORKDAY_BLOCKED_HTTP_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);
const DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS = new Set([
  "greenhouse",
  "lever",
  "ashby",
]);
const PRODUCTIVE_IMPORTED_POLL_CONNECTORS = new Set([
  "greenhouse",
  "lever",
  "ashby",
]);
const LOW_SIGNAL_IMPORTED_POLL_CONNECTORS = new Set([
  "workable",
  "smartrecruiters",
  "workday",
  "successfactors",
  "icims",
  "recruitee",
]);
const TIER_1_POLL_CONNECTORS = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "jobvite",
  "teamtailor",
]);
const TIER_1_CONDITIONAL_CONNECTORS = new Set([
  "smartrecruiters",
  "icims",
]);
const DEFAULT_CONNECTOR_POLL_RUNTIME_MS: Record<string, number> = {
  ashby: 22_000,
  "company-site": 55_000,
  greenhouse: 16_000,
  icims: 34_000,
  jobvite: 24_000,
  lever: 15_000,
  recruitee: 18_000,
  rippling: 16_000,
  smartrecruiters: 24_000,
  successfactors: 42_000,
  taleo: 70_000,
  teamtailor: 24_000,
  workable: 20_000,
  workday: 55_000,
};
const HARD_CONNECTOR_POLL_TIMEOUT_MS: Record<string, number> = {
  ashby: 60_000,
  greenhouse: 45_000,
  icims: 90_000,
  jobvite: 75_000,
  lever: 45_000,
  recruitee: 60_000,
  rippling: 60_000,
  smartrecruiters: 75_000,
  successfactors: 120_000,
  taleo: 120_000,
  teamtailor: 75_000,
  workable: 60_000,
  workday: 120_000,
  "company-site": 120_000,
};

type PollTier = "TIER_1" | "TIER_2" | "TIER_3";

type WorkdayHostMetrics = {
  host: string;
  avgRuntimeMs: number | null;
  blockedSourceCount: number;
  blockedStreak: number;
  cooldownUntil: Date | null;
  recentSuccessCount: number;
};

function clampScore(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function computeSourceYieldScore(input: {
  sourceQualityScore: number;
  pollAttemptCount: number;
  pollSuccessCount: number;
  jobsFetchedCount: number;
  jobsAcceptedCount: number;
  jobsCreatedCount: number;
  retainedLiveJobCount: number;
  overlapRatio: number | null;
}) {
  const successRate =
    input.pollAttemptCount > 0
      ? input.pollSuccessCount / input.pollAttemptCount
      : 0;
  const acceptanceRate =
    input.jobsFetchedCount > 0
      ? input.jobsAcceptedCount / input.jobsFetchedCount
      : 0;
  const creationRate =
    input.jobsFetchedCount > 0
      ? input.jobsCreatedCount / input.jobsFetchedCount
      : 0;
  const retainedRate =
    input.jobsAcceptedCount > 0
      ? input.retainedLiveJobCount / input.jobsAcceptedCount
      : input.jobsCreatedCount > 0
        ? input.retainedLiveJobCount / input.jobsCreatedCount
        : 0;
  const acceptedPerSuccessfulPoll =
    input.pollSuccessCount > 0 ? input.jobsAcceptedCount / input.pollSuccessCount : 0;
  const createdPerSuccessfulPoll =
    input.pollSuccessCount > 0 ? input.jobsCreatedCount / input.pollSuccessCount : 0;
  const retainedPerSuccessfulPoll =
    input.pollSuccessCount > 0
      ? input.retainedLiveJobCount / input.pollSuccessCount
      : 0;
  const overlapPenalty = input.overlapRatio ?? 0;

  return clampScore(
    input.sourceQualityScore * 0.22 +
      successRate * 0.16 +
      acceptanceRate * 0.08 +
      creationRate * 0.12 +
      Math.min(1, acceptedPerSuccessfulPoll / 175) * 0.08 +
      Math.min(1, createdPerSuccessfulPoll / 20) * 0.20 +
      Math.min(1, retainedPerSuccessfulPoll / 125) * 0.16 +
      retainedRate * 0.10 -
      overlapPenalty * 0.08,
    0.01,
    0.99
  );
}

function computeValidationPriorityScore(input: {
  priorityScore: number;
  sourceQualityScore: number;
  yieldScore: number;
  discoveryConfidence: number;
  historicalYield: number;
  validationState: string;
  consecutiveFailures: number;
  validationAttemptCount: number;
  validationSuccessCount: number;
  sourceType: string | null;
  parserVersion: string | null;
}) {
  const validationSuccessRate =
    input.validationAttemptCount > 0
      ? input.validationSuccessCount / input.validationAttemptCount
      : 0;
  const csvImportBoost =
    input.parserVersion === "csv-import:v1" && input.sourceType === "ATS" ? 18 : 0;
  const structuredCompanySiteBoost =
    input.sourceType === "COMPANY_JSON" &&
    Boolean(input.parserVersion?.startsWith("company-site:"))
      ? 16
      : 0;

  return (
    Math.round(input.priorityScore * 100) / 100 +
    Math.round(input.sourceQualityScore * 45) +
    Math.round(input.yieldScore * 35) +
    Math.min(35, input.historicalYield * 1.25) +
    (input.validationState === "UNVALIDATED" ? 40 : 0) +
    (input.validationState === "SUSPECT" ? 20 : 0) +
    (input.validationState === "NEEDS_REDISCOVERY" ? 10 : 0) +
    csvImportBoost +
    structuredCompanySiteBoost +
    Math.round(validationSuccessRate * 20) -
    Math.max(0, input.consecutiveFailures * 5) +
    Math.round(input.discoveryConfidence * 10)
  );
}

function computePollPriorityScore(input: {
  connectorName: string;
  priorityScore: number;
  sourceQualityScore: number;
  yieldScore: number;
  discoveryConfidence: number;
  historicalYield: number;
  status: string;
  consecutiveFailures: number;
  pollAttemptCount: number;
  pollSuccessCount: number;
  jobsAcceptedCount: number;
  jobsCreatedCount: number;
  lastJobsAcceptedCount: number;
  lastJobsCreatedCount: number;
  retainedLiveJobCount: number;
  sourceType: string | null;
  parserVersion: string | null;
}) {
  const pollSuccessRate =
    input.pollAttemptCount > 0
      ? input.pollSuccessCount / input.pollAttemptCount
      : 0;
  const acceptedPerSuccessfulPoll =
    input.pollSuccessCount > 0 ? input.jobsAcceptedCount / input.pollSuccessCount : 0;
  const createdPerSuccessfulPoll =
    input.pollSuccessCount > 0 ? input.jobsCreatedCount / input.pollSuccessCount : 0;
  const bootstrapBoost =
    input.pollAttemptCount === 0 ? 42 : input.pollSuccessCount === 0 ? 18 : 0;
  const csvImportBootstrapBoost =
    input.parserVersion === "csv-import:v1" &&
    input.sourceType === "ATS" &&
    input.pollAttemptCount === 0
      ? 18
      : 0;
  const productiveImportedConnectorBoost =
    input.parserVersion === "csv-import:v1" &&
    PRODUCTIVE_IMPORTED_POLL_CONNECTORS.has(input.connectorName)
      ? input.pollAttemptCount === 0
        ? 26
        : 18
      : 0;
  const structuredCompanySiteBootstrapBoost =
    input.sourceType === "COMPANY_JSON" &&
    Boolean(input.parserVersion?.startsWith("company-site:")) &&
    input.pollAttemptCount === 0
      ? 24
      : 0;
  const lowYieldPenalty =
    input.pollSuccessCount >= 3 && input.jobsCreatedCount === 0 ? 35 : 0;
  const emptyPenalty =
    input.pollSuccessCount >= 2 && input.jobsAcceptedCount === 0 ? 20 : 0;
  const importedLowSignalPenalty =
    input.parserVersion === "csv-import:v1" &&
    LOW_SIGNAL_IMPORTED_POLL_CONNECTORS.has(input.connectorName) &&
    input.pollAttemptCount >= 2 &&
    input.jobsCreatedCount === 0
      ? 28
      : 0;
  const workdayPriorityAdjustment =
    input.connectorName === "workday"
      ? computeWorkdayPollPriorityAdjustment({
          pollAttemptCount: input.pollAttemptCount,
          pollSuccessCount: input.pollSuccessCount,
          jobsAcceptedCount: input.jobsAcceptedCount,
          retainedLiveJobCount: input.retainedLiveJobCount,
          lastJobsAcceptedCount: input.lastJobsAcceptedCount,
          lastJobsCreatedCount: input.lastJobsCreatedCount,
          consecutiveFailures: input.consecutiveFailures,
        })
      : 0;

  return (
    Math.round(input.priorityScore * 100) / 100 +
    Math.round(input.sourceQualityScore * 28) +
    Math.round(input.yieldScore * 72) +
    Math.round(pollSuccessRate * 18) +
    Math.min(36, input.historicalYield * 1.2) +
    Math.min(44, acceptedPerSuccessfulPoll * 0.3) +
    Math.min(120, createdPerSuccessfulPoll * 4) +
    Math.min(42, input.retainedLiveJobCount * 0.25) +
    Math.min(40, input.lastJobsAcceptedCount * 0.25) +
    Math.min(90, input.lastJobsCreatedCount * 8) +
    bootstrapBoost +
    csvImportBootstrapBoost +
    productiveImportedConnectorBoost +
    structuredCompanySiteBootstrapBoost +
    workdayPriorityAdjustment +
    (input.status === "DEGRADED" ? 10 : 0) +
    Math.max(0, 15 - input.consecutiveFailures * 3) +
    Math.round(input.discoveryConfidence * 10) -
    lowYieldPenalty -
    emptyPenalty -
    importedLowSignalPenalty
  );
}

type WorkdayValueScoreInput = {
  pollAttemptCount: number;
  pollSuccessCount: number;
  jobsAcceptedCount: number;
  retainedLiveJobCount: number;
};

function computeWorkdayValueScore(input: WorkdayValueScoreInput) {
  const recentSuccessRate =
    input.pollAttemptCount > 0 ? input.pollSuccessCount / input.pollAttemptCount : 0;

  return (
    input.retainedLiveJobCount * 0.5 +
    input.jobsAcceptedCount * 0.3 +
    recentSuccessRate * 100 * 0.2
  );
}

function getWorkdayTier(valueScore: number) {
  if (valueScore >= WORKDAY_TIER_A_VALUE_SCORE) return "A" as const;
  if (valueScore >= WORKDAY_TIER_B_VALUE_SCORE) return "B" as const;
  return "C" as const;
}

function computeWorkdayPollPriorityAdjustment(
  input: WorkdayValueScoreInput & {
    lastJobsAcceptedCount: number;
    lastJobsCreatedCount: number;
    consecutiveFailures: number;
  }
) {
  const valueScore = computeWorkdayValueScore(input);
  const tier = getWorkdayTier(valueScore);
  const tierBoost = tier === "A" ? 120 : tier === "B" ? 55 : -28;
  const recentWindowBoost =
    input.lastJobsAcceptedCount > 0
      ? Math.min(40, input.lastJobsAcceptedCount * 2)
      : input.lastJobsCreatedCount > 0
        ? Math.min(28, input.lastJobsCreatedCount * 4)
        : 0;
  const blockedDrag =
    input.consecutiveFailures <= 1
      ? 0
      : tier === "A"
        ? Math.min(18, input.consecutiveFailures * 4)
        : tier === "B"
          ? Math.min(30, input.consecutiveFailures * 6)
          : Math.min(48, input.consecutiveFailures * 10);

  return tierBoost + recentWindowBoost - blockedDrag;
}

function isHighValueWorkdaySource(input: WorkdayValueScoreInput) {
  return getWorkdayTier(computeWorkdayValueScore(input)) !== "C";
}

function pickBalancedPollSources<T extends { source: { connectorName: string }; priorityScore: number }>(
  candidates: T[],
  limit: number,
  tieBreaker: (left: T, right: T) => number
) {
  if (limit <= 0 || candidates.length === 0) return [] as T[];

  const buckets = new Map<string, T[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.source.connectorName) ?? [];
    bucket.push(candidate);
    buckets.set(candidate.source.connectorName, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }

      return tieBreaker(left, right);
    });
  }

  const selected: T[] = [];

  while (selected.length < limit && buckets.size > 0) {
    const round = [...buckets.entries()]
      .map(([connectorName, bucket]) => {
        const head = bucket[0];
        return head ? { connectorName, head } : null;
      })
      .filter((entry): entry is { connectorName: string; head: T } => entry !== null)
      .sort((left, right) => {
        if (right.head.priorityScore !== left.head.priorityScore) {
          return right.head.priorityScore - left.head.priorityScore;
        }

        return tieBreaker(left.head, right.head);
      });

    if (round.length === 0) break;

    for (const { connectorName } of round) {
      if (selected.length >= limit) break;

      const bucket = buckets.get(connectorName);
      const next = bucket?.shift();
      if (!next) {
        buckets.delete(connectorName);
        continue;
      }

      selected.push(next);
      if (bucket && bucket.length === 0) {
        buckets.delete(connectorName);
      }
    }
  }

  return selected;
}

function readJsonRecord(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, unknown>;
  }

  return value as Record<string, unknown>;
}

function readNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function mergeMetadataJson(
  currentValue: Prisma.JsonValue | null | undefined,
  nextValue: Record<string, unknown>
) {
  const current = readJsonRecord(currentValue);
  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(nextValue)) {
    if (value === undefined) continue;

    const existing = merged[key];

    if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = [...new Set([...existing, ...value])];
      continue;
    }

    if (
      existing &&
      value &&
      typeof existing === "object" &&
      typeof value === "object" &&
      !Array.isArray(existing) &&
      !Array.isArray(value)
    ) {
      merged[key] = {
        ...(existing as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
      continue;
    }

    merged[key] = value;
  }

  return merged as Prisma.InputJsonValue;
}

function computePollAdmissionBudgetMs(
  maxWallClockMs: number = COMPANY_SOURCE_POLL_QUEUE_WALL_CLOCK_MS
) {
  return Math.max(
    COMPANY_SOURCE_POLL_MIN_REMAINING_BUDGET_MS * 2,
    Math.floor(maxWallClockMs * COMPANY_SOURCE_POLL_ADMISSION_BUDGET_RATIO)
  );
}

function computePollSoftStopMs(
  maxWallClockMs: number = COMPANY_SOURCE_POLL_QUEUE_WALL_CLOCK_MS
) {
  return Math.max(
    COMPANY_SOURCE_POLL_MIN_REMAINING_BUDGET_MS * 2,
    Math.floor(maxWallClockMs * COMPANY_SOURCE_POLL_SOFT_STOP_RATIO)
  );
}

function getWorkdayHostKey(input: {
  connectorName: string;
  token: string;
  boardUrl: string;
}) {
  if (input.connectorName !== "workday") return null;

  const tokenHost = input.token.split("|")[0]?.trim().toLowerCase();
  if (tokenHost) return tokenHost;

  try {
    return new URL(input.boardUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getAveragePollRuntimeMs(metadataJson: Prisma.JsonValue | null | undefined) {
  const metadata = readJsonRecord(metadataJson);
  const pollRuntime = readJsonRecord(metadata.pollRuntime as Prisma.JsonValue | undefined);
  const avgMs = readNumberValue(pollRuntime.avgMs);
  if (avgMs != null) {
    return avgMs;
  }

  const lastSummary = readJsonRecord(metadata.lastSummary as Prisma.JsonValue | undefined);
  return readNumberValue(lastSummary.runtimeMs);
}

function estimateSourcePollRuntimeMs(input: {
  connectorName: string;
  sourceType: string | null;
  metadataJson: Prisma.JsonValue | null | undefined;
  pollAttemptCount: number;
  consecutiveFailures: number;
  hostMetrics?: WorkdayHostMetrics | null;
}) {
  const runtimeFromMetadata = getAveragePollRuntimeMs(input.metadataJson);
  const connectorBaseline =
    DEFAULT_CONNECTOR_POLL_RUNTIME_MS[input.connectorName] ?? 28_000;

  let estimateMs = runtimeFromMetadata ?? connectorBaseline;

  if (input.sourceType === "COMPANY_HTML") {
    estimateMs *= 1.35;
  } else if (input.sourceType === "COMPANY_JSON") {
    estimateMs *= 1.1;
  }

  if (input.pollAttemptCount === 0) {
    estimateMs *= 1.15;
  }

  if (input.consecutiveFailures > 0) {
    estimateMs *= 1 + Math.min(0.35, input.consecutiveFailures * 0.08);
  }

  if (input.connectorName === "workday" && input.hostMetrics?.avgRuntimeMs) {
    estimateMs = Math.max(estimateMs, input.hostMetrics.avgRuntimeMs);
  }

  return Math.round(
    clampScore(
      estimateMs,
      8_000,
      COMPANY_SOURCE_POLL_MAX_RUNTIME_MS
    )
  );
}

function computeBlockedRisk(input: {
  connectorName: string;
  pollState: string;
  consecutiveFailures: number;
  lastHttpStatus: number | null;
  hostMetrics?: WorkdayHostMetrics | null;
}) {
  let blockedRisk = 0;

  if (input.pollState === "BACKOFF") {
    blockedRisk += 0.2;
  }

  if (input.consecutiveFailures > 0) {
    blockedRisk += Math.min(0.45, input.consecutiveFailures * 0.1);
  }

  if (input.lastHttpStatus && WORKDAY_BLOCKED_HTTP_STATUSES.has(input.lastHttpStatus)) {
    blockedRisk += 0.3;
  }

  if (input.connectorName === "workday") {
    blockedRisk += 0.15;

    if (input.hostMetrics?.blockedSourceCount) {
      blockedRisk += Math.min(0.45, input.hostMetrics.blockedSourceCount * 0.12);
    }

    if (input.hostMetrics?.blockedStreak) {
      blockedRisk += Math.min(0.35, input.hostMetrics.blockedStreak * 0.08);
    }

    if (input.hostMetrics?.cooldownUntil) {
      blockedRisk = 1.5;
    }
  }

  return clampScore(blockedRisk, 0, 1.5);
}

function computeExpectedAcceptedJobs(input: {
  connectorName: string;
  sourceQualityScore: number;
  yieldScore: number;
  pollAttemptCount: number;
  pollSuccessCount: number;
  jobsAcceptedCount: number;
  jobsCreatedCount: number;
  lastJobsAcceptedCount: number;
  lastJobsCreatedCount: number;
  retainedLiveJobCount: number;
}) {
  const acceptedPerSuccessfulPoll =
    input.pollSuccessCount > 0 ? input.jobsAcceptedCount / input.pollSuccessCount : 0;
  const createdPerSuccessfulPoll =
    input.pollSuccessCount > 0 ? input.jobsCreatedCount / input.pollSuccessCount : 0;
  const bootstrapExpectation =
    input.pollAttemptCount === 0
      ? TIER_1_POLL_CONNECTORS.has(input.connectorName) ||
        TIER_1_CONDITIONAL_CONNECTORS.has(input.connectorName)
        ? 4
        : 1.5
      : 0;

  return Math.max(
    bootstrapExpectation,
    input.lastJobsAcceptedCount * 0.7 +
      input.lastJobsCreatedCount * 2.5 +
      acceptedPerSuccessfulPoll * 0.45 +
      createdPerSuccessfulPoll * 3.5 +
      input.retainedLiveJobCount * 0.1 +
      input.sourceQualityScore * 10 +
      input.yieldScore * 18
  );
}

function classifyPollTier(input: {
  connectorName: string;
  sourceType: string | null;
  pollAttemptCount: number;
  pollSuccessCount: number;
  retainedLiveJobCount: number;
  blockedRisk: number;
  workdayTier: ReturnType<typeof getWorkdayTier> | null;
}) {
  if (input.connectorName === "workday") {
    return input.workdayTier === "A"
      ? "TIER_1"
      : input.workdayTier === "B"
        ? "TIER_2"
        : "TIER_3";
  }

  if (TIER_1_POLL_CONNECTORS.has(input.connectorName)) {
    return "TIER_1";
  }

  if (TIER_1_CONDITIONAL_CONNECTORS.has(input.connectorName)) {
    return input.pollSuccessCount > 0 || input.retainedLiveJobCount > 0
      ? "TIER_1"
      : "TIER_2";
  }

  if (input.blockedRisk >= 0.6) {
    return "TIER_3";
  }

  if (
    input.sourceType === "COMPANY_JSON" &&
    (input.pollSuccessCount > 0 || input.retainedLiveJobCount > 0)
  ) {
    return "TIER_2";
  }

  if (input.pollAttemptCount === 0) {
    return "TIER_3";
  }

  return input.retainedLiveJobCount > 0 || input.pollSuccessCount > 0
    ? "TIER_2"
    : "TIER_3";
}

function computePollEfficiencyScore(input: {
  basePriorityScore: number;
  estimatedRuntimeMs: number;
  expectedAcceptedJobs: number;
  blockedRisk: number;
  recentSuccessRate: number;
  retainedLiveJobCount: number;
}) {
  const score =
    input.expectedAcceptedJobs * 5 +
    input.retainedLiveJobCount * 0.2 +
    input.recentSuccessRate * 20 +
    input.basePriorityScore * 0.12 -
    input.blockedRisk * 30;

  return score / Math.max(input.estimatedRuntimeMs / 1000, 1);
}

function computeQueuePriorityScore(input: {
  tier: PollTier;
  efficiencyScore: number;
  basePriorityScore: number;
}) {
  const tierBoost =
    input.tier === "TIER_1" ? 4_000 : input.tier === "TIER_2" ? 2_500 : 1_000;

  return tierBoost + input.efficiencyScore * 100 + input.basePriorityScore;
}

async function buildWorkdayHostMetrics(now: Date) {
  const recentFailureCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentSuccessCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sources = await prisma.companySource.findMany({
    where: { connectorName: "workday" },
    select: {
      token: true,
      boardUrl: true,
      cooldownUntil: true,
      lastFailureAt: true,
      lastSuccessfulPollAt: true,
      lastHttpStatus: true,
      consecutiveFailures: true,
      metadataJson: true,
    },
  });

  const runtimeTotals = new Map<string, { totalMs: number; samples: number }>();
  const metrics = new Map<string, WorkdayHostMetrics>();

  for (const source of sources) {
    const host = getWorkdayHostKey({
      connectorName: "workday",
      token: source.token,
      boardUrl: source.boardUrl,
    });
    if (!host) continue;

    const entry = metrics.get(host) ?? {
      host,
      avgRuntimeMs: null,
      blockedSourceCount: 0,
      blockedStreak: 0,
      cooldownUntil: null,
      recentSuccessCount: 0,
    };

    if (
      source.lastFailureAt &&
      source.lastFailureAt >= recentFailureCutoff &&
      source.lastHttpStatus &&
      WORKDAY_BLOCKED_HTTP_STATUSES.has(source.lastHttpStatus)
    ) {
      entry.blockedSourceCount += 1;
      entry.blockedStreak = Math.max(entry.blockedStreak, source.consecutiveFailures);
    }

    if (source.lastSuccessfulPollAt && source.lastSuccessfulPollAt >= recentSuccessCutoff) {
      entry.recentSuccessCount += 1;
    }

    if (source.cooldownUntil && source.cooldownUntil > now) {
      entry.cooldownUntil =
        entry.cooldownUntil && entry.cooldownUntil > source.cooldownUntil
          ? entry.cooldownUntil
          : source.cooldownUntil;
    }

    const avgRuntimeMs = getAveragePollRuntimeMs(source.metadataJson);
    if (avgRuntimeMs != null) {
      const existing = runtimeTotals.get(host) ?? { totalMs: 0, samples: 0 };
      existing.totalMs += avgRuntimeMs;
      existing.samples += 1;
      runtimeTotals.set(host, existing);
    }

    metrics.set(host, entry);
  }

  for (const [host, totals] of runtimeTotals.entries()) {
    const entry = metrics.get(host);
    if (!entry || totals.samples === 0) continue;
    entry.avgRuntimeMs = Math.round(totals.totalMs / totals.samples);
    metrics.set(host, entry);
  }

  return metrics;
}

function estimateClaimablePollTaskCountFromPreview(
  tasks: Array<{ payloadJson: Prisma.JsonValue | null }>,
  limit: number,
  remainingBudgetMs: number
) {
  if (limit <= 0 || tasks.length === 0 || remainingBudgetMs <= 0) {
    return 0;
  }

  let admitted = 0;
  let consumedMs = 0;

  for (const task of tasks) {
    if (admitted >= limit) break;

    const payload = readJsonRecord(task.payloadJson);
    const estimatedRuntimeMs = Math.round(
      clampScore(
        readNumberValue(payload.estimatedRuntimeMs) ??
          DEFAULT_CONNECTOR_POLL_RUNTIME_MS["company-site"],
        8_000,
        COMPANY_SOURCE_POLL_MAX_RUNTIME_MS
      )
    );

    if (consumedMs + estimatedRuntimeMs > remainingBudgetMs && admitted > 0) {
      break;
    }

    consumedMs += estimatedRuntimeMs;
    admitted += 1;
  }

  return admitted;
}

function resolveConnectorPollTimeoutMs(input: {
  connectorName: string;
  sourceType: string | null;
  maxRuntimeMs: number;
}) {
  const connectorKey =
    input.connectorName === "company-site"
      ? "company-site"
      : input.connectorName;
  const configured =
    HARD_CONNECTOR_POLL_TIMEOUT_MS[connectorKey] ??
    HARD_CONNECTOR_POLL_TIMEOUT_MS[input.sourceType ?? ""] ??
    90_000;

  return Math.max(
    15_000,
    Math.min(input.maxRuntimeMs, configured)
  );
}

export async function syncCompaniesFromJobs(options: { limit?: number } = {}) {
  const rows = await prisma.jobCanonical.findMany({
    where: {
      OR: [{ companyId: null }, { companyRecord: null }],
      companyKey: { not: "" },
      status: { in: ["LIVE", "AGING", "STALE"] },
    },
    select: {
      id: true,
      company: true,
      companyKey: true,
      applyUrl: true,
      sourceMappings: {
        where: { removedAt: null, isPrimary: true },
        select: { sourceUrl: true },
        take: 1,
      },
    },
    orderBy: [{ lastSeenAt: "desc" }],
    take: options.limit ?? 500,
  });

  let companyCount = 0;
  const companyIds = new Set<string>();

  for (const row of rows) {
    const company = await ensureCompanyRecord({
      companyName: row.company,
      companyKey: row.companyKey,
      urls: [row.applyUrl, row.sourceMappings[0]?.sourceUrl ?? null],
    });
    companyIds.add(company.id);
    companyCount += 1;
    await prisma.jobCanonical.update({
      where: { id: row.id },
      data: { companyId: company.id },
    });
    await assignCanonicalJobsToCompany(company.id, row.companyKey);
  }

  return {
    canonicalJobsLinked: companyCount,
    distinctCompaniesLinked: companyIds.size,
  };
}

export async function seedCompanyDiscoveryUniverse(options: {
  catalogLimit?: number;
  corpusLimit?: number;
  inventoryLimit?: number;
  existingAtsLimit?: number;
} = {}) {
  const catalogLimit = options.catalogLimit ?? DEFAULT_COMPANY_CATALOG_SEED_LIMIT;
  const corpusLimit = options.corpusLimit ?? DEFAULT_COMPANY_CORPUS_SEED_LIMIT;
  const inventoryLimit = options.inventoryLimit ?? DEFAULT_COMPANY_INVENTORY_SEED_LIMIT;
  const existingAtsLimit = options.existingAtsLimit ?? DEFAULT_EXISTING_ATS_SEED_LIMIT;

  const [inventorySeeded, reverseAtsSeeded] = await Promise.all([
    seedCompaniesFromCanonicalInventory({
      limit: inventoryLimit,
      includeHistorical: true,
    }),
    seedCompanySourcesFromExistingAts({
      limit: existingAtsLimit,
    }),
  ]);

  const seededCompanyKeys = new Set(
    (
      await prisma.company.findMany({
        select: { companyKey: true },
      })
    ).map((company) => company.companyKey)
  );

  let catalogSeeded = 0;
  for (const record of ENTERPRISE_DISCOVERY_COMPANIES.slice(0, catalogLimit)) {
    const companyKey = buildCompanyKey(record.name);
    if (!companyKey || seededCompanyKeys.has(companyKey)) continue;

    await ensureCompanyRecord({
      companyName: record.name,
      companyKey,
      urls: [...(record.seedPageUrls ?? []), ...(record.domains ?? []).map((domain) => `https://${domain}`)],
      careersUrl: record.seedPageUrls?.[0] ?? null,
      detectedAts: record.ats !== "unknown" ? record.ats : null,
      discoveryStatus: "PENDING",
      crawlStatus: "IDLE",
      discoveryConfidence:
        record.ats !== "unknown" ? 0.75 : (record.seedPageUrls?.length ?? 0) > 0 ? 0.55 : 0.35,
      metadataJson: {
        seedSource: "enterprise-catalog",
        ats: record.ats,
        searchTerms: record.searchTerms ?? [],
        tenants: record.tenants,
        domains: record.domains ?? [],
        seedPageUrls: record.seedPageUrls ?? [],
        wdVariants: record.wdVariants ?? [],
        wdSites: record.wdSites ?? [],
        sfHosts: record.sfHosts ?? [],
        sfPaths: record.sfPaths ?? [],
        sectors: record.sectors,
        canadaCities: record.canadaCities ?? [],
        remoteCanadaLikely: record.remoteCanadaLikely ?? false,
      },
    });
    seededCompanyKeys.add(companyKey);
    catalogSeeded += 1;
  }

  const corpus = await buildCompanyDiscoveryCorpus({
    limit: corpusLimit,
    minCanadaRelevantCount: 0,
    minTotalLiveCount: 1,
  });

  let corpusSeeded = 0;
  for (const entry of corpus) {
    if (seededCompanyKeys.has(entry.companyKey)) continue;

    const seedPageUrls = entry.record.seedPageUrls ?? [];
    await ensureCompanyRecord({
      companyName: entry.displayName,
      companyKey: entry.companyKey,
      urls: [...seedPageUrls, ...(entry.record.domains ?? []).map((domain) => `https://${domain}`)],
      careersUrl: seedPageUrls[0] ?? null,
      detectedAts: entry.record.ats !== "unknown" ? entry.record.ats : null,
      discoveryStatus: "PENDING",
      crawlStatus: "IDLE",
      discoveryConfidence: Math.min(0.9, Math.max(0.35, entry.score / 20)),
      metadataJson: {
        seedSource: "live-corpus",
        aliases: entry.aliases,
        totalLiveCount: entry.totalLiveCount,
        canadaRelevantCount: entry.canadaRelevantCount,
        canadaRemoteCount: entry.canadaRemoteCount,
        matchedCatalogName: entry.matchedCatalogName,
        ats: entry.record.ats,
        searchTerms: entry.record.searchTerms ?? [],
        tenants: entry.record.tenants,
        domains: entry.record.domains ?? [],
        seedPageUrls,
        wdVariants: entry.record.wdVariants ?? [],
        wdSites: entry.record.wdSites ?? [],
        sfHosts: entry.record.sfHosts ?? [],
        sfPaths: entry.record.sfPaths ?? [],
        sectors: entry.record.sectors,
      },
    });
    await assignCanonicalJobsToCompanyByKey(entry.companyKey);
    seededCompanyKeys.add(entry.companyKey);
    corpusSeeded += 1;
  }

  return {
    inventorySeeded: inventorySeeded.seededCount,
    reverseAtsCompanySeeded: reverseAtsSeeded.companySeededCount,
    reverseAtsSourceProvisioned: reverseAtsSeeded.sourceProvisionedCount,
    catalogSeeded,
    corpusSeeded,
    totalSeeded:
      inventorySeeded.seededCount +
      reverseAtsSeeded.companySeededCount +
      catalogSeeded +
      corpusSeeded,
  };
}

async function assignCanonicalJobsToCompanyByKey(companyKey: string) {
  const company = await prisma.company.findUnique({
    where: { companyKey },
    select: { id: true },
  });

  if (!company) return;
  await assignCanonicalJobsToCompany(company.id, companyKey);
}

export async function enqueueCompanyDiscoveryTasks(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const discoveryLimit = options.limit ?? DISCOVERY_TASK_LIMIT;
  await syncCompaniesFromJobs({ limit: discoveryLimit * 30 });
  await seedCompanyDiscoveryUniverse({
    inventoryLimit: Math.max(3_000, discoveryLimit * 100),
    existingAtsLimit: Math.max(750, discoveryLimit * 24),
    catalogLimit: Math.max(600, discoveryLimit * 14),
    corpusLimit: Math.max(3_500, discoveryLimit * 70),
  });

  const candidates = await prisma.company.findMany({
    where: {
      OR: [
        { discoveryStatus: { in: ["PENDING", "FAILED", "NEEDS_REVIEW"] } },
        { lastDiscoveryAt: null },
        { sources: { none: {} } },
      ],
    },
    include: {
      jobs: {
        where: { status: { in: ["LIVE", "AGING"] } },
        select: { id: true },
        take: 10,
      },
      sources: { select: { id: true } },
    },
    take: Math.max(
      (options.limit ?? DISCOVERY_TASK_LIMIT) * 6,
      options.limit ?? DISCOVERY_TASK_LIMIT
    ),
  });

  const companies = candidates
    .sort((left, right) => {
      const leftSeedSource = readSeedSource(left.metadataJson);
      const rightSeedSource = readSeedSource(right.metadataJson);
      const leftScore =
        (left.sources.length === 0 ? 50 : 0) +
        (left.detectedAts ? 40 : 0) +
        (left.careersUrl ? 18 : 0) +
        (leftSeedSource === "csv-job-board-seed" ? 22 : 0) +
        Math.round(left.discoveryConfidence * 20) +
        Math.min(30, left.jobs.length * 3) +
        (left.discoveryStatus === "FAILED" ? -20 : 0) +
        (left.lastDiscoveryAt ? 0 : 15);
      const rightScore =
        (right.sources.length === 0 ? 50 : 0) +
        (right.detectedAts ? 40 : 0) +
        (right.careersUrl ? 18 : 0) +
        (rightSeedSource === "csv-job-board-seed" ? 22 : 0) +
        Math.round(right.discoveryConfidence * 20) +
        Math.min(30, right.jobs.length * 3) +
        (right.discoveryStatus === "FAILED" ? -20 : 0) +
        (right.lastDiscoveryAt ? 0 : 15);

      if (rightScore !== leftScore) return rightScore - leftScore;
      return (right.updatedAt?.getTime?.() ?? 0) - (left.updatedAt?.getTime?.() ?? 0);
    })
    .slice(0, options.limit ?? DISCOVERY_TASK_LIMIT);

  for (const company of companies) {
    const seedSource = readSeedSource(company.metadataJson);
    const priorityScore =
      Math.min(40, company.jobs.length * 3) +
      (company.sources.length === 0 ? 30 : 0) +
      (company.careersUrl ? 12 : 0) +
      (seedSource === "csv-job-board-seed" ? 18 : 0) +
      (company.discoveryStatus === "FAILED" ? -10 : 15) +
      Math.max(0, 20 - Math.round(company.discoveryConfidence * 20));

    await enqueueUniqueSourceTask({
      kind: "COMPANY_DISCOVERY",
      companyId: company.id,
      priorityScore,
      notBeforeAt: now,
    });
  }

  return {
    enqueuedCount: companies.length,
    companyIds: companies.map((company) => company.id),
  };
}

export async function enqueueRediscoveryTasks(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const sources = await prisma.companySource.findMany({
    where: {
      OR: [
        { status: "REDISCOVER_REQUIRED" },
        { validationState: "NEEDS_REDISCOVERY" },
        { status: "DEGRADED", consecutiveFailures: { gte: REDISCOVERY_FAILURE_THRESHOLD } },
      ],
    },
    orderBy: [
      { consecutiveFailures: "desc" },
      { lastDiscoveryAt: "asc" },
      { priorityScore: "desc" },
    ],
    take: options.limit ?? REDISCOVERY_TASK_LIMIT,
  });

  for (const source of sources) {
    await enqueueUniqueSourceTask({
      kind: "REDISCOVERY",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore: 60 + source.consecutiveFailures * 5,
      notBeforeAt: now,
    });
  }

  return {
    enqueuedCount: sources.length,
    companySourceIds: sources.map((source) => source.id),
  };
}

export async function enqueueSourceValidationTasks(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const sources = await prisma.companySource.findMany({
    where: {
      status: { not: "DISABLED" },
      validationState: { in: ["UNVALIDATED", "SUSPECT", "NEEDS_REDISCOVERY", "BLOCKED"] },
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
    },
    include: {
      company: {
        select: {
          discoveryConfidence: true,
          jobs: {
            where: { status: { in: ["LIVE", "AGING"] } },
            select: { id: true },
            take: 25,
          },
        },
      },
    },
    orderBy: [
      { validationState: "asc" },
      { priorityScore: "desc" },
      { updatedAt: "asc" },
    ],
    take: options.limit ?? SOURCE_VALIDATION_TASK_LIMIT,
  });

  for (const source of sources) {
    const historicalYield = source.company.jobs.length;
    const priorityScore = computeValidationPriorityScore({
      priorityScore: source.priorityScore,
      sourceQualityScore: source.sourceQualityScore,
      yieldScore: source.yieldScore,
      discoveryConfidence: source.company.discoveryConfidence,
      historicalYield,
      validationState: source.validationState,
      consecutiveFailures: source.consecutiveFailures,
      validationAttemptCount: source.validationAttemptCount,
      validationSuccessCount: source.validationSuccessCount,
      sourceType: source.sourceType,
      parserVersion: source.parserVersion,
    });

    await enqueueUniqueSourceTask({
      kind: "SOURCE_VALIDATION",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore,
      notBeforeAt: now,
    });
  }

  return {
    enqueuedCount: sources.length,
    companySourceIds: sources.map((source) => source.id),
  };
}

export async function enqueueCompanySourcePollTasks(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const pollLimit = options.limit ?? COMPANY_SOURCE_POLL_LIMIT;
  const admissionBudgetMs = computePollAdmissionBudgetMs();
  const workdayHostMetrics = await buildWorkdayHostMetrics(now);
  const candidates = await prisma.companySource.findMany({
    where: {
      status: { in: ["PROVISIONED", "ACTIVE", "DEGRADED"] },
      validationState: "VALIDATED",
      pollState: { in: ["READY", "ACTIVE", "BACKOFF"] },
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
    },
    include: {
      company: {
        select: {
          id: true,
          discoveryConfidence: true,
          jobs: {
            where: { status: { in: ["LIVE", "AGING"] } },
            select: { id: true },
            take: 25,
          },
        },
      },
    },
    orderBy: [{ priorityScore: "desc" }, { lastSuccessfulPollAt: "asc" }],
    take: Math.max(pollLimit * 6, pollLimit + 600),
  });

  const scoredSources = candidates.map((source) => {
    const historicalYield = source.company.jobs.length;
    const basePriorityScore = computePollPriorityScore({
      connectorName: source.connectorName,
      priorityScore: source.priorityScore,
      sourceQualityScore: source.sourceQualityScore,
      yieldScore: source.yieldScore,
      discoveryConfidence: source.company.discoveryConfidence,
      historicalYield,
      status: source.status,
      consecutiveFailures: source.consecutiveFailures,
      pollAttemptCount: source.pollAttemptCount,
      pollSuccessCount: source.pollSuccessCount,
      jobsAcceptedCount: source.jobsAcceptedCount,
      jobsCreatedCount: source.jobsCreatedCount,
      lastJobsAcceptedCount: source.lastJobsAcceptedCount,
      lastJobsCreatedCount: source.lastJobsCreatedCount,
      retainedLiveJobCount: source.retainedLiveJobCount,
      sourceType: source.sourceType,
      parserVersion: source.parserVersion,
    });
    const workdayHost = getWorkdayHostKey({
      connectorName: source.connectorName,
      token: source.token,
      boardUrl: source.boardUrl,
    });
    const hostMetrics = workdayHost ? workdayHostMetrics.get(workdayHost) ?? null : null;

    const workdayValueScore =
      source.connectorName === "workday"
        ? computeWorkdayValueScore({
            pollAttemptCount: source.pollAttemptCount,
            pollSuccessCount: source.pollSuccessCount,
            jobsAcceptedCount: source.jobsAcceptedCount,
            retainedLiveJobCount: source.retainedLiveJobCount,
          })
        : null;
    const recentSuccessRate =
      source.pollAttemptCount > 0 ? source.pollSuccessCount / source.pollAttemptCount : 0;
    const estimatedRuntimeMs = estimateSourcePollRuntimeMs({
      connectorName: source.connectorName,
      sourceType: source.sourceType,
      metadataJson: source.metadataJson,
      pollAttemptCount: source.pollAttemptCount,
      consecutiveFailures: source.consecutiveFailures,
      hostMetrics,
    });
    const blockedRisk = computeBlockedRisk({
      connectorName: source.connectorName,
      pollState: source.pollState,
      consecutiveFailures: source.consecutiveFailures,
      lastHttpStatus: source.lastHttpStatus,
      hostMetrics,
    });
    const expectedAcceptedJobs = computeExpectedAcceptedJobs({
      connectorName: source.connectorName,
      sourceQualityScore: source.sourceQualityScore,
      yieldScore: source.yieldScore,
      pollAttemptCount: source.pollAttemptCount,
      pollSuccessCount: source.pollSuccessCount,
      jobsAcceptedCount: source.jobsAcceptedCount,
      jobsCreatedCount: source.jobsCreatedCount,
      lastJobsAcceptedCount: source.lastJobsAcceptedCount,
      lastJobsCreatedCount: source.lastJobsCreatedCount,
      retainedLiveJobCount: source.retainedLiveJobCount,
    });
    const workdayTier =
      workdayValueScore === null ? null : getWorkdayTier(workdayValueScore);
    const tier = classifyPollTier({
      connectorName: source.connectorName,
      sourceType: source.sourceType,
      pollAttemptCount: source.pollAttemptCount,
      pollSuccessCount: source.pollSuccessCount,
      retainedLiveJobCount: source.retainedLiveJobCount,
      blockedRisk,
      workdayTier,
    });
    const efficiencyScore = computePollEfficiencyScore({
      basePriorityScore,
      estimatedRuntimeMs,
      expectedAcceptedJobs,
      blockedRisk,
      recentSuccessRate,
      retainedLiveJobCount: source.retainedLiveJobCount,
    });
    const priorityScore = computeQueuePriorityScore({
      tier,
      efficiencyScore,
      basePriorityScore,
    });

    return {
      source,
      priorityScore,
      basePriorityScore,
      workdayValueScore,
      workdayTier,
      tier,
      workdayHost,
      hostMetrics,
      recentSuccessRate,
      estimatedRuntimeMs,
      expectedAcceptedJobs,
      blockedRisk,
      efficiencyScore,
    };
  }).filter(({ hostMetrics }) => !(hostMetrics?.cooldownUntil && hostMetrics.cooldownUntil > now));

  const orderedByTier = (tier: PollTier) =>
    pickBalancedPollSources(
      scoredSources.filter((candidate) => candidate.tier === tier),
      scoredSources.length,
      (left, right) => {
        if (right.efficiencyScore !== left.efficiencyScore) {
          return right.efficiencyScore - left.efficiencyScore;
        }

        return (
          (left.source.lastSuccessfulPollAt?.getTime() ?? 0) -
          (right.source.lastSuccessfulPollAt?.getTime() ?? 0)
        );
      }
    );

  const tierCandidates = {
    TIER_1: orderedByTier("TIER_1"),
    TIER_2: orderedByTier("TIER_2"),
    TIER_3: orderedByTier("TIER_3"),
  } satisfies Record<PollTier, typeof scoredSources>;

  const connectorCounts = new Map<string, number>();
  const selectedSources: typeof scoredSources = [];
  const selectedIds = new Set<string>();
  let carryBudgetMs = 0;

  const tierConfigs: Array<{ tier: PollTier; budgetRatio: number }> = [
    { tier: "TIER_1", budgetRatio: COMPANY_SOURCE_POLL_TIER_1_BUDGET_RATIO },
    { tier: "TIER_2", budgetRatio: COMPANY_SOURCE_POLL_TIER_2_BUDGET_RATIO },
    { tier: "TIER_3", budgetRatio: COMPANY_SOURCE_POLL_TIER_3_BUDGET_RATIO },
  ];

  for (const { tier, budgetRatio } of tierConfigs) {
    const candidatesForTier = tierCandidates[tier];
    const tierBudgetMs = Math.round(admissionBudgetMs * budgetRatio) + carryBudgetMs;
    let tierUsedMs = 0;

    for (const candidate of candidatesForTier) {
      if (selectedSources.length >= pollLimit) break;
      if (selectedIds.has(candidate.source.id)) continue;

      const connectorCap = CONNECTOR_POLL_CYCLE_CAPS[candidate.source.connectorName];
      const currentConnectorCount = connectorCounts.get(candidate.source.connectorName) ?? 0;
      if (typeof connectorCap === "number" && currentConnectorCount >= connectorCap) {
        continue;
      }

      const projectedMs = tierUsedMs + candidate.estimatedRuntimeMs;
      if (projectedMs > tierBudgetMs && tierUsedMs > 0) {
        continue;
      }

      selectedSources.push(candidate);
      selectedIds.add(candidate.source.id);
      connectorCounts.set(candidate.source.connectorName, currentConnectorCount + 1);
      tierUsedMs = projectedMs;
    }

    carryBudgetMs = Math.max(0, tierBudgetMs - tierUsedMs);
  }

  const remainingCandidates = [...scoredSources]
    .filter((candidate) => !selectedIds.has(candidate.source.id))
    .sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }

      return right.efficiencyScore - left.efficiencyScore;
    });

  let totalSelectedRuntimeMs = selectedSources.reduce(
    (sum, candidate) => sum + candidate.estimatedRuntimeMs,
    0
  );

  for (const candidate of remainingCandidates) {
    if (selectedSources.length >= pollLimit) break;
    if (totalSelectedRuntimeMs + candidate.estimatedRuntimeMs > admissionBudgetMs) break;

    const connectorCap = CONNECTOR_POLL_CYCLE_CAPS[candidate.source.connectorName];
    const currentConnectorCount = connectorCounts.get(candidate.source.connectorName) ?? 0;
    if (typeof connectorCap === "number" && currentConnectorCount >= connectorCap) {
      continue;
    }

    selectedSources.push(candidate);
    selectedIds.add(candidate.source.id);
    connectorCounts.set(candidate.source.connectorName, currentConnectorCount + 1);
    totalSelectedRuntimeMs += candidate.estimatedRuntimeMs;
  }

  const deferredTier2SourceIds = scoredSources
    .filter((candidate) => candidate.tier === "TIER_2" && !selectedIds.has(candidate.source.id))
    .map((candidate) => candidate.source.id);
  const deferredTier3SourceIds = scoredSources
    .filter((candidate) => candidate.tier === "TIER_3" && !selectedIds.has(candidate.source.id))
    .map((candidate) => candidate.source.id);

  if (deferredTier2SourceIds.length > 0) {
    await prisma.sourceTask.updateMany({
      where: {
        kind: "CONNECTOR_POLL",
        status: "PENDING",
        notBeforeAt: { lte: now },
        companySourceId: { in: deferredTier2SourceIds },
      },
      data: {
        notBeforeAt: new Date(
          now.getTime() + COMPANY_SOURCE_POLL_DEFER_TIER_2_MINUTES * 60 * 1000
        ),
      },
    });
  }

  if (deferredTier3SourceIds.length > 0) {
    await prisma.sourceTask.updateMany({
      where: {
        kind: "CONNECTOR_POLL",
        status: "PENDING",
        notBeforeAt: { lte: now },
        companySourceId: { in: deferredTier3SourceIds },
      },
      data: {
        notBeforeAt: new Date(
          now.getTime() + COMPANY_SOURCE_POLL_DEFER_TIER_3_MINUTES * 60 * 1000
        ),
      },
    });
  }

  for (const candidate of selectedSources) {
    await enqueueUniqueSourceTask({
      kind: "CONNECTOR_POLL",
      companyId: candidate.source.companyId,
      companySourceId: candidate.source.id,
      priorityScore: candidate.priorityScore,
      notBeforeAt: now,
      payloadJson: {
        blockedRisk: Math.round(candidate.blockedRisk * 1000) / 1000,
        efficiencyScore: Math.round(candidate.efficiencyScore * 1000) / 1000,
        estimatedRuntimeMs: candidate.estimatedRuntimeMs,
        expectedAcceptedJobs:
          Math.round(candidate.expectedAcceptedJobs * 100) / 100,
        tier: candidate.tier,
        workdayHost: candidate.workdayHost,
        workdayTier: candidate.workdayTier,
      },
    });
  }

  return {
    enqueuedCount: selectedSources.length,
    companySourceIds: selectedSources.map(({ source }) => source.id),
  };
}

export async function runCompanyDiscoveryQueue(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const tasks = await claimSourceTasks("COMPANY_DISCOVERY", options.limit ?? DISCOVERY_TASK_LIMIT, now);
  return runDiscoveryTasks(tasks, now, false);
}

export async function runRediscoveryQueue(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const tasks = await claimSourceTasks("REDISCOVERY", options.limit ?? REDISCOVERY_TASK_LIMIT, now);
  return runDiscoveryTasks(tasks, now, true);
}

export async function runSourceValidationQueue(options: {
  limit?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const tasks = await claimSourceTasks(
    "SOURCE_VALIDATION",
    options.limit ?? SOURCE_VALIDATION_TASK_LIMIT,
    now
  );

  let successCount = 0;
  let failedCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor]!;
      cursor += 1;

      try {
        if (!task.companySourceId) {
          await finishSourceTask(task.id, "SKIPPED", {
            finishedAt: now,
            lastError: "No company source is attached to validation task.",
          });
          continue;
        }

        await runSourceValidation(task.companySourceId, now);
        successCount += 1;
        await finishSourceTask(task.id, "SUCCESS", { finishedAt: now });
      } catch (error) {
        failedCount += 1;
        await handleCompanySourceValidationFailure(task.companySourceId, now, error);
        await finishSourceTask(task.id, "FAILED", {
          lastError: error instanceof Error ? error.message : String(error),
          retryAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SOURCE_VALIDATION_QUEUE_CONCURRENCY, tasks.length) },
      () => worker()
    )
  );

  return {
    processedCount: tasks.length,
    successCount,
    failedCount,
  };
}

export async function runCompanySourcePollQueue(options: {
  limit?: number;
  now?: Date;
  maxWallClockMs?: number;
} = {}) {
  const maxTasks = options.limit ?? COMPANY_SOURCE_POLL_LIMIT;
  const maxWallClockMs = options.maxWallClockMs ?? COMPANY_SOURCE_POLL_QUEUE_WALL_CLOCK_MS;
  const softStopMs = computePollSoftStopMs(maxWallClockMs);
  const queueStart = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let processedCount = 0;
  let lastStaleRunRecoveryAt = 0;

  const recoverCompanySourceStaleRuns = async (recoveryNow: Date) => {
    const recovery = await recoverStaleRunningIngestionRuns({
      now: recoveryNow,
      companySourceOnly: true,
    });
    if (recovery.recoveredCount > 0) {
      console.log(
        `[sourcePollQueue] Recovered ${recovery.recoveredCount} stale company-source ingestion run(s): ${recovery.connectorKeys.join(", ")}`
      );
    }
    lastStaleRunRecoveryAt = Date.now();
  };

  await recoverCompanySourceStaleRuns(options.now ?? new Date());

  while (processedCount < maxTasks) {
    const elapsed = Date.now() - queueStart;
    if (Date.now() - lastStaleRunRecoveryAt >= COMPANY_SOURCE_STALE_RUN_RECOVERY_INTERVAL_MS) {
      await recoverCompanySourceStaleRuns(new Date());
    }
    const remainingWallClockMs = maxWallClockMs - elapsed;
    if (remainingWallClockMs <= COMPANY_SOURCE_POLL_MIN_REMAINING_BUDGET_MS) {
      console.log(
        `[sourcePollQueue] Wall-clock cap reached (${Math.round(elapsed / 1000)}s / ${Math.round(maxWallClockMs / 1000)}s) — stopping after ${processedCount} tasks`
      );
      break;
    }
    if (elapsed >= softStopMs) {
      console.log(
        `[sourcePollQueue] Soft stop reached (${Math.round(elapsed / 1000)}s / ${Math.round(maxWallClockMs / 1000)}s) — stopping admissions after ${processedCount} tasks`
      );
      break;
    }

    const remaining = maxTasks - processedCount;
    const batchConcurrency =
      remainingWallClockMs <= COMPANY_SOURCE_POLL_END_STAGE_WINDOW_MS
        ? COMPANY_SOURCE_POLL_CRITICAL_TIME_CONCURRENCY
        : remainingWallClockMs <= COMPANY_SOURCE_POLL_LATE_STAGE_WINDOW_MS
          ? COMPANY_SOURCE_POLL_LOW_TIME_CONCURRENCY
          : COMPANY_SOURCE_POLL_CONCURRENCY;
    const effectiveRemainingMs = Math.max(
      0,
      remainingWallClockMs - COMPANY_SOURCE_POLL_BATCH_GRACE_MS
    );
    const batchRuntimeCeilingMs =
      remainingWallClockMs <= COMPANY_SOURCE_POLL_END_STAGE_WINDOW_MS
        ? Math.floor(effectiveRemainingMs * 0.5)
        : remainingWallClockMs <= COMPANY_SOURCE_POLL_LATE_STAGE_WINDOW_MS
          ? Math.floor(effectiveRemainingMs * 0.7)
          : effectiveRemainingMs;
    const batchRuntimeMs = Math.max(
      COMPANY_SOURCE_POLL_MIN_REMAINING_BUDGET_MS,
      Math.min(
        COMPANY_SOURCE_POLL_MAX_RUNTIME_MS,
        batchRuntimeCeilingMs
      )
    );
    const batchNow = new Date();
    const previewTasks = await prisma.sourceTask.findMany({
      where: {
        kind: "CONNECTOR_POLL",
        status: "PENDING",
        notBeforeAt: { lte: batchNow },
      },
      orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
      take: Math.max(
        Math.min(batchConcurrency, remaining) * COMPANY_SOURCE_POLL_PREVIEW_MULTIPLIER,
        Math.min(batchConcurrency, remaining)
      ),
      select: {
        payloadJson: true,
      },
    });
    const claimLimit = estimateClaimablePollTaskCountFromPreview(
      previewTasks,
      Math.min(batchConcurrency, remaining),
      Math.max(0, effectiveRemainingMs)
    );

    if (claimLimit === 0) {
      console.log(
        `[sourcePollQueue] Remaining budget too small to admit another poll batch (${Math.round(remainingWallClockMs / 1000)}s left) — stopping after ${processedCount} tasks`
      );
      break;
    }

    const tasks = await claimSourceTasks(
      "CONNECTOR_POLL",
      claimLimit,
      batchNow
    );

    if (tasks.length === 0) {
      break;
    }

    let cursor = 0;

    async function worker() {
      while (cursor < tasks.length) {
        const task = tasks[cursor]!;
        cursor += 1;

        try {
          if (!task.companySourceId) {
            await finishSourceTask(task.id, "SKIPPED", {
              finishedAt: new Date(),
              lastError: "No company source is attached to connector poll task.",
            });
            continue;
          }

          const taskStartedAt = new Date();
          await pollCompanySource(task.companySourceId, taskStartedAt, batchRuntimeMs);
          successCount += 1;
          await finishSourceTask(task.id, "SUCCESS", { finishedAt: new Date() });
        } catch (error) {
          failedCount += 1;
          const taskFailedAt = new Date();
          const cooldownUntil = await handleCompanySourcePollFailure(
            task.companySourceId,
            taskFailedAt,
            error
          );
          await finishSourceTask(task.id, "FAILED", {
            lastError: error instanceof Error ? error.message : String(error),
            retryAt: cooldownUntil ?? new Date(taskFailedAt.getTime() + 60 * 60 * 1000),
          });
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(batchConcurrency, tasks.length) },
        () => worker()
      )
    );

    processedCount += tasks.length;
  }

  return {
    processedCount,
    successCount,
    failedCount,
  };
}

async function runDiscoveryTasks(tasks: SourceTask[], now: Date, isRediscovery: boolean) {
  let successCount = 0;
  let failedCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor]!;
      cursor += 1;

      try {
        if (!task.companyId) {
          await finishSourceTask(task.id, "SKIPPED", {
            finishedAt: now,
            lastError: "No company attached to discovery task.",
          });
          continue;
        }

        await discoverCompanySurface(task.companyId, now, isRediscovery);
        successCount += 1;
        await finishSourceTask(task.id, "SUCCESS", { finishedAt: now });
      } catch (error) {
        failedCount += 1;
        await finishSourceTask(task.id, "FAILED", {
          lastError: error instanceof Error ? error.message : String(error),
          retryAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DISCOVERY_QUEUE_CONCURRENCY, tasks.length) },
      () => worker()
    )
  );

  return {
    processedCount: tasks.length,
    successCount,
    failedCount,
  };
}

async function discoverCompanySurface(
  companyId: string,
  now: Date,
  isRediscovery: boolean
) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      sources: true,
      discoveryPages: true,
    },
  });

  if (!company) {
    throw new Error(`Company ${companyId} not found for discovery.`);
  }

  await prisma.company.update({
    where: { id: company.id },
    data: {
      discoveryStatus: "DISCOVERING",
      crawlStatus: "ACTIVE",
      lastDiscoveryAt: now,
      lastRediscoveryAt: isRediscovery ? now : company.lastRediscoveryAt,
      lastDiscoveryError: null,
    },
  });

  const knownStatuses = new Map<string, "pending" | "rejected" | "promoted">();
  for (const source of company.sources) {
    const status =
      source.status === "DISABLED"
        ? "rejected"
        : source.status === "ACTIVE"
          ? "promoted"
          : "pending";
    knownStatuses.set(source.sourceName.toLowerCase(), status);
  }

  const record = buildEnterpriseRecordForCompany(company);
  const discovery = await discoverEnterpriseCareerPageCandidates({
    companies: [record],
    knownStatuses,
  });

  let discoveredSourceCount = 0;
  let atsSourceName: string | null = null;

  for (const candidate of discovery.records) {
    await persistAtsCandidate(
      company.id,
      {
        ...candidate,
        sourceName: buildDiscoveredSourceName(
          candidate.connectorName as DiscoveredSourceCandidate["connectorName"],
          candidate.token
        ),
      },
      now
    );
    discoveredSourceCount += 1;
    atsSourceName = atsSourceName ?? candidate.connectorName;
  }

  const candidatePages = new Set<string>();
  if (company.careersUrl) candidatePages.add(company.careersUrl);
  if (company.domain) {
    candidatePages.add(`https://${company.domain}/careers`);
    candidatePages.add(`https://${company.domain}/jobs`);
  }

  for (const recordCandidate of discovery.records) {
    for (const careerPageUrl of recordCandidate.careerPageUrls) {
      candidatePages.add(careerPageUrl);
    }
  }

  let bestCustomRoute: {
    url: string;
    extractionRoute: ExtractionRouteKind;
    parserVersion: string;
    confidence: number;
    metadata: Record<string, Prisma.InputJsonValue | null>;
  } | null = null;

  const seedSource = readSeedSource(company.metadataJson);
  const orderedCandidatePages = prioritizeCareerPageUrls([...candidatePages]);
  const inspectionLimit =
    seedSource === "csv-job-board-seed"
      ? Math.min(MAX_CAREER_PAGE_INSPECTIONS_CSV_IMPORT, orderedCandidatePages.length)
      : Math.min(MAX_CAREER_PAGE_INSPECTIONS, orderedCandidatePages.length);

  for (const pageUrl of orderedCandidatePages.slice(0, inspectionLimit)) {
    try {
      const inspection = await inspectCompanySiteRoute(pageUrl);
      await prisma.companyDiscoveryPage.upsert({
        where: {
          companyId_url: {
            companyId: company.id,
            url: inspection.finalUrl,
          },
        },
        create: {
          companyId: company.id,
          url: inspection.finalUrl,
          confidence: inspection.confidence,
          isChosen: false,
          extractorRoute: inspection.extractionRoute,
          parserVersion: inspection.parserVersion,
          lastCheckedAt: now,
          metadataJson: inspection.metadata as Prisma.InputJsonValue,
        },
        update: {
          confidence: inspection.confidence,
          extractorRoute: inspection.extractionRoute,
          parserVersion: inspection.parserVersion,
          lastCheckedAt: now,
          lastError: null,
          metadataJson: inspection.metadata as Prisma.InputJsonValue,
        },
      });

      if (
        inspection.extractionRoute !== "UNKNOWN" &&
        (!bestCustomRoute || inspection.confidence > bestCustomRoute.confidence)
      ) {
        bestCustomRoute = {
          url: inspection.finalUrl,
          extractionRoute: inspection.extractionRoute,
          parserVersion: inspection.parserVersion,
          confidence: inspection.confidence,
          metadata: inspection.metadata,
        };
      }
    } catch (error) {
      await prisma.companyDiscoveryPage.upsert({
        where: {
          companyId_url: {
            companyId: company.id,
            url: pageUrl,
          },
        },
        create: {
          companyId: company.id,
          url: pageUrl,
          confidence: 0,
          isChosen: false,
          extractorRoute: "UNKNOWN",
          lastCheckedAt: now,
          failureCount: 1,
          lastError: error instanceof Error ? error.message : String(error),
        },
        update: {
          confidence: 0,
          extractorRoute: "UNKNOWN",
          lastCheckedAt: now,
          failureCount: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const fallbackRoute = bestCustomRoute ?? buildWeakFallbackRoute(company);

  let customSourceProvisioned = false;
  const shouldProvisionParallelCompanySite =
    seedSource === "csv-job-board-seed" &&
    bestCustomRoute !== null &&
    bestCustomRoute.extractionRoute !== "HTML_FALLBACK" &&
    bestCustomRoute.confidence >= 0.7 &&
    !isKnownAtsBoardUrl(bestCustomRoute.url);

  if (
    fallbackRoute &&
    (discoveredSourceCount === 0 || shouldProvisionParallelCompanySite)
  ) {
    await provisionCompanySiteSource(company.id, company.companyKey, fallbackRoute, now);
    customSourceProvisioned = true;
  }

  const nextStatus: CompanyDiscoveryStatus =
    discoveredSourceCount > 0 || customSourceProvisioned
      ? "DISCOVERED"
      : fallbackRoute
        ? "NEEDS_REVIEW"
        : "FAILED";

  await prisma.company.update({
    where: { id: company.id },
    data: {
      careersUrl: company.careersUrl ?? fallbackRoute?.url ?? null,
      detectedAts: atsSourceName,
      discoveryConfidence:
        fallbackRoute?.confidence ??
        (discoveredSourceCount > 0 ? 0.9 : company.discoveryConfidence),
      discoveryStatus: nextStatus,
      crawlStatus: nextStatus === "FAILED" ? "FAILED" : "IDLE",
      lastDiscoveryAt: now,
      lastSuccessfulPollAt:
        discoveredSourceCount > 0 || customSourceProvisioned
          ? company.lastSuccessfulPollAt
          : null,
      lastDiscoveryError:
        nextStatus === "FAILED" ? "No ATS or structured career surface was confirmed." : null,
    },
  });
}

async function persistAtsCandidate(
  companyId: string,
  candidate: {
    sourceName: string;
    connectorName: string;
    token: string;
    boardUrl: string;
    careerPageUrls: string[];
    directAtsUrls: string[];
    matchedReasons: string[];
  },
  now: Date
) {
  for (const pageUrl of candidate.careerPageUrls) {
    await prisma.companyDiscoveryPage.upsert({
      where: {
        companyId_url: {
          companyId,
          url: pageUrl,
        },
      },
      create: {
        companyId,
        url: pageUrl,
        confidence: 0.92,
        isChosen: true,
        extractorRoute: "ATS_NATIVE",
        parserVersion: "ats-native:v1",
        lastCheckedAt: now,
        metadataJson: {
          matchedReasons: candidate.matchedReasons,
          directAtsUrls: candidate.directAtsUrls,
        } as Prisma.InputJsonValue,
      },
      update: {
        confidence: 0.92,
        isChosen: true,
        extractorRoute: "ATS_NATIVE",
        parserVersion: "ats-native:v1",
        lastCheckedAt: now,
        lastError: null,
        metadataJson: {
          matchedReasons: candidate.matchedReasons,
          directAtsUrls: candidate.directAtsUrls,
        } as Prisma.InputJsonValue,
      },
    });
  }

  const companySource = await prisma.companySource.upsert({
    where: { sourceName: candidate.sourceName },
    create: {
      companyId,
      sourceName: candidate.sourceName,
      connectorName: candidate.connectorName,
      token: candidate.token,
      boardUrl: candidate.boardUrl,
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType: "ATS",
      extractionRoute: "ATS_NATIVE",
      parserVersion: "ats-native:v1",
      pollingCadenceMinutes: DEFAULT_SOURCE_POLL_CADENCE_MINUTES,
      priorityScore: 0.95,
      sourceQualityScore: 0.8,
      yieldScore: 0.56,
      firstSeenAt: now,
      lastProvisionedAt: now,
      lastDiscoveryAt: now,
      metadataJson: {
        matchedReasons: candidate.matchedReasons,
        careerPageUrls: candidate.careerPageUrls,
        directAtsUrls: candidate.directAtsUrls,
      } as Prisma.InputJsonValue,
    },
    update: {
      companyId,
      boardUrl: candidate.boardUrl,
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType: "ATS",
      extractionRoute: "ATS_NATIVE",
      parserVersion: "ats-native:v1",
      priorityScore: Math.max(0.95, 0.9),
      sourceQualityScore: Math.max(0.8, 0.75),
      yieldScore: Math.max(0.56, 0.75 * 0.7),
      lastProvisionedAt: now,
      lastDiscoveryAt: now,
      lastValidatedAt: null,
      lastHttpStatus: null,
      consecutiveFailures: 0,
      failureStreak: 0,
      validationMessage: null,
      metadataJson: {
        matchedReasons: candidate.matchedReasons,
        careerPageUrls: candidate.careerPageUrls,
        directAtsUrls: candidate.directAtsUrls,
      } as Prisma.InputJsonValue,
    },
  });

  await enqueueUniqueSourceTask({
    kind: "SOURCE_VALIDATION",
    companyId,
    companySourceId: companySource.id,
    priorityScore: 95,
    notBeforeAt: now,
  });
}

async function provisionCompanySiteSource(
  companyId: string,
  companyKey: string,
  route: {
    url: string;
    extractionRoute: ExtractionRouteKind;
    parserVersion: string;
    confidence: number;
    metadata: Record<string, Prisma.InputJsonValue | null>;
  },
  now: Date
) {
  const sourceName =
    route.extractionRoute === "STRUCTURED_JSON" ||
    route.extractionRoute === "STRUCTURED_API" ||
    route.extractionRoute === "STRUCTURED_SITEMAP"
      ? `CompanyJson:${companyKey}`
      : `CompanyHtml:${companyKey}`;

  const companySource = await prisma.companySource.upsert({
    where: { sourceName },
    create: {
      companyId,
      sourceName,
      connectorName: "company-site",
      token: companyKey,
      boardUrl: route.url,
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType:
        route.extractionRoute === "HTML_FALLBACK" ? "COMPANY_HTML" : "COMPANY_JSON",
      extractionRoute: route.extractionRoute,
      parserVersion: route.parserVersion,
      pollingCadenceMinutes:
        route.extractionRoute === "HTML_FALLBACK" ? 720 : DEFAULT_SOURCE_POLL_CADENCE_MINUTES,
      priorityScore: route.confidence,
      sourceQualityScore: Math.max(0.18, route.confidence),
      yieldScore: Math.max(0.08, Math.max(0.18, route.confidence) * 0.55),
      firstSeenAt: now,
      lastProvisionedAt: now,
      lastDiscoveryAt: now,
      metadataJson: route.metadata as Prisma.InputJsonValue,
    },
    update: {
      companyId,
      boardUrl: route.url,
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType:
        route.extractionRoute === "HTML_FALLBACK" ? "COMPANY_HTML" : "COMPANY_JSON",
      extractionRoute: route.extractionRoute,
      parserVersion: route.parserVersion,
      pollingCadenceMinutes:
        route.extractionRoute === "HTML_FALLBACK" ? 720 : DEFAULT_SOURCE_POLL_CADENCE_MINUTES,
      priorityScore: route.confidence,
      sourceQualityScore: Math.max(0.18, route.confidence),
      yieldScore: Math.max(0.08, Math.max(0.18, route.confidence) * 0.55),
      lastProvisionedAt: now,
      lastDiscoveryAt: now,
      lastValidatedAt: null,
      lastHttpStatus: null,
      consecutiveFailures: 0,
      failureStreak: 0,
      validationMessage: null,
      metadataJson: route.metadata as Prisma.InputJsonValue,
    },
  });

  await prisma.companyDiscoveryPage.updateMany({
    where: { companyId },
    data: { isChosen: false },
  });
  await prisma.companyDiscoveryPage.updateMany({
    where: { companyId, url: route.url },
    data: { isChosen: true },
  });

  await enqueueUniqueSourceTask({
    kind: "SOURCE_VALIDATION",
    companyId,
    companySourceId: companySource.id,
    priorityScore: Math.round(route.confidence * 100),
    notBeforeAt: now,
  });
}

function buildWeakFallbackRoute(company: {
  domain: string | null;
  careersUrl: string | null;
  discoveryPages: Array<{ url: string; confidence: number; extractorRoute: ExtractionRouteKind }>;
}) {
  const chosenPage =
    company.discoveryPages
      .filter((page) => page.extractorRoute !== "UNKNOWN")
      .sort((left, right) => right.confidence - left.confidence)[0] ??
    company.discoveryPages
      .sort((left, right) => right.confidence - left.confidence)[0] ??
    null;

  const url =
    company.careersUrl ??
    chosenPage?.url ??
    (company.domain ? `https://${company.domain}/careers` : null) ??
    (company.domain ? `https://${company.domain}/jobs` : null);

  if (!url) return null;

  return {
    url,
    extractionRoute: "HTML_FALLBACK" as const,
    parserVersion: "company-site:fallback-v2",
    confidence: Math.max(0.18, chosenPage?.confidence ?? 0.18),
    metadata: {
      reason: "weak-discovery-fallback",
      chosenPageUrl: chosenPage?.url ?? null,
      chosenPageConfidence: chosenPage?.confidence ?? null,
    } satisfies Record<string, Prisma.InputJsonValue | null>,
  };
}

function prioritizeCareerPageUrls(urls: string[]) {
  return [...urls].sort((left, right) => scoreCareerPageUrl(right) - scoreCareerPageUrl(left));
}

function scoreCareerPageUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      (isKnownAtsHost(host) ? -20 : 25) +
      (/\/careers?|\/jobs?|\/join|\/work/.test(path) ? 20 : 0) +
      (/\/job\/|\/jobs\/[^/]+/.test(path) ? 6 : 0) +
      (path === "/" ? -8 : 0)
    );
  } catch {
    return 0;
  }
}

function isKnownAtsBoardUrl(url: string) {
  try {
    return isKnownAtsHost(new URL(url).hostname.replace(/^www\./i, "").toLowerCase());
  } catch {
    return false;
  }
}

async function runSourceValidation(companySourceId: string, now: Date) {
  const source = await prisma.companySource.findUnique({
    where: { id: companySourceId },
    include: { company: { select: { id: true, name: true } } },
  });

  if (!source) {
    throw new Error(`Company source ${companySourceId} not found.`);
  }

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      validationState: "VALIDATING",
      validationMessage: null,
    },
  });

  const result = await validateCompanySource(source, now);
  const nextFailureCount =
    result.kind === "VALIDATED" ? 0 : source.consecutiveFailures + 1;
  const nextValidationAttemptCount = source.validationAttemptCount + 1;
  const nextValidationSuccessCount =
    source.validationSuccessCount + (result.kind === "VALIDATED" ? 1 : 0);
  const nextStatus =
    result.kind === "VALIDATED"
      ? source.lastSuccessfulPollAt
        ? "ACTIVE"
        : "PROVISIONED"
      : result.kind === "INVALID" || result.kind === "NEEDS_REDISCOVERY"
        ? "REDISCOVER_REQUIRED"
        : "DEGRADED";

  const nextYieldScore = computeSourceYieldScore({
    sourceQualityScore: result.sourceQualityScore,
    pollAttemptCount: source.pollAttemptCount,
    pollSuccessCount: source.pollSuccessCount,
    jobsFetchedCount: source.jobsFetchedCount,
    jobsAcceptedCount: source.jobsAcceptedCount,
    jobsCreatedCount: source.jobsCreatedCount,
    retainedLiveJobCount: source.retainedLiveJobCount,
    overlapRatio: source.overlapRatio,
  });

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      status: nextStatus,
      validationState: result.validationState,
      pollState: result.pollState,
      lastValidatedAt: now,
      lastFailureAt: result.kind === "VALIDATED" ? null : now,
      lastHttpStatus: result.httpStatus,
      cooldownUntil:
        result.recommendedCooldownMinutes > 0
          ? new Date(now.getTime() + result.recommendedCooldownMinutes * 60 * 1000)
          : null,
      validationAttemptCount: nextValidationAttemptCount,
      validationSuccessCount: nextValidationSuccessCount,
      consecutiveFailures: nextFailureCount,
      failureStreak: nextFailureCount,
      sourceQualityScore: result.sourceQualityScore,
      yieldScore: nextYieldScore,
      validationMessage: result.message,
    },
  });

  const companyUpdateData: Prisma.CompanyUpdateInput = {
    crawlStatus:
      result.kind === "VALIDATED"
        ? "IDLE"
        : result.kind === "BLOCKED"
          ? "BLOCKED"
          : result.kind === "INVALID" || result.kind === "NEEDS_REDISCOVERY"
            ? "DEGRADED"
            : "ACTIVE",
    lastDiscoveryError: result.kind === "VALIDATED" ? null : result.message,
  };

  if (result.kind === "VALIDATED") {
    companyUpdateData.discoveryStatus = "DISCOVERED";
  } else if (result.kind === "INVALID" || result.kind === "NEEDS_REDISCOVERY") {
    companyUpdateData.discoveryStatus = "NEEDS_REVIEW";
  }

  await prisma.company.update({
    where: { id: source.companyId },
    data: companyUpdateData,
  });

  if (result.kind === "VALIDATED") {
    const shouldFastTrackPoll =
      result.jobsFound > 0 ||
      source.pollSuccessCount > 0 ||
      source.retainedLiveJobCount > 0;

    if (shouldFastTrackPoll) {
      await enqueueUniqueSourceTask({
        kind: "CONNECTOR_POLL",
        companyId: source.companyId,
        companySourceId: source.id,
        priorityScore: Math.max(70, Math.round(source.priorityScore * 100)),
        notBeforeAt: now,
      });
    }
    return;
  }

  if (
    result.kind === "INVALID" ||
    result.kind === "NEEDS_REDISCOVERY" ||
    (result.kind === "SUSPECT" && nextFailureCount >= HARD_FAILURE_REDISCOVERY_THRESHOLD)
  ) {
    await prisma.companySource.update({
      where: { id: source.id },
      data: {
        status: "REDISCOVER_REQUIRED",
        validationState:
          result.kind === "SUSPECT" ? "NEEDS_REDISCOVERY" : result.validationState,
        pollState: "QUARANTINED",
      },
    });

    await enqueueUniqueSourceTask({
      kind: "REDISCOVERY",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore: 90,
      notBeforeAt: now,
    });
  }
}

async function pollCompanySource(
  companySourceId: string,
  now: Date,
  maxRuntimeMs: number = COMPANY_SOURCE_POLL_MAX_RUNTIME_MS
) {
  const source = await prisma.companySource.findUnique({
    where: { id: companySourceId },
    include: { company: true },
  });

  if (!source) {
    throw new Error(`Company source ${companySourceId} not found.`);
  }

  if (source.validationState !== "VALIDATED" || source.pollState === "QUARANTINED") {
    throw new Error(
      `Company source ${source.sourceName} is not eligible for active polling (${source.validationState}/${source.pollState}).`
    );
  }

  const effectiveMaxRuntimeMs = resolveConnectorPollTimeoutMs({
    connectorName: source.connectorName,
    sourceType: source.sourceType,
    maxRuntimeMs,
  });

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      pollState: "ACTIVE",
    },
  });

  const connector = buildConnectorForCompanySource(source);
  const staleRunRecovery = await recoverStaleRunningIngestionRuns({
    now,
    connectorKeys: [connector.key],
  });
  if (staleRunRecovery.recoveredCount > 0) {
    console.log(
      `[companySourcePoll] Recovered ${staleRunRecovery.recoveredCount} stale RUNNING ingestion run(s) for ${connector.key}`
    );
  }
  const summary = await ingestConnector(connector, {
    now,
    runMode: "SCHEDULED",
    maxRuntimeMs: effectiveMaxRuntimeMs,
    triggerLabel: `company-source:${source.id}`,
    scheduleCadenceMinutes: source.pollingCadenceMinutes,
    runMetadata: {
      origin: "company_source",
      companyId: source.companyId,
      companySourceId: source.id,
      registryKey: null,
      sourceName: source.sourceName,
      validationState: source.validationState,
    },
  });
  const pollFinishedAt = new Date();
  const runtimeMs = Math.max(1, pollFinishedAt.getTime() - now.getTime());
  const existingPollRuntime = readJsonRecord(
    readJsonRecord(source.metadataJson).pollRuntime as Prisma.JsonValue | undefined
  );
  const previousAvgRuntimeMs = readNumberValue(existingPollRuntime.avgMs) ?? runtimeMs;
  const previousRuntimeSamples = readNumberValue(existingPollRuntime.sampleCount) ?? 0;
  const nextRuntimeSamples = Math.min(previousRuntimeSamples + 1, 20);
  const nextAvgRuntimeMs =
    previousRuntimeSamples <= 0
      ? runtimeMs
      : Math.round(
          (previousAvgRuntimeMs * previousRuntimeSamples + runtimeMs) /
            Math.max(1, previousRuntimeSamples + 1)
        );

  const overlapRatio =
    summary.fetchedCount > 0 ? summary.dedupedCount / summary.fetchedCount : source.overlapRatio;
  const taleoZeroYield =
    source.connectorName === "taleo" &&
    summary.fetchedCount === 0 &&
    summary.acceptedCount === 0;
  const repeatedTaleoZeroYield =
    taleoZeroYield &&
    source.lastJobsFetchedCount === 0 &&
    source.lastJobsAcceptedCount === 0 &&
    source.pollSuccessCount > 0;
  const predictedPriority = Math.max(
    0.1,
    Math.min(
      1.5,
      (summary.canonicalCreatedCount + 1) / Math.max(1, summary.fetchedCount) +
        (source.extractionRoute === "HTML_FALLBACK" ? 0.15 : 0.3)
    )
  );
  const nextPollAttemptCount = source.pollAttemptCount + 1;
  const nextPollSuccessCount = source.pollSuccessCount + 1;
  const nextJobsFetchedCount = source.jobsFetchedCount + summary.fetchedCount;
  const nextJobsAcceptedCount = source.jobsAcceptedCount + summary.acceptedCount;
  const nextJobsDedupedCount = source.jobsDedupedCount + summary.dedupedCount;
  const nextJobsCreatedCount = source.jobsCreatedCount + summary.canonicalCreatedCount;
  const retainedLiveJobCount = await prisma.jobSourceMapping.count({
    where: {
      sourceName: source.sourceName,
      removedAt: null,
      canonicalJob: {
        status: { in: ["LIVE", "AGING"] },
      },
    },
  });
  const importedAtsZeroYield =
    source.parserVersion === "csv-import:v1" &&
    source.sourceType === "ATS" &&
    retainedLiveJobCount === 0 &&
    nextPollSuccessCount >= 2 &&
    nextJobsAcceptedCount === 0;
  const importedAtsLowYield =
    source.parserVersion === "csv-import:v1" &&
    source.sourceType === "ATS" &&
    retainedLiveJobCount === 0 &&
    nextPollSuccessCount >= 3 &&
    nextJobsCreatedCount === 0;
  const nextYieldScore = computeSourceYieldScore({
    sourceQualityScore: Math.max(
      taleoZeroYield
        ? Math.max(
            0.12,
            Math.min(source.sourceQualityScore, repeatedTaleoZeroYield ? 0.22 : 0.32)
          )
        : source.sourceQualityScore,
      taleoZeroYield
        ? Math.min(0.38, predictedPriority / 1.5)
        : Math.min(0.99, predictedPriority / 1.5)
    ),
    pollAttemptCount: nextPollAttemptCount,
    pollSuccessCount: nextPollSuccessCount,
    jobsFetchedCount: nextJobsFetchedCount,
    jobsAcceptedCount: nextJobsAcceptedCount,
    jobsCreatedCount: nextJobsCreatedCount,
    retainedLiveJobCount,
    overlapRatio,
  });

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      status:
        repeatedTaleoZeroYield || importedAtsZeroYield || importedAtsLowYield
          ? "DEGRADED"
          : "ACTIVE",
      validationState: "VALIDATED",
      pollState:
        taleoZeroYield || importedAtsZeroYield || importedAtsLowYield
          ? "BACKOFF"
          : "READY",
      lastValidatedAt: source.lastValidatedAt ?? now,
      lastSuccessfulPollAt: pollFinishedAt,
      lastHttpStatus: 200,
      cooldownUntil: new Date(
        pollFinishedAt.getTime() +
          (
            importedAtsLowYield
              ? 48 * 60
              : importedAtsZeroYield
                ? 24 * 60
              : taleoZeroYield
              ? repeatedTaleoZeroYield
                ? 24 * 60
                : 12 * 60
              : source.pollingCadenceMinutes ?? DEFAULT_SOURCE_POLL_CADENCE_MINUTES
          ) *
            60 *
            1000
      ),
      pollAttemptCount: nextPollAttemptCount,
      pollSuccessCount: nextPollSuccessCount,
      jobsFetchedCount: nextJobsFetchedCount,
      jobsAcceptedCount: nextJobsAcceptedCount,
      jobsDedupedCount: nextJobsDedupedCount,
      jobsCreatedCount: nextJobsCreatedCount,
      retainedLiveJobCount,
      lastJobsFetchedCount: summary.fetchedCount,
      lastJobsAcceptedCount: summary.acceptedCount,
      lastJobsDedupedCount: summary.dedupedCount,
      lastJobsCreatedCount: summary.canonicalCreatedCount,
      consecutiveFailures: 0,
      failureStreak: 0,
      lastFailureAt: null,
      priorityScore: predictedPriority,
      sourceQualityScore:
        importedAtsLowYield || importedAtsZeroYield
          ? Math.max(
              0.1,
              Math.min(source.sourceQualityScore, importedAtsLowYield ? 0.18 : 0.26)
            )
          : taleoZeroYield
            ? Math.max(
                0.12,
                Math.min(source.sourceQualityScore, repeatedTaleoZeroYield ? 0.22 : 0.32)
              )
            : Math.max(source.sourceQualityScore, Math.min(0.99, predictedPriority / 1.5)),
      yieldScore: nextYieldScore,
      overlapRatio,
      validationMessage:
        importedAtsLowYield
          ? "Imported ATS source has produced no new canonicals after repeated successful polls and was cooled down aggressively."
          : importedAtsZeroYield
            ? "Imported ATS source validated but has not yielded accepted jobs after repeated polls and was backed off."
            : taleoZeroYield
              ? repeatedTaleoZeroYield
                ? "Taleo source returned zero listings in consecutive polls and was cooled down aggressively."
                : "Taleo source returned zero listings and was backed off for a longer cooldown."
              : null,
      metadataJson: mergeMetadataJson(source.metadataJson, {
        lastSummary: {
          acceptedCount: summary.acceptedCount,
          canonicalCreatedCount: summary.canonicalCreatedCount,
          canonicalUpdatedCount: summary.canonicalUpdatedCount,
          dedupedCount: summary.dedupedCount,
          fetchedCount: summary.fetchedCount,
          runtimeMs,
        },
        pollRuntime: {
          avgMs: nextAvgRuntimeMs,
          lastFinishedAt: pollFinishedAt.toISOString(),
          lastMs: runtimeMs,
          sampleCount: nextRuntimeSamples,
        },
        workdayHost: getWorkdayHostKey({
          connectorName: source.connectorName,
          token: source.token,
          boardUrl: source.boardUrl,
        }),
      }),
    },
  });

  await prisma.company.update({
    where: { id: source.companyId },
    data: {
      lastSuccessfulPollAt: pollFinishedAt,
      crawlStatus: taleoZeroYield ? "DEGRADED" : "IDLE",
      discoveryStatus: "DISCOVERED",
    },
  });
}

async function handleCompanySourcePollFailure(
  companySourceId: string | null,
  now: Date,
  error: unknown
): Promise<Date | null> {
  if (!companySourceId) return null;

  const source = await prisma.companySource.findUnique({
    where: { id: companySourceId },
    select: {
      id: true,
      companyId: true,
      boardUrl: true,
      connectorName: true,
      sourceQualityScore: true,
      yieldScore: true,
      jobsFetchedCount: true,
      jobsAcceptedCount: true,
      jobsCreatedCount: true,
      retainedLiveJobCount: true,
      overlapRatio: true,
      pollAttemptCount: true,
      pollSuccessCount: true,
      validationState: true,
      pollState: true,
      consecutiveFailures: true,
      failureStreak: true,
      status: true,
      token: true,
      metadataJson: true,
    },
  });

  if (!source) return null;

  const errorMessage = error instanceof Error ? error.message : String(error);
  // 400 is treated as hard failure alongside 404/410: a Bad Request from a
  // company career page almost always means a misconfigured or defunct source URL.
  const hardFailure = /\b(400|404|410)\b/.test(errorMessage);
  const blockedFailure = /\b(401|403|429)\b/.test(errorMessage);
  const timeoutFailure =
    /TIME_BUDGET_EXCEEDED|ABORTED_BY_RUNNER|RuntimeBudgetExceededError|AbortError|runtime budget exceeded/i.test(
      errorMessage
    );
  // Workday returns 500/502/503/504 and text/html as bot-detection responses,
  // not as genuine server errors. Treat all of these as blocked failures so they
  // get the 12h/24h/36h cooldown ladder rather than the 1h generic ladder.
  const workdayBlockedFailure =
    source.connectorName === "workday" &&
    (!timeoutFailure &&
      (blockedFailure ||
      /\b(500|502|503|504)\b/.test(errorMessage) ||
      /bot detection|text\/html|content.type/i.test(errorMessage)));
  const protectedHighValueWorkday =
    workdayBlockedFailure &&
    isHighValueWorkdaySource({
      pollAttemptCount: source.pollAttemptCount,
      pollSuccessCount: source.pollSuccessCount,
      jobsAcceptedCount: source.jobsAcceptedCount,
      retainedLiveJobCount: source.retainedLiveJobCount,
    });
  const deterministicHardInvalid =
    hardFailure && DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS.has(source.connectorName);
  const nextFailureStreak = source.failureStreak + 1;
  const nextConsecutiveFailures = source.consecutiveFailures + 1;
  const nextPollAttemptCount = source.pollAttemptCount + 1;
  const shouldRediscover =
    protectedHighValueWorkday
      ? false
      : timeoutFailure
        ? false
      :
    deterministicHardInvalid
      ? true
      : hardFailure
      ? nextConsecutiveFailures >= HARD_FAILURE_REDISCOVERY_THRESHOLD
      : workdayBlockedFailure
        ? nextConsecutiveFailures >= WORKDAY_BLOCKED_REDISCOVERY_THRESHOLD
      : nextFailureStreak >= REDISCOVERY_FAILURE_THRESHOLD;
  const nextStatus: CompanySourceStatus =
    protectedHighValueWorkday
      ? "DEGRADED"
      : timeoutFailure
        ? "DEGRADED"
      : shouldRediscover
        ? "REDISCOVER_REQUIRED"
        : "DEGRADED";
  const nextValidationState: CompanySourceValidationState =
    protectedHighValueWorkday
      ? "VALIDATED"
      : timeoutFailure
        ? "VALIDATED"
      :
    deterministicHardInvalid
      ? "INVALID"
      : hardFailure
      ? shouldRediscover
        ? "INVALID"
        : "SUSPECT"
      : (blockedFailure || workdayBlockedFailure)
        ? "BLOCKED"
        : "SUSPECT";
  const nextPollState: CompanySourcePollState =
    protectedHighValueWorkday
      ? "BACKOFF"
      : timeoutFailure
        ? "BACKOFF"
      : shouldRediscover
        ? "QUARANTINED"
        : "BACKOFF";
  const statusMatch = errorMessage.match(/\b(401|403|404|410|429|500|502|503|504)\b/);
  const nextHttpStatus = statusMatch ? Number(statusMatch[1]) : null;
  const nextSourceQualityScore = protectedHighValueWorkday
    ? Math.max(0.45, source.sourceQualityScore * 0.88)
    : timeoutFailure
      ? Math.max(0.28, source.sourceQualityScore * 0.9)
    : Math.max(0.02, source.failureStreak > 0 ? 0.12 : 0.2);
  const nextYieldScore = computeSourceYieldScore({
    sourceQualityScore: nextSourceQualityScore,
    pollAttemptCount: nextPollAttemptCount,
    pollSuccessCount: source.pollSuccessCount,
    jobsFetchedCount: source.jobsFetchedCount,
    jobsAcceptedCount: source.jobsAcceptedCount,
    jobsCreatedCount: source.jobsCreatedCount,
    retainedLiveJobCount: source.retainedLiveJobCount,
    overlapRatio: source.overlapRatio,
  });
  const workdayHost = getWorkdayHostKey({
    connectorName: source.connectorName,
    token: source.token,
    boardUrl: source.boardUrl,
  });

  const cooldownHours = deterministicHardInvalid
    ? 12
    : protectedHighValueWorkday
      ? nextConsecutiveFailures * 6
    : timeoutFailure
      ? Math.min(12, Math.max(2, nextConsecutiveFailures * 2))
    : hardFailure
      ? nextConsecutiveFailures * 4        // 400/404/410: 4h, 8h, 12h…
      : workdayBlockedFailure
        ? nextConsecutiveFailures * 12     // Workday 403/429: 12h, 24h, 36h…
        : blockedFailure
          ? nextConsecutiveFailures * 8    // other 403/429: 8h, 16h, 24h…
          : nextFailureStreak;             // generic failures: 1h, 2h, 3h…
  const cooldownUntil = new Date(now.getTime() + cooldownHours * 60 * 60 * 1000);
  let hostCooldownUntil: Date | null = null;
  let hostBlockedStreak = 0;

  if (workdayBlockedFailure && workdayHost) {
    const siblingSources = await prisma.companySource.findMany({
      where: {
        connectorName: "workday",
        token: {
          startsWith: `${workdayHost}|`,
        },
      },
      select: {
        cooldownUntil: true,
        lastFailureAt: true,
        lastHttpStatus: true,
        consecutiveFailures: true,
      },
    });

    const recentBlockedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recentBlockedSourceCount = siblingSources.filter(
      (sibling) =>
        sibling.lastFailureAt &&
        sibling.lastFailureAt >= recentBlockedCutoff &&
        sibling.lastHttpStatus &&
        WORKDAY_BLOCKED_HTTP_STATUSES.has(sibling.lastHttpStatus)
    ).length;
    const maxSiblingConsecutiveFailures = siblingSources.reduce(
      (maxStreak, sibling) => Math.max(maxStreak, sibling.consecutiveFailures),
      0
    );

    hostBlockedStreak = Math.max(
      recentBlockedSourceCount,
      maxSiblingConsecutiveFailures,
      nextConsecutiveFailures
    );

    if (hostBlockedStreak >= WORKDAY_HOST_BLOCK_STREAK_THRESHOLD) {
      hostCooldownUntil = new Date(
        now.getTime() + WORKDAY_HOST_COOLDOWN_HOURS * 60 * 60 * 1000
      );

      await prisma.companySource.updateMany({
        where: {
          connectorName: "workday",
          token: {
            startsWith: `${workdayHost}|`,
          },
          OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: hostCooldownUntil } }],
        },
        data: {
          cooldownUntil: hostCooldownUntil,
          pollState: "BACKOFF",
          status: "DEGRADED",
        },
      });
    }
  }

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      status: nextStatus,
      validationState: nextValidationState,
      pollState: nextPollState,
      lastFailureAt: now,
      lastHttpStatus: nextHttpStatus,
      pollAttemptCount: nextPollAttemptCount,
      consecutiveFailures: nextConsecutiveFailures,
      failureStreak: nextFailureStreak,
      cooldownUntil: hostCooldownUntil ?? cooldownUntil,
      sourceQualityScore: nextSourceQualityScore,
      yieldScore: nextYieldScore,
      validationMessage: protectedHighValueWorkday
        ? `High-value Workday source blocked; preserved with slower retry window. ${errorMessage}`
        : timeoutFailure
          ? `TIME_BUDGET_EXCEEDED: poll exceeded hard runtime budget and was released immediately. ${errorMessage}`
        : workdayBlockedFailure && workdayHost
          ? `Workday host ${workdayHost} blocked (${hostBlockedStreak} recent blocked source(s)); source backed off. ${errorMessage}`
          : errorMessage,
      metadataJson: mergeMetadataJson(source.metadataJson, {
        lastFailure: {
          failureType:
            timeoutFailure && /ABORTED_BY_RUNNER/i.test(errorMessage)
              ? "ABORTED_BY_RUNNER"
              : timeoutFailure
                ? "TIME_BUDGET_EXCEEDED"
            : source.connectorName === "workday" && nextHttpStatus === 403
              ? "BLOCKED_403"
              : source.connectorName === "workday" && workdayBlockedFailure
                ? "BLOCKED_WORKDAY"
                : hardFailure
                  ? "HARD_FAILURE"
                  : blockedFailure
                    ? "BLOCKED"
                    : "GENERIC_FAILURE",
          httpStatus: nextHttpStatus,
          occurredAt: now.toISOString(),
        },
        workdayHost,
        workdayHostState:
          workdayHost && workdayBlockedFailure
            ? {
                blockedStreak: hostBlockedStreak,
                cooldownUntil: (hostCooldownUntil ?? cooldownUntil).toISOString(),
                lastBlockedAt: now.toISOString(),
              }
            : undefined,
      }),
    },
  });

  await prisma.company.update({
    where: { id: source.companyId },
    data: {
      crawlStatus:
        nextStatus === "REDISCOVER_REQUIRED"
          ? "DEGRADED"
          : blockedFailure
            ? "BLOCKED"
            : "ACTIVE",
      lastDiscoveryError: deterministicHardInvalid
        ? `${source.connectorName} source returned a hard not-found response and was quarantined for rediscovery.`
        : errorMessage,
    },
  });

  if (nextStatus === "REDISCOVER_REQUIRED") {
    await enqueueUniqueSourceTask({
      kind: "REDISCOVERY",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore: 85,
      notBeforeAt: now,
    });
  }

  return hostCooldownUntil ?? cooldownUntil;
}

async function handleCompanySourceValidationFailure(
  companySourceId: string | null,
  now: Date,
  error: unknown
) {
  if (!companySourceId) return;

  const source = await prisma.companySource.findUnique({
    where: { id: companySourceId },
    select: {
      id: true,
      companyId: true,
      sourceQualityScore: true,
      jobsFetchedCount: true,
      jobsAcceptedCount: true,
      jobsCreatedCount: true,
      retainedLiveJobCount: true,
      overlapRatio: true,
      pollAttemptCount: true,
      pollSuccessCount: true,
      validationAttemptCount: true,
      validationSuccessCount: true,
      consecutiveFailures: true,
    },
  });

  if (!source) return;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const nextFailureCount = source.consecutiveFailures + 1;
  const nextValidationAttemptCount = source.validationAttemptCount + 1;
  const statusMatch = errorMessage.match(/\b(401|403|404|410|429|500|502|503|504)\b/);
  const nextSourceQualityScore = 0.1;
  const nextYieldScore = computeSourceYieldScore({
    sourceQualityScore: nextSourceQualityScore,
    pollAttemptCount: source.pollAttemptCount,
    pollSuccessCount: source.pollSuccessCount,
    jobsFetchedCount: source.jobsFetchedCount,
    jobsAcceptedCount: source.jobsAcceptedCount,
    jobsCreatedCount: source.jobsCreatedCount,
    retainedLiveJobCount: source.retainedLiveJobCount,
    overlapRatio: source.overlapRatio,
  });

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      status: nextFailureCount >= HARD_FAILURE_REDISCOVERY_THRESHOLD ? "REDISCOVER_REQUIRED" : "DEGRADED",
      validationState:
        nextFailureCount >= HARD_FAILURE_REDISCOVERY_THRESHOLD
          ? "NEEDS_REDISCOVERY"
          : "SUSPECT",
      pollState:
        nextFailureCount >= HARD_FAILURE_REDISCOVERY_THRESHOLD
          ? "QUARANTINED"
          : "BACKOFF",
      validationAttemptCount: nextValidationAttemptCount,
      consecutiveFailures: nextFailureCount,
      failureStreak: nextFailureCount,
      lastFailureAt: now,
      lastHttpStatus: statusMatch ? Number(statusMatch[1]) : null,
      cooldownUntil: new Date(now.getTime() + nextFailureCount * 2 * 60 * 60 * 1000),
      validationMessage: errorMessage,
      sourceQualityScore: nextSourceQualityScore,
      yieldScore: nextYieldScore,
    },
  });

  await prisma.company.update({
    where: { id: source.companyId },
    data: {
      crawlStatus: "DEGRADED",
      lastDiscoveryError: errorMessage,
    },
  });

  if (nextFailureCount >= HARD_FAILURE_REDISCOVERY_THRESHOLD) {
    await enqueueUniqueSourceTask({
      kind: "REDISCOVERY",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore: 88,
      notBeforeAt: now,
    });
  }
}

function buildConnectorForCompanySource(
  source: {
    sourceName: string;
    connectorName: string;
    token: string;
    boardUrl: string;
    extractionRoute: ExtractionRouteKind;
    parserVersion: string | null;
    company: { name: string };
  }
) {
  if (source.connectorName === "company-site") {
    return createCompanySiteConnector({
      sourceName: source.sourceName,
      companyName: source.company.name,
      boardUrl: source.boardUrl,
      extractionRoute: source.extractionRoute,
      parserVersion: source.parserVersion,
    });
  }

  return createConnectorForCandidate({
    input: source.boardUrl,
    connectorName: source.connectorName as DiscoveredSourceCandidate["connectorName"],
    token: source.token,
    sourceKey: `${source.connectorName}:${source.token}`.toLowerCase(),
    sourceName: source.sourceName,
    boardUrl: source.boardUrl,
    source: "url",
  });
}

function buildEnterpriseRecordForCompany(company: {
  name: string;
  companyKey: string;
  domain: string | null;
  careersUrl: string | null;
  detectedAts?: string | null;
  metadataJson?: Prisma.JsonValue | null;
}) {
  const metadata =
    company.metadataJson && typeof company.metadataJson === "object" && !Array.isArray(company.metadataJson)
      ? (company.metadataJson as Record<string, Prisma.JsonValue>)
      : {};

  const metadataTenants = readStringArray(metadata.tenants);
  const metadataDomains = readStringArray(metadata.domains);
  const metadataSeedPageUrls = readStringArray(metadata.seedPageUrls);
  const metadataSearchTerms = Array.from(
    new Set([...readStringArray(metadata.searchTerms), ...readStringArray(metadata.aliases)])
  );
  const metadataSectors = readStringArray(metadata.sectors);
  const metadataWdVariants = readStringArray(metadata.wdVariants);
  const metadataWdSites = readStringArray(metadata.wdSites);
  const metadataSfHosts = readStringArray(metadata.sfHosts);
  const metadataSfPaths = readStringArray(metadata.sfPaths);
  const metadataAts = readStringValue(metadata.ats) ?? readStringValue(metadata.detectedAts);
  const cleanedName = cleanCompanyName(company.name) || company.name;
  const companyKey = buildCompanyKey(cleanedName) || company.companyKey;
  const seedPageUrls = Array.from(new Set([
    ...metadataSeedPageUrls,
    company.careersUrl,
    company.domain ? `https://${company.domain}/careers` : null,
    company.domain ? `https://${company.domain}/jobs` : null,
  ].filter(Boolean) as string[]));
  const domains = Array.from(new Set([
    ...metadataDomains,
    company.domain,
  ].filter(Boolean) as string[]));
  const tenants = Array.from(new Set([
    ...metadataTenants,
    companyKey,
  ].filter(Boolean)));
  const searchTerms = Array.from(new Set([
    cleanedName,
    ...metadataSearchTerms,
  ].filter(Boolean)));

  return {
    name: cleanedName,
    searchTerms,
    tenants,
    domains,
    seedPageUrls,
    ats:
      metadataAts === "workday" ||
      metadataAts === "successfactors" ||
      metadataAts === "both"
        ? metadataAts
        : company.detectedAts === "workday" ||
            company.detectedAts === "successfactors" ||
            company.detectedAts === "both"
          ? company.detectedAts
          : "unknown",
    sectors: metadataSectors,
    wdVariants: metadataWdVariants,
    wdSites: metadataWdSites,
    sfHosts: metadataSfHosts,
    sfPaths: metadataSfPaths,
  } satisfies EnterpriseCompanyRecord;
}

function readStringArray(value: Prisma.JsonValue | undefined) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function readStringValue(value: Prisma.JsonValue | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSeedSource(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return readStringValue((value as Record<string, Prisma.JsonValue>).seedSource);
}
