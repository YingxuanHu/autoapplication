import { prisma } from "@/lib/db";
import { ensureCompanyRecord, assignCanonicalJobsToCompany } from "@/lib/ingestion/company-records";
import { buildCompanyKey, cleanCompanyName } from "@/lib/ingestion/discovery/company-corpus";
import { buildDiscoveredSourceUrl } from "@/lib/ingestion/discovery/sources";
import { enqueueUniqueSourceTask } from "@/lib/ingestion/task-queue";
import type {
  ScheduledConnectorDefinition,
  SupportedConnectorName,
} from "@/lib/ingestion/registry";
import type { Prisma } from "@/generated/prisma/client";

const COMPANY_SOURCE_AUTHORITY_PREFIXES = new Set([
  "Ashby",
  "Greenhouse",
  "Lever",
  "Recruitee",
  "Rippling",
  "SmartRecruiters",
  "SuccessFactors",
  "Taleo",
  "Workable",
  "Workday",
  "iCIMS",
]);

const SOURCE_PREFIX_TO_CONNECTOR: Record<string, SupportedConnectorName> = {
  Ashby: "ashby",
  Greenhouse: "greenhouse",
  Lever: "lever",
  Recruitee: "recruitee",
  Rippling: "rippling",
  SmartRecruiters: "smartrecruiters",
  SuccessFactors: "successfactors",
  Taleo: "taleo",
  Workable: "workable",
  Workday: "workday",
  iCIMS: "icims",
};

type LegacyPromotionResult =
  | {
      managed: false;
    }
  | {
      managed: true;
      companySourceId: string;
      sourceName: string;
      companyId: string;
      taskKind: "SOURCE_VALIDATION" | "CONNECTOR_POLL";
    };

export function isCompanySourceManagedConnector(sourceName: string) {
  const prefix = sourceName.split(":")[0] ?? sourceName;
  return COMPANY_SOURCE_AUTHORITY_PREFIXES.has(prefix);
}

export async function routeLegacyScheduledConnectorToCompanySource(
  definition: ScheduledConnectorDefinition,
  options: {
    now: Date;
    origin: "legacy_registry" | "orchestrator_registry";
  }
): Promise<LegacyPromotionResult> {
  const parsed = parseSourceName(definition.connector.sourceName);
  if (!parsed) {
    return { managed: false };
  }

  const inferred = await inferCompanyForLegacySource(definition.connector.sourceName, parsed.token);
  const company = await ensureCompanyRecord({
    companyName: inferred.companyName,
    companyKey: inferred.companyKey,
    urls: [inferred.sampleUrl, buildDiscoveredSourceUrl(parsed.connectorName, parsed.token)],
    careersUrl: inferred.sampleUrl ?? buildDiscoveredSourceUrl(parsed.connectorName, parsed.token),
    detectedAts: parsed.connectorName,
    discoveryStatus: "DISCOVERED",
    crawlStatus: "IDLE",
    discoveryConfidence: inferred.discoveryConfidence,
    metadataJson: {
      seedSource: options.origin,
      sourceName: definition.connector.sourceName,
      connectorKey: definition.connector.key,
      connectorName: parsed.connectorName,
      token: parsed.token,
    },
  });

  await assignCanonicalJobsToCompany(company.id, company.companyKey);

  const companySource = await prisma.companySource.upsert({
    where: { sourceName: definition.connector.sourceName },
    create: {
      companyId: company.id,
      sourceName: definition.connector.sourceName,
      connectorName: parsed.connectorName,
      token: parsed.token,
      boardUrl: inferred.sampleUrl ?? buildDiscoveredSourceUrl(parsed.connectorName, parsed.token),
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType: "ATS",
      extractionRoute: "ATS_NATIVE",
      parserVersion: "legacy-registry:v1",
      pollingCadenceMinutes: definition.cadenceMinutes,
      priorityScore: inferred.priorityScore,
      sourceQualityScore: inferred.sourceQualityScore,
      yieldScore: inferred.sourceQualityScore * 0.7,
      firstSeenAt: options.now,
      lastProvisionedAt: options.now,
      lastDiscoveryAt: options.now,
      metadataJson: {
        managedOrigin: options.origin,
        connectorKey: definition.connector.key,
      } as Prisma.InputJsonValue,
    },
    update: {
      companyId: company.id,
      connectorName: parsed.connectorName,
      token: parsed.token,
      boardUrl: inferred.sampleUrl ?? buildDiscoveredSourceUrl(parsed.connectorName, parsed.token),
      pollingCadenceMinutes: definition.cadenceMinutes,
      lastProvisionedAt: options.now,
      lastDiscoveryAt: options.now,
      metadataJson: {
        managedOrigin: options.origin,
        connectorKey: definition.connector.key,
      } as Prisma.InputJsonValue,
    },
  });

  const shouldPollDirectly =
    companySource.validationState === "VALIDATED" &&
    companySource.pollState !== "QUARANTINED" &&
    (!companySource.cooldownUntil || companySource.cooldownUntil <= options.now);

  const taskKind = shouldPollDirectly ? "CONNECTOR_POLL" : "SOURCE_VALIDATION";

  await enqueueUniqueSourceTask({
    kind: taskKind,
    companyId: company.id,
    companySourceId: companySource.id,
    priorityScore: Math.max(
      60,
      Math.round(
        (companySource.priorityScore > 0 ? companySource.priorityScore : inferred.priorityScore) * 100
      )
    ),
    notBeforeAt: companySource.cooldownUntil && companySource.cooldownUntil > options.now
      ? companySource.cooldownUntil
      : options.now,
    payloadJson: {
      origin: options.origin,
      sourceName: companySource.sourceName,
      validationState: companySource.validationState,
    },
  });

  return {
    managed: true,
    companySourceId: companySource.id,
    sourceName: companySource.sourceName,
    companyId: company.id,
    taskKind,
  };
}

