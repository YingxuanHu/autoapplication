import { prisma } from "@/lib/db";
import { getScheduledConnectorSnapshot } from "@/lib/ingestion/registry";
import type {
  IngestionOverview,
  IngestionRunListItem,
  IngestionSourceCoverage,
} from "@/lib/ingestion/types";

const RECENT_RUN_LIMIT = 20;
const VISIBLE_JOB_STATUSES = ["LIVE", "AGING"] as const;
const ACTIVE_COMPANY_SOURCE_POLL_STATES = ["READY", "ACTIVE", "BACKOFF"] as const;
const INGESTION_STATUS_TTL_MS = 60_000;
const INGESTION_HEARTBEAT_TTL_MS = 30_000;
const scheduledConnectorNames = new Set(
  getScheduledConnectorSnapshot().map((source) => source.sourceName)
);
let ingestionStatusCache: { expiresAt: number; value: IngestionStatus } | null = null;
let ingestionHeartbeatCache: { expiresAt: number; value: IngestionHeartbeat } | null = null;

export type IngestionStatus = {
  /** ISO timestamp of the most recent successful ingestion run, or null if none. */
  lastUpdatedAt: string | null;
  /** Total visible active canonical jobs in the pool (LIVE + AGING, unfiltered). */
  liveJobCount: number;
  /** Number of distinct ATS platforms (e.g. Greenhouse, Lever, SmartRecruiters) that have run successfully. */
  activeSourceCount: number;
};

export type IngestionHeartbeat = Pick<IngestionStatus, "lastUpdatedAt">;

/**
 * Lightweight status query for the user-facing feed.
 * Runs 3 small queries in parallel — does NOT call getIngestionOverview.
 */
