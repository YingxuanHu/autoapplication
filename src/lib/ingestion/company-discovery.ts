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
import { ingestConnector } from "@/lib/ingestion/pipeline";
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
// Per-cycle cap on how many sources of a given connector can be polled.
// Workday's myworkdayjobs.com infrastructure rate-limits aggressively — hitting
// many tenants simultaneously triggers Cloudflare bot detection for all of them.
// Taleo is also intentionally capped because its headless+sitemap fallback path
// is much slower than the ATS APIs and can monopolize the cycle.
const CONNECTOR_POLL_CYCLE_CAPS: Record<string, number> = {
  workday: 6,
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
const DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS = new Set([
  "greenhouse",
  "lever",
  "ashby",
]);

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
}) {
  const validationSuccessRate =
    input.validationAttemptCount > 0
      ? input.validationSuccessCount / input.validationAttemptCount
      : 0;

  return (
    Math.round(input.priorityScore * 100) / 100 +
    Math.round(input.sourceQualityScore * 45) +
    Math.round(input.yieldScore * 35) +
    Math.min(35, input.historicalYield * 1.25) +
    (input.validationState === "UNVALIDATED" ? 40 : 0) +
    (input.validationState === "SUSPECT" ? 20 : 0) +
    (input.validationState === "NEEDS_REDISCOVERY" ? 10 : 0) +
    Math.round(validationSuccessRate * 20) -
    Math.max(0, input.consecutiveFailures * 5) +
    Math.round(input.discoveryConfidence * 10)
  );
}