async function inferCompanyForLegacySource(sourceName: string, token: string) {
  const existingSource = await prisma.companySource.findUnique({
    where: { sourceName },
    select: {
      companyId: true,
      boardUrl: true,
      priorityScore: true,
      sourceQualityScore: true,
      company: {
        select: {
          name: true,
          companyKey: true,
        },
      },
    },
  });

  if (existingSource?.company) {
    return {
      companyName: existingSource.company.name,
      companyKey: existingSource.company.companyKey,
      sampleUrl: existingSource.boardUrl,
      discoveryConfidence: 0.96,
      priorityScore: existingSource.priorityScore > 0 ? existingSource.priorityScore : 0.9,
      sourceQualityScore:
        existingSource.sourceQualityScore > 0 ? existingSource.sourceQualityScore : 0.9,
    };
  }

  const mapping = await prisma.jobSourceMapping.findFirst({
    where: {
      sourceName,
      removedAt: null,
    },
    orderBy: [{ lastSeenAt: "desc" }],
    select: {
      sourceUrl: true,
      canonicalJob: {
        select: {
          company: true,
          companyKey: true,
          applyUrl: true,
        },
      },
    },
  });

  if (mapping?.canonicalJob) {
    return {
      companyName: mapping.canonicalJob.company,
      companyKey: mapping.canonicalJob.companyKey,
      sampleUrl: mapping.sourceUrl ?? mapping.canonicalJob.applyUrl,
      discoveryConfidence: 0.94,
      priorityScore: 0.92,
      sourceQualityScore: 0.92,
    };
  }

  const companyName = humanizeToken(token);
  const companyKey = buildCompanyKey(cleanCompanyName(companyName));

  return {
    companyName,
    companyKey,
    sampleUrl: null,
    discoveryConfidence: 0.72,
    priorityScore: 0.78,
    sourceQualityScore: 0.78,
  };
}

function parseSourceName(sourceName: string) {
  const separatorIndex = sourceName.indexOf(":");
  if (separatorIndex <= 0) return null;

  const prefix = sourceName.slice(0, separatorIndex);
  if (!COMPANY_SOURCE_AUTHORITY_PREFIXES.has(prefix)) return null;

  const connectorName = SOURCE_PREFIX_TO_CONNECTOR[prefix];
  const token = sourceName.slice(separatorIndex + 1).trim();
  if (!connectorName || !token) return null;

  return {
    connectorName,
    token,
  };
}

function humanizeToken(token: string) {
  const primarySegment = token.split(/[|/]/)[0] ?? token;
  return primarySegment
    .replace(/\.[a-z0-9.-]+$/i, "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