export async function getIngestionStatus(): Promise<IngestionStatus> {
  const now = Date.now();
  if (ingestionStatusCache && ingestionStatusCache.expiresAt > now) {
    return ingestionStatusCache.value;
  }

  const [lastSuccessRun, liveJobCount, activeManagedSources] = await Promise.all([
    prisma.ingestionRun.findFirst({
      where: { status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      select: { endedAt: true, startedAt: true },
    }),
    prisma.jobCanonical.count({
      where: { status: { in: [...VISIBLE_JOB_STATUSES] } },
    }),
    prisma.companySource.findMany({
      where: {
        validationState: "VALIDATED",
        pollState: { in: [...ACTIVE_COMPANY_SOURCE_POLL_STATES] },
      },
      select: { sourceName: true },
    }),
  ]);

  const activeSourceNames = new Set(scheduledConnectorNames);
  for (const source of activeManagedSources) {
    activeSourceNames.add(source.sourceName);
  }

  const value = {
    lastUpdatedAt: lastSuccessRun
      ? (lastSuccessRun.endedAt ?? lastSuccessRun.startedAt).toISOString()
      : null,
    liveJobCount,
    activeSourceCount: activeSourceNames.size,
  } satisfies IngestionStatus;

  ingestionStatusCache = {
    expiresAt: now + INGESTION_STATUS_TTL_MS,
    value,
  };

  return value;
}

export async function getIngestionHeartbeat(): Promise<IngestionHeartbeat> {
  const now = Date.now();
  if (ingestionHeartbeatCache && ingestionHeartbeatCache.expiresAt > now) {
    return ingestionHeartbeatCache.value;
  }

  const lastSuccessRun = await prisma.ingestionRun.findFirst({
    where: { status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { endedAt: true, startedAt: true },
  });

  const value = {
    lastUpdatedAt: lastSuccessRun
      ? (lastSuccessRun.endedAt ?? lastSuccessRun.startedAt).toISOString()
      : null,
  };

  ingestionHeartbeatCache = { expiresAt: now + INGESTION_HEARTBEAT_TTL_MS, value };
  return value;
}

export async function getIngestionOverview(): Promise<IngestionOverview> {
  const [
    rawCount,
    canonicalCount,
    sourceMappingCount,
    liveCount,
    agingCount,
    staleCount,
    expiredCount,
    removedCount,
    autoEligibleCount,
    reviewRequiredCount,
    manualOnlyCount,
    recentRunCount,
    allRuns,
    rawSourceCounts,
    sourceMappings,
  ] = await Promise.all([
    prisma.jobRaw.count(),
    prisma.jobCanonical.count(),
    prisma.jobSourceMapping.count(),
    prisma.jobCanonical.count({ where: { status: { in: [...VISIBLE_JOB_STATUSES] } } }),
    prisma.jobCanonical.count({ where: { status: "AGING" } }),
    prisma.jobCanonical.count({ where: { status: "STALE" } }),
    prisma.jobCanonical.count({ where: { status: "EXPIRED" } }),
    prisma.jobCanonical.count({ where: { status: "REMOVED" } }),
    prisma.jobCanonical.count({
      where: {
        status: { in: [...VISIBLE_JOB_STATUSES] },
        eligibility: { submissionCategory: "AUTO_SUBMIT_READY" },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        status: { in: [...VISIBLE_JOB_STATUSES] },
        eligibility: { submissionCategory: "AUTO_FILL_REVIEW" },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        status: { in: [...VISIBLE_JOB_STATUSES] },
        eligibility: { submissionCategory: "MANUAL_ONLY" },
      },
    }),
    prisma.ingestionRun.count(),
    prisma.ingestionRun.findMany({
      orderBy: { startedAt: "desc" },
    }),
    prisma.jobRaw.groupBy({
      by: ["sourceName"],
      _count: { _all: true },
      orderBy: { sourceName: "asc" },
    }),
    prisma.jobSourceMapping.findMany({
      select: {
        sourceName: true,
        canonicalJobId: true,
        removedAt: true,
        canonicalJob: {
          select: {
            status: true,
          },
        },
      },
    }),
  ]);

  const recentRuns = allRuns.slice(0, RECENT_RUN_LIMIT).map(serializeRun);
  const sourceCoverage = buildSourceCoverage({
    rawSourceCounts,
    sourceMappings,
    allRuns: allRuns.map(serializeRun),
  });

  return {
    rawCount,
    canonicalCount,
    sourceMappingCount,
    liveCount,
    agingCount,
    staleCount,
    expiredCount,
    removedCount,
    autoEligibleCount,
    reviewRequiredCount,
    manualOnlyCount,
    recentRunCount,
    sources: sourceCoverage,
    recentRuns,
  };
}

function serializeRun(run: {
  id: string;
  connectorKey: string;
  sourceName: string;
  sourceTier: IngestionRunListItem["sourceTier"];
  runMode: IngestionRunListItem["runMode"];
  status: IngestionRunListItem["status"];
  startedAt: Date;
  endedAt: Date | null;
  fetchedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rawCreatedCount: number;
  rawUpdatedCount: number;
  canonicalCreatedCount: number;
  canonicalUpdatedCount: number;
  dedupedCount: number;
  sourceMappingCreatedCount: number;
  sourceMappingUpdatedCount: number;
  sourceMappingsRemovedCount: number;
  liveCount: number;
  staleCount: number;
  expiredCount: number;
  removedCount: number;
  errorSummary: string | null;
}): IngestionRunListItem {
  return {
    id: run.id,
    connectorKey: run.connectorKey,
    sourceName: run.sourceName,
    sourceTier: run.sourceTier,
    runMode: run.runMode,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
    fetchedCount: run.fetchedCount,
    acceptedCount: run.acceptedCount,
    rejectedCount: run.rejectedCount,
    rawCreatedCount: run.rawCreatedCount,
    rawUpdatedCount: run.rawUpdatedCount,
    canonicalCreatedCount: run.canonicalCreatedCount,
    canonicalUpdatedCount: run.canonicalUpdatedCount,
    dedupedCount: run.dedupedCount,
    sourceMappingCreatedCount: run.sourceMappingCreatedCount,
    sourceMappingUpdatedCount: run.sourceMappingUpdatedCount,
    sourceMappingsRemovedCount: run.sourceMappingsRemovedCount,
    liveCount: run.liveCount,
    staleCount: run.staleCount,
    expiredCount: run.expiredCount,
    removedCount: run.removedCount,
    errorSummary: run.errorSummary,
  };
}

function buildSourceCoverage({
  rawSourceCounts,
  sourceMappings,
  allRuns,
}: {
  rawSourceCounts: Array<{
    sourceName: string;
    _count: { _all: number };
  }>;
  sourceMappings: Array<{
    sourceName: string;
    canonicalJobId: string;
    removedAt: Date | null;
    canonicalJob: {
      status: "LIVE" | "AGING" | "STALE" | "EXPIRED" | "REMOVED";
    };
  }>;
  allRuns: IngestionRunListItem[];
}): IngestionSourceCoverage[] {
  const scheduledSources = new Map(
    getScheduledConnectorSnapshot().map((source) => [source.sourceName, source])
  );
  const sources = new Map<string, IngestionSourceCoverage>();

  for (const scheduledSource of scheduledSources.values()) {
    sources.set(scheduledSource.sourceName, {
      sourceName: scheduledSource.sourceName,
      rawCount: 0,
      activeMappingCount: 0,
      liveCanonicalCount: 0,
      staleCanonicalCount: 0,
      removedMappingCount: 0,
      lastRunStatus: null,
      lastRunStartedAt: null,
      lastSuccessfulRunAt: null,
      scheduleCadenceMinutes: scheduledSource.cadenceMinutes,
      isScheduled: true,
    });
  }

  for (const rawSource of rawSourceCounts) {
    sources.set(rawSource.sourceName, {
      sourceName: rawSource.sourceName,
      rawCount: rawSource._count._all,
      activeMappingCount: 0,
      liveCanonicalCount: 0,
      staleCanonicalCount: 0,
      removedMappingCount: 0,
      lastRunStatus: null,
      lastRunStartedAt: null,
      lastSuccessfulRunAt: null,
      scheduleCadenceMinutes:
        scheduledSources.get(rawSource.sourceName)?.cadenceMinutes ?? null,
      isScheduled: scheduledSources.has(rawSource.sourceName),
    });
  }

  const liveCanonicalBySource = new Map<string, Set<string>>();
  const staleCanonicalBySource = new Map<string, Set<string>>();

  for (const sourceMapping of sourceMappings) {
    const source = sources.get(sourceMapping.sourceName) ?? {
      sourceName: sourceMapping.sourceName,
      rawCount: 0,
      activeMappingCount: 0,
      liveCanonicalCount: 0,
      staleCanonicalCount: 0,
      removedMappingCount: 0,
      lastRunStatus: null,
      lastRunStartedAt: null,
      lastSuccessfulRunAt: null,
      scheduleCadenceMinutes:
        scheduledSources.get(sourceMapping.sourceName)?.cadenceMinutes ?? null,
      isScheduled: scheduledSources.has(sourceMapping.sourceName),
    };

    if (sourceMapping.removedAt) {
      source.removedMappingCount += 1;
      sources.set(source.sourceName, source);
      continue;
    }

    source.activeMappingCount += 1;
    sources.set(source.sourceName, source);

    if (
      sourceMapping.canonicalJob.status === "LIVE" ||
      sourceMapping.canonicalJob.status === "AGING"
    ) {
      const liveIds = liveCanonicalBySource.get(source.sourceName) ?? new Set<string>();
      liveIds.add(sourceMapping.canonicalJobId);
      liveCanonicalBySource.set(source.sourceName, liveIds);
    }

    if (sourceMapping.canonicalJob.status === "STALE") {
      const staleIds = staleCanonicalBySource.get(source.sourceName) ?? new Set<string>();
      staleIds.add(sourceMapping.canonicalJobId);
      staleCanonicalBySource.set(source.sourceName, staleIds);
    }
  }

  for (const [sourceName, liveIds] of liveCanonicalBySource) {
    const source = sources.get(sourceName);
    if (!source) continue;
    source.liveCanonicalCount = liveIds.size;
  }

  for (const [sourceName, staleIds] of staleCanonicalBySource) {
    const source = sources.get(sourceName);
    if (!source) continue;
    source.staleCanonicalCount = staleIds.size;
  }

  const lastRunBySource = new Map<string, IngestionRunListItem>();
  const lastSuccessBySource = new Map<string, IngestionRunListItem>();

  for (const run of allRuns) {
    if (!lastRunBySource.has(run.sourceName)) {
      lastRunBySource.set(run.sourceName, run);
    }

    if (run.status === "SUCCESS" && !lastSuccessBySource.has(run.sourceName)) {
      lastSuccessBySource.set(run.sourceName, run);
    }
  }

  for (const [sourceName, run] of lastRunBySource) {
    const source = sources.get(sourceName) ?? {
      sourceName,
      rawCount: 0,
      activeMappingCount: 0,
      liveCanonicalCount: 0,
      staleCanonicalCount: 0,
      removedMappingCount: 0,
      lastRunStatus: null,
      lastRunStartedAt: null,
      lastSuccessfulRunAt: null,
      scheduleCadenceMinutes: scheduledSources.get(sourceName)?.cadenceMinutes ?? null,
      isScheduled: scheduledSources.has(sourceName),
    };

    source.lastRunStatus = run.status;
    source.lastRunStartedAt = run.startedAt;
    source.lastSuccessfulRunAt =
      lastSuccessBySource.get(sourceName)?.startedAt ?? null;
    sources.set(sourceName, source);
  }

  return [...sources.values()].sort((left, right) => {
    if (right.liveCanonicalCount !== left.liveCanonicalCount) {
      return right.liveCanonicalCount - left.liveCanonicalCount;
    }

    if (left.isScheduled !== right.isScheduled) {
      return left.isScheduled ? -1 : 1;
    }

    return left.sourceName.localeCompare(right.sourceName);
  });
}