function computePollPriorityScore(input: {
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
  const lowYieldPenalty =
    input.pollSuccessCount >= 3 && input.jobsCreatedCount === 0 ? 35 : 0;
  const emptyPenalty =
    input.pollSuccessCount >= 2 && input.jobsAcceptedCount === 0 ? 20 : 0;

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
    (input.status === "DEGRADED" ? 10 : 0) +
    Math.max(0, 15 - input.consecutiveFailures * 3) +
    Math.round(input.discoveryConfidence * 10) -
    lowYieldPenalty -
    emptyPenalty
  );
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

function applyConnectorPollCycleCaps<
  T extends { source: { id: string; connectorName: string }; priorityScore: number }
>(candidates: T[], limit: number, existingPendingCounts: Record<string, number> = {}) {
  if (limit <= 0 || candidates.length === 0) {
    return [] as T[];
  }

  const selected: T[] = [];
  const selectedIds = new Set<string>();
  // Seed connector counts with already-pending tasks so restarts don't exceed the cap.
  const connectorCounts = new Map<string, number>(
    Object.entries(existingPendingCounts)
  );

  const tryTakeCandidate = (candidate: T) => {
    if (selectedIds.has(candidate.source.id)) {
      return false;
    }

    const connectorName = candidate.source.connectorName;
    const connectorCap = CONNECTOR_POLL_CYCLE_CAPS[connectorName];
    const currentCount = connectorCounts.get(connectorName) ?? 0;

    if (typeof connectorCap === "number" && currentCount >= connectorCap) {
      return false;
    }

    selected.push(candidate);
    selectedIds.add(candidate.source.id);
    connectorCounts.set(connectorName, currentCount + 1);
    return true;
  };

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    tryTakeCandidate(candidate);
  }

  if (selected.length >= limit) {
    return selected;
  }

  const fallbacks = [...candidates]
    .filter((candidate) => !selectedIds.has(candidate.source.id))
    .sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }

      return left.source.connectorName.localeCompare(right.source.connectorName);
    });

  for (const candidate of fallbacks) {
    if (selected.length >= limit) break;
    tryTakeCandidate(candidate);
  }

  return selected;
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
      const leftScore =
        (left.sources.length === 0 ? 50 : 0) +
        (left.detectedAts ? 40 : 0) +
        Math.round(left.discoveryConfidence * 20) +
        Math.min(30, left.jobs.length * 3) +
        (left.discoveryStatus === "FAILED" ? -20 : 0) +
        (left.lastDiscoveryAt ? 0 : 15);
      const rightScore =
        (right.sources.length === 0 ? 50 : 0) +
        (right.detectedAts ? 40 : 0) +
        Math.round(right.discoveryConfidence * 20) +
        Math.min(30, right.jobs.length * 3) +
        (right.discoveryStatus === "FAILED" ? -20 : 0) +
        (right.lastDiscoveryAt ? 0 : 15);

      if (rightScore !== leftScore) return rightScore - leftScore;
      return (right.updatedAt?.getTime?.() ?? 0) - (left.updatedAt?.getTime?.() ?? 0);
    })
    .slice(0, options.limit ?? DISCOVERY_TASK_LIMIT);

  for (const company of companies) {
    const priorityScore =
      Math.min(40, company.jobs.length * 3) +
      (company.sources.length === 0 ? 30 : 0) +
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
  const bootstrapQuota = Math.max(12, Math.min(Math.floor(pollLimit * 0.3), 60));
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
    take: Math.max(pollLimit * 4, pollLimit + bootstrapQuota),
  });

  const scoredSources = candidates.map((source) => {
    const historicalYield = source.company.jobs.length;
    const priorityScore = computePollPriorityScore({
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
    });

    return { source, priorityScore };
  });

  const bootstrapSources = pickBalancedPollSources(
    scoredSources.filter(({ source }) => source.pollAttemptCount === 0),
    bootstrapQuota,
    (left, right) =>
      (right.source.lastValidatedAt?.getTime() ?? 0) -
      (left.source.lastValidatedAt?.getTime() ?? 0)
  );

  const bootstrapIds = new Set(bootstrapSources.map(({ source }) => source.id));
  const establishedSources = pickBalancedPollSources(
    scoredSources.filter(({ source }) => !bootstrapIds.has(source.id)),
    Math.max(0, pollLimit - bootstrapSources.length),
    (left, right) =>
      (left.source.lastSuccessfulPollAt?.getTime() ?? 0) -
      (right.source.lastSuccessfulPollAt?.getTime() ?? 0)
  );

  // Count existing PENDING tasks per capped connector so restarts don't
  // accumulate stale tasks above the per-cycle budget.
  const existingPendingCounts: Record<string, number> = {};
  if (Object.keys(CONNECTOR_POLL_CYCLE_CAPS).length > 0) {
    const pendingRows = await prisma.sourceTask.findMany({
      where: {
        kind: "CONNECTOR_POLL",
        status: "PENDING",
        companySourceId: {
          in: [...bootstrapSources, ...establishedSources]
            .map(({ source }) => source.id),
        },
      },
      select: { companySourceId: true },
    });
    const pendingSourceIds = new Set(
      pendingRows.map((r) => r.companySourceId).filter(Boolean) as string[]
    );
    for (const { source } of [...bootstrapSources, ...establishedSources]) {
      if (
        pendingSourceIds.has(source.id) &&
        CONNECTOR_POLL_CYCLE_CAPS[source.connectorName] !== undefined
      ) {
        existingPendingCounts[source.connectorName] =
          (existingPendingCounts[source.connectorName] ?? 0) + 1;
      }
    }
  }

  const sources = applyConnectorPollCycleCaps(
    [...bootstrapSources, ...establishedSources],
    pollLimit,
    existingPendingCounts
  );

  for (const { source, priorityScore } of sources) {

    await enqueueUniqueSourceTask({
      kind: "CONNECTOR_POLL",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore,
      notBeforeAt: now,
    });
  }

  return {
    enqueuedCount: sources.length,
    companySourceIds: sources.map(({ source }) => source.id),
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
  const queueStart = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let processedCount = 0;

  while (processedCount < maxTasks) {
    const elapsed = Date.now() - queueStart;
    const remainingWallClockMs = maxWallClockMs - elapsed;
    if (remainingWallClockMs <= COMPANY_SOURCE_POLL_MIN_REMAINING_BUDGET_MS) {
      console.log(
        `[sourcePollQueue] Wall-clock cap reached (${Math.round(elapsed / 1000)}s / ${Math.round(maxWallClockMs / 1000)}s) — stopping after ${processedCount} tasks`
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
    const tasks = await claimSourceTasks(
      "CONNECTOR_POLL",
      Math.min(batchConcurrency, remaining),
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

  for (const pageUrl of [...candidatePages].slice(0, MAX_CAREER_PAGE_INSPECTIONS)) {
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
  if (fallbackRoute && discoveredSourceCount === 0) {
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
    await enqueueUniqueSourceTask({
      kind: "CONNECTOR_POLL",
      companyId: source.companyId,
      companySourceId: source.id,
      priorityScore: Math.max(70, Math.round(source.priorityScore * 100)),
      notBeforeAt: now,
    });
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

  await prisma.companySource.update({
    where: { id: source.id },
    data: {
      pollState: "ACTIVE",
    },
  });

  const connector = buildConnectorForCompanySource(source);
  const summary = await ingestConnector(connector, {
    now,
    runMode: "SCHEDULED",
    maxRuntimeMs,
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
      status: repeatedTaleoZeroYield ? "DEGRADED" : "ACTIVE",
      validationState: "VALIDATED",
      pollState: taleoZeroYield ? "BACKOFF" : "READY",
      lastValidatedAt: source.lastValidatedAt ?? now,
      lastSuccessfulPollAt: now,
      lastHttpStatus: 200,
      cooldownUntil: new Date(
        now.getTime() +
          (
            taleoZeroYield
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
      sourceQualityScore: taleoZeroYield
        ? Math.max(
            0.12,
            Math.min(source.sourceQualityScore, repeatedTaleoZeroYield ? 0.22 : 0.32)
          )
        : Math.max(source.sourceQualityScore, Math.min(0.99, predictedPriority / 1.5)),
      yieldScore: nextYieldScore,
      overlapRatio,
      validationMessage: taleoZeroYield
        ? repeatedTaleoZeroYield
          ? "Taleo source returned zero listings in consecutive polls and was cooled down aggressively."
          : "Taleo source returned zero listings and was backed off for a longer cooldown."
        : null,
      metadataJson: {
        lastSummary: {
          fetchedCount: summary.fetchedCount,
          acceptedCount: summary.acceptedCount,
          canonicalCreatedCount: summary.canonicalCreatedCount,
          canonicalUpdatedCount: summary.canonicalUpdatedCount,
          dedupedCount: summary.dedupedCount,
        },
      } as Prisma.InputJsonValue,
    },
  });

  await prisma.company.update({
    where: { id: source.companyId },
    data: {
      lastSuccessfulPollAt: now,
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
    },
  });

  if (!source) return null;

  const errorMessage = error instanceof Error ? error.message : String(error);
  // 400 is treated as hard failure alongside 404/410: a Bad Request from a
  // company career page almost always means a misconfigured or defunct source URL.
  const hardFailure = /\b(400|404|410)\b/.test(errorMessage);
  const blockedFailure = /\b(401|403|429)\b/.test(errorMessage);
  // Workday returns 500/502/503/504 and text/html as bot-detection responses,
  // not as genuine server errors. Treat all of these as blocked failures so they
  // get the 12h/24h/36h cooldown ladder rather than the 1h generic ladder.
  const workdayBlockedFailure =
    source.connectorName === "workday" &&
    (blockedFailure ||
      /\b(500|502|503|504)\b/.test(errorMessage) ||
      /bot detection|text\/html|content.type/i.test(errorMessage));
  const deterministicHardInvalid =
    hardFailure && DETERMINISTIC_ATS_HARD_INVALID_CONNECTORS.has(source.connectorName);
  const nextFailureStreak = source.failureStreak + 1;
  const nextConsecutiveFailures = source.consecutiveFailures + 1;
  const nextPollAttemptCount = source.pollAttemptCount + 1;
  const shouldRediscover =
    deterministicHardInvalid
      ? true
      : hardFailure
      ? nextConsecutiveFailures >= HARD_FAILURE_REDISCOVERY_THRESHOLD
      : workdayBlockedFailure
        ? nextConsecutiveFailures >= WORKDAY_BLOCKED_REDISCOVERY_THRESHOLD
      : nextFailureStreak >= REDISCOVERY_FAILURE_THRESHOLD;
  const nextStatus: CompanySourceStatus = shouldRediscover ? "REDISCOVER_REQUIRED" : "DEGRADED";
  const nextValidationState: CompanySourceValidationState =
    deterministicHardInvalid
      ? "INVALID"
      : hardFailure
      ? shouldRediscover
        ? "INVALID"
        : "SUSPECT"
      : (blockedFailure || workdayBlockedFailure)
        ? "BLOCKED"
        : "SUSPECT";
  const nextPollState: CompanySourcePollState = shouldRediscover
    ? "QUARANTINED"
    : "BACKOFF";
  const statusMatch = errorMessage.match(/\b(401|403|404|410|429|500|502|503|504)\b/);
  const nextHttpStatus = statusMatch ? Number(statusMatch[1]) : null;
  const nextSourceQualityScore = Math.max(0.02, source.failureStreak > 0 ? 0.12 : 0.2);
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

  const cooldownHours = deterministicHardInvalid
    ? 12
    : hardFailure
      ? nextConsecutiveFailures * 4        // 400/404/410: 4h, 8h, 12h…
      : workdayBlockedFailure
        ? nextConsecutiveFailures * 12     // Workday 403/429: 12h, 24h, 36h…
        : blockedFailure
          ? nextConsecutiveFailures * 8    // other 403/429: 8h, 16h, 24h…
          : nextFailureStreak;             // generic failures: 1h, 2h, 3h…
  const cooldownUntil = new Date(now.getTime() + cooldownHours * 60 * 60 * 1000);

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
      cooldownUntil,
      sourceQualityScore: nextSourceQualityScore,
      yieldScore: nextYieldScore,
      validationMessage: errorMessage,
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

  return cooldownUntil;
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
