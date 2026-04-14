import { prisma } from "@/lib/db";
import { buildEligibilityDraft } from "@/lib/ingestion/classify";
import {
  assignCanonicalJobsToCompany,
  ensureCompanyRecord,
} from "@/lib/ingestion/company-records";
import {
  backfillCanonicalDedupeFields,
  findCrossSourceCanonicalMatch,
  isCanonicalMatchCompatible,
  type CanonicalMatchResult,
} from "@/lib/ingestion/dedupe";
import { detectDeadSignal, normalizeSourceJob } from "@/lib/ingestion/normalize";
import {
  deriveSourceIdentitySnapshot,
  deriveSourceLifecycleSnapshot,
  type SourceIdentitySnapshot,
} from "@/lib/ingestion/source-quality";
import {
  createRuntimeBudgetExceededError,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";
import type {
  IngestionSummary,
  NormalizedJobInput,
  SourceConnector,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import type {
  IngestionRunMode,
  IngestionRunStatus,
  JobStatus,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

const RUNNING_LOCK_WINDOW_MINUTES = 30;
const RUNNING_PROGRESS_STALE_MINUTES = 15;
const APPLY_URL_CHECK_INTERVAL_HOURS = 18;
const APPLY_URL_CHECK_TIMEOUT_MS = 5000;

type IngestConnectorOptions = {
  now?: Date;
  limit?: number;
  runMode?: IngestionRunMode;
  allowOverlappingRuns?: boolean;
  triggerLabel?: string;
  scheduleCadenceMinutes?: number | null;
  maxRuntimeMs?: number;
  runMetadata?: Record<string, Prisma.InputJsonValue | null>;
};

export async function previewConnectorIngestion(
  connector: SourceConnector,
  options: Pick<IngestConnectorOptions, "now" | "limit" | "runMode"> = {}
): Promise<IngestionSummary> {
  const startedAt = options.now ?? new Date();
  const runMode = options.runMode ?? "MANUAL";
  const summary = createEmptySummary(connector, {
    runId: `preview:${connector.key}`,
    runMode,
    status: "SUCCESS",
  });

  await performConnectorPreview(connector, summary, startedAt, options.limit);

  return summary;
}

type CanonicalStatusSnapshot = {
  id: string;
  applyUrl: string;
  status: JobStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSourceSeenAt: Date | null;
  lastApplyCheckAt: Date | null;
  lastConfirmedAliveAt: Date | null;
  availabilityScore: number;
  deadSignalAt: Date | null;
  deadSignalReason: string | null;
  deadline: Date | null;
  staleAt: Date | null;
  expiredAt: Date | null;
  removedAt: Date | null;
  sourceMappings: Array<{
    id: string;
    sourceName: string;
    sourceType: string | null;
    sourceReliability: number;
    isFullSnapshot: boolean;
    pollPattern: string | null;
    lastSeenAt: Date;
    removedAt: Date | null;
  }>;
};

type CanonicalStatusRefreshResult = {
  status: JobStatus;
  updated: boolean;
};

type CanonicalStatusTally = {
  liveCount: number;
  agingCount: number;
  staleCount: number;
  expiredCount: number;
  removedCount: number;
  updatedCount: number;
};

export async function ingestConnector(
  connector: SourceConnector,
  options: IngestConnectorOptions = {}
): Promise<IngestionSummary> {
  const startedAt = options.now ?? new Date();
  const runMode = options.runMode ?? "MANUAL";
  const startingCheckpoint = await loadResumeCheckpoint(connector.key);
  const runOptionsState = buildRunOptions(options, startingCheckpoint);
  if (typeof options.maxRuntimeMs === "number" && options.maxRuntimeMs > 0) {
    runOptionsState.leaseExpiresAt = new Date(
      startedAt.getTime() + options.maxRuntimeMs
    ).toISOString();
  }
  const run = await createIngestionRun({
    connector,
    startedAt,
    runMode,
    runOptions: runOptionsState,
    allowOverlappingRuns: options.allowOverlappingRuns ?? false,
  });

  const summary = createEmptySummary(connector, {
    runId: run.id,
    runMode,
    status: run.status,
  });

  if (run.status === "SKIPPED") {
    summary.skippedReasons.overlapping_run = 1;
    return summary;
  }

  try {
    let lastHeartbeatAt = Date.now();
    const persistCheckpoint = async (checkpoint: Prisma.InputJsonValue | null) => {
      runOptionsState.checkpoint = checkpoint;
      runOptionsState.checkpointUpdatedAt = new Date().toISOString();
      runOptionsState.checkpointExhausted = false;
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          runOptions: runOptionsState as Prisma.InputJsonValue,
        },
      });
    };
    const persistHeartbeat = async (
      details: Record<string, Prisma.InputJsonValue | null> = {}
    ) => {
      const nowMs = Date.now();
      if (nowMs - lastHeartbeatAt < 15_000) {
        return;
      }

      lastHeartbeatAt = nowMs;
      runOptionsState.checkpointUpdatedAt = new Date(nowMs).toISOString();
      const existingMetadata = (asJsonObject(
        runOptionsState.runMetadata as Prisma.JsonValue | null
      ) ?? {}) as Record<string, Prisma.InputJsonValue | null>;
      runOptionsState.runMetadata = {
        ...existingMetadata,
        ...details,
        heartbeatAt: runOptionsState.checkpointUpdatedAt,
      };

      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          runOptions: runOptionsState as Prisma.InputJsonValue,
        },
      });
    };
    const runtimeController =
      typeof options.maxRuntimeMs === "number" && options.maxRuntimeMs > 0
        ? new AbortController()
        : null;
    const runtimeBudgetMs =
      typeof options.maxRuntimeMs === "number" && options.maxRuntimeMs > 0
        ? options.maxRuntimeMs
        : null;
    const runtimeTimer =
      runtimeController && runtimeBudgetMs != null
        ? setTimeout(() => {
            runtimeController.abort(
              createRuntimeBudgetExceededError(
                runtimeBudgetMs,
                connector.sourceName
              )
            );
          }, runtimeBudgetMs)
        : null;
    runtimeTimer?.unref?.();

    await backfillCanonicalDedupeFields();
    try {
      await performConnectorIngestion(
        connector,
        summary,
        startedAt,
        options.limit,
        runtimeController?.signal,
        options.maxRuntimeMs,
        startingCheckpoint,
        persistCheckpoint,
        createConnectorLogger(connector, runOptionsState.runMetadata),
        persistHeartbeat
      );
    } finally {
      if (runtimeTimer) clearTimeout(runtimeTimer);
    }
    summary.status = "SUCCESS";
    runOptionsState.checkpoint = summary.checkpoint ?? null;
    runOptionsState.checkpointUpdatedAt = new Date().toISOString();
    runOptionsState.checkpointExhausted = summary.checkpointExhausted ?? false;
    runOptionsState.resultMetrics = buildRunResultMetrics(summary);

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: buildRunUpdateData(
        summary,
        "SUCCESS",
        new Date(),
        null,
        runOptionsState as Prisma.InputJsonValue
      ),
    });

    return summary;
  } catch (error) {
    summary.status = "FAILED";
    runOptionsState.checkpoint = summary.checkpoint ?? runOptionsState.checkpoint ?? null;
    runOptionsState.checkpointUpdatedAt = new Date().toISOString();
    runOptionsState.checkpointExhausted = summary.checkpointExhausted ?? false;
    runOptionsState.resultMetrics = buildRunResultMetrics(summary);

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: buildRunUpdateData(
        summary,
        "FAILED",
        new Date(),
        getErrorSummary(error),
        runOptionsState as Prisma.InputJsonValue
      ),
    });

    throw error;
  }
}

export async function recoverStaleRunningIngestionRuns(options: {
  now?: Date;
  connectorKeys?: string[];
} = {}) {
  const now = options.now ?? new Date();
  const staleStartedBefore = new Date(
    now.getTime() - RUNNING_LOCK_WINDOW_MINUTES * 60 * 1000
  );
  const staleCheckpointBefore = new Date(
    now.getTime() - RUNNING_PROGRESS_STALE_MINUTES * 60 * 1000
  );

  const runningRuns = await prisma.ingestionRun.findMany({
    where: {
      status: "RUNNING",
      ...(options.connectorKeys && options.connectorKeys.length > 0
        ? {
            connectorKey: {
              in: options.connectorKeys,
            },
          }
        : {}),
    },
    select: {
      id: true,
      connectorKey: true,
      sourceName: true,
      startedAt: true,
      runOptions: true,
    },
  });

  const staleRuns = runningRuns.filter((run) => {
    const runOptions = asJsonObject(run.runOptions);
    const leaseExpiresAtRaw = runOptions?.leaseExpiresAt;
    const explicitLeaseExpiresAt =
      typeof leaseExpiresAtRaw === "string" ? new Date(leaseExpiresAtRaw) : null;
    const maxRuntimeMsRaw = runOptions?.maxRuntimeMs;
    const maxRuntimeMs =
      typeof maxRuntimeMsRaw === "number"
        ? maxRuntimeMsRaw
        : typeof maxRuntimeMsRaw === "string"
          ? Number(maxRuntimeMsRaw)
          : null;
    const inferredLeaseExpiresAt =
      maxRuntimeMs && Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0
        ? new Date(run.startedAt.getTime() + maxRuntimeMs)
        : null;
    const leaseExpiresAt =
      explicitLeaseExpiresAt &&
      !Number.isNaN(explicitLeaseExpiresAt.getTime())
        ? explicitLeaseExpiresAt
        : inferredLeaseExpiresAt;
    const checkpointUpdatedAtRaw = runOptions?.checkpointUpdatedAt;
    const checkpointUpdatedAt =
      typeof checkpointUpdatedAtRaw === "string"
        ? new Date(checkpointUpdatedAtRaw)
        : null;

    if (
      leaseExpiresAt &&
      !Number.isNaN(leaseExpiresAt.getTime()) &&
      leaseExpiresAt < now
    ) {
      return true;
    }

    if (
      checkpointUpdatedAt &&
      !Number.isNaN(checkpointUpdatedAt.getTime()) &&
      checkpointUpdatedAt < staleCheckpointBefore
    ) {
      return true;
    }

    return run.startedAt < staleStartedBefore;
  });

  if (staleRuns.length === 0) {
    return {
      recoveredCount: 0,
      connectorKeys: [] as string[],
    };
  }

  await prisma.$transaction(
    staleRuns.map((run) => {
      const runOptions = asJsonObject(run.runOptions) ?? {};
      const existingMetadata = asJsonObject(runOptions.runMetadata) ?? {};

      return prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          endedAt: now,
          errorSummary:
            "STALE_RECOVERED: recovered stale RUNNING ingestion run before scheduling.",
          runOptions: {
            ...runOptions,
            runMetadata: {
              ...existingMetadata,
              staleRunRecoveredAt: now.toISOString(),
            },
          } satisfies Prisma.InputJsonValue,
        },
      });
    })
  );

  return {
    recoveredCount: staleRuns.length,
    connectorKeys: [...new Set(staleRuns.map((run) => run.connectorKey))],
  };
}

export async function reconcileCanonicalLifecycle(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const canonicalJobs = await prisma.jobCanonical.findMany({
    select: { id: true },
  });

  return refreshCanonicalStatuses(
    canonicalJobs.map((job) => job.id),
    now
  );
}

/**
 * Fast bulk status sync — O(1) DB operations instead of N+1.
 *
 * Syncs `status` to match the stored `availabilityScore` for all non-REMOVED
 * jobs using a single SQL UPDATE.  Then runs the full per-job reconcile for a
 * limited cohort of at-risk jobs (AGING/STALE) so that freshness timestamps,
 * apply-URL checks, and expiry transitions are still applied incrementally.
 *
 * This replaces `reconcileCanonicalLifecycle` in daemon cycles where
 * processing all 300k+ jobs per cycle is too slow.
 */
export async function bulkSyncCanonicalStatuses(options: {
  now?: Date;
  /** Max number of AGING/STALE jobs to run the full per-job refresh on. Default 3000. */
  perJobLimit?: number;
} = {}) {
  const now = options.now ?? new Date();
  const perJobLimit = options.perJobLimit ?? 3_000;

  // 1. Bulk SQL status sync based on stored availabilityScore.
  //    Also applies the confirmation floor inline: a URL-confirmed-alive job within
  //    3 days always has its availabilityScore bumped to at least 72 (LIVE floor from
  //    getRecentAliveConfirmationFloor), so status correctly reflects the confirmation.
  //    This avoids needing a per-job refresh for every recently-confirmed job.
  //    REMOVED jobs are never touched.
  const syncResult = await prisma.$executeRaw`
    UPDATE "JobCanonical"
    SET
      "availabilityScore" = CASE
        WHEN "lastConfirmedAliveAt" >= NOW() - INTERVAL '3 days'
          THEN GREATEST("availabilityScore", 72)
        ELSE "availabilityScore"
      END,
      status = CASE
        WHEN "lastConfirmedAliveAt" >= NOW() - INTERVAL '3 days' THEN 'LIVE'::"JobStatus"
        WHEN "availabilityScore" >= 72 THEN 'LIVE'::"JobStatus"
        WHEN "availabilityScore" >= 48 THEN 'AGING'::"JobStatus"
        WHEN "availabilityScore" >= 22 THEN 'STALE'::"JobStatus"
        ELSE                                'EXPIRED'::"JobStatus"
      END
    WHERE status != 'REMOVED'::"JobStatus"
  `;

  // 2. Incremental per-job refresh for AGING/STALE cohort — these are most
  //    likely to transition and need freshness/expiry logic applied.
  const atRiskJobs = await prisma.jobCanonical.findMany({
    where: { status: { in: ["AGING", "STALE"] } },
    select: { id: true },
    orderBy: { lastApplyCheckAt: "asc" }, // oldest-checked first
    take: perJobLimit,
  });

  const tally = await refreshCanonicalStatuses(
    atRiskJobs.map((j) => j.id),
    now
  );

  // Build aggregate counts for the full pool (cheap count queries).
  const [liveCount, agingCount, staleCount, expiredCount] = await Promise.all([
    prisma.jobCanonical.count({ where: { status: "LIVE" } }),
    prisma.jobCanonical.count({ where: { status: "AGING" } }),
    prisma.jobCanonical.count({ where: { status: "STALE" } }),
    prisma.jobCanonical.count({ where: { status: "EXPIRED" } }),
  ]);

  return {
    liveCount,
    agingCount,
    staleCount,
    expiredCount,
    removedCount: 0,
    updatedCount: (syncResult as number) + tally.updatedCount,
  };
}

export async function reconcileCanonicalLifecycleByIds(
  canonicalIds: string[],
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  return refreshCanonicalStatuses(canonicalIds, now);
}

async function createIngestionRun({
  connector,
  startedAt,
  runMode,
  runOptions,
  allowOverlappingRuns,
}: {
  connector: SourceConnector;
  startedAt: Date;
  runMode: IngestionRunMode;
  runOptions: Prisma.InputJsonValue;
  allowOverlappingRuns: boolean;
}) {
  if (!allowOverlappingRuns) {
    const overlapCutoff = new Date(
      startedAt.getTime() - RUNNING_LOCK_WINDOW_MINUTES * 60 * 1000
    );

    const overlappingRun = await prisma.ingestionRun.findFirst({
      where: {
        connectorKey: connector.key,
        status: "RUNNING",
        startedAt: { gte: overlapCutoff },
      },
      orderBy: { startedAt: "desc" },
    });

    if (overlappingRun) {
      return prisma.ingestionRun.create({
        data: {
          connectorKey: connector.key,
          sourceName: connector.sourceName,
          sourceTier: connector.sourceTier,
          runMode,
          status: "SKIPPED",
          startedAt,
          endedAt: startedAt,
          runOptions,
          errorSummary: `Skipped due to overlapping run ${overlappingRun.id}`,
        },
      });
    }
  }

  return prisma.ingestionRun.create({
    data: {
      connectorKey: connector.key,
      sourceName: connector.sourceName,
      sourceTier: connector.sourceTier,
      runMode,
      status: "RUNNING",
      startedAt,
      runOptions,
    },
  });
}

async function performConnectorIngestion(
  connector: SourceConnector,
  summary: IngestionSummary,
  now: Date,
  limit?: number,
  signal?: AbortSignal,
  maxRuntimeMs?: number,
  checkpoint?: Prisma.InputJsonValue | null,
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void>,
  log?: (message: string) => void,
  onHeartbeat?: (details?: Record<string, Prisma.InputJsonValue | null>) => Promise<void>
) {
  const seenSourceIds = new Set<string>();
  const freshnessCandidateIds = new Set<string>();

  throwIfAborted(signal);

  const fetchResultPromise = connector.fetchJobs({
    now,
    limit,
    signal,
    maxRuntimeMs,
    checkpoint,
    onCheckpoint,
    log,
    deadlineAt:
      typeof maxRuntimeMs === "number" ? new Date(now.getTime() + maxRuntimeMs) : undefined,
  });
  const fetchResult =
    typeof maxRuntimeMs === "number" && maxRuntimeMs > 0
      ? await Promise.race([
          fetchResultPromise,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              reject(
                createRuntimeBudgetExceededError(
                  maxRuntimeMs,
                  connector.sourceName
                )
              );
            }, maxRuntimeMs);
            timer.unref?.();
            signal?.addEventListener(
              "abort",
              () => clearTimeout(timer),
              { once: true }
            );
          }),
        ])
      : await fetchResultPromise;
  const fetchExhausted = fetchResult.exhausted ?? fetchResult.checkpoint == null;
  summary.checkpoint = fetchResult.checkpoint ?? null;
  summary.checkpointExhausted = fetchExhausted;
  await onHeartbeat?.({
    checkpointExhausted: summary.checkpointExhausted ?? false,
    fetchedCount: fetchResult.jobs.length,
    stage: "fetch_complete",
  });

  let processedCount = 0;
  for (const sourceJob of fetchResult.jobs) {
    throwIfAborted(signal);
    summary.fetchedCount += 1;
    seenSourceIds.add(sourceJob.sourceId);

    const rawJobResult = await upsertRawJob({
      connector,
      sourceJob,
      fetchedAt: now,
    });

    if (rawJobResult.created) {
      summary.rawCreatedCount += 1;
    } else {
      summary.rawUpdatedCount += 1;
    }

    const normalizationResult = normalizeSourceJob({
      job: sourceJob,
      fetchedAt: now,
    });

    if (normalizationResult.kind === "rejected") {
      summary.rejectedCount += 1;
      summary.skippedReasons[normalizationResult.reason] =
        (summary.skippedReasons[normalizationResult.reason] ?? 0) + 1;
      if (normalizationResult.reason === "obvious_dead_at_intake") {
        const deadSignal = detectDeadSignal({
          title: sourceJob.title,
          description: sourceJob.description,
          deadline: sourceJob.deadline,
          fetchedAt: now,
        });
        const deadResult = await markMappedJobAsDead({
          rawJobId: rawJobResult.rawJob.id,
          now,
          reason: deadSignal.reason ?? "Explicit dead signal detected during source refresh.",
        });
        if (deadResult.canonicalId) {
          freshnessCandidateIds.add(deadResult.canonicalId);
        }
      }
      processedCount += 1;
      if (processedCount % 25 === 0) {
        await onHeartbeat?.({
          acceptedCount: summary.acceptedCount,
          fetchedCount: summary.fetchedCount,
          processedCount,
          rejectedCount: summary.rejectedCount,
          stage: "processing",
        });
      }
      continue;
    }

    summary.acceptedCount += 1;
    summary.minimallyAcceptedCount += 1;
    if (isCanadaJob(normalizationResult.job)) {
      summary.acceptedCanadaCount += 1;
      if (isCanadaRemoteJob(normalizationResult.job)) {
        summary.acceptedCanadaRemoteCount += 1;
      }
    }

    const sourceIdentity = deriveSourceIdentitySnapshot({
      sourceName: connector.sourceName,
      sourceId: sourceJob.sourceId,
      sourceUrl: sourceJob.sourceUrl,
      applyUrl: normalizationResult.job.applyUrl,
      metadata: sourceJob.metadata,
    });
    const sourceLifecycle = deriveSourceLifecycleSnapshot({
      sourceName: connector.sourceName,
      sourceUrl: sourceJob.sourceUrl,
      applyUrl: normalizationResult.job.applyUrl,
      freshnessMode: connector.freshnessMode,
    });

    const mappedCanonical = await findMappedCanonical(rawJobResult.rawJob.id);
    const compatibleMappedCanonical =
      mappedCanonical &&
      isCanonicalMatchCompatible(normalizationResult.job, mappedCanonical.canonical)
        ? mappedCanonical
        : null;
    const crossSourceMatch = compatibleMappedCanonical
      ? null
      : await findCrossSourceCanonicalMatch(normalizationResult.job, sourceIdentity);
    const canonicalMatch = compatibleMappedCanonical ?? crossSourceMatch;

    if (canonicalMatch && canonicalMatch.matchedBy !== "rawJob") {
      summary.dedupedCount += 1;
    }

    const canonicalResult = await upsertCanonicalJob({
      currentCanonicalId: canonicalMatch?.canonical.id ?? null,
      normalizedJob: normalizationResult.job,
      sourceIdentity,
      sourceUrl: sourceJob.sourceUrl,
      rawApplyUrl: sourceJob.applyUrl,
      now,
    });

    freshnessCandidateIds.add(canonicalResult.id);

    if (canonicalResult.created) {
      summary.canonicalCreatedCount += 1;
      if (isCanadaJob(normalizationResult.job)) {
        summary.canonicalCreatedCanadaCount += 1;
        if (isCanadaRemoteJob(normalizationResult.job)) {
          summary.canonicalCreatedCanadaRemoteCount += 1;
        }
      }
    } else {
      summary.canonicalUpdatedCount += 1;
    }

    const mappingResult = await upsertSourceMapping({
      canonicalId: canonicalResult.id,
      connector,
      rawJobId: rawJobResult.rawJob.id,
      sourceUrl: sourceJob.sourceUrl,
      sourceIdentity,
      sourceLifecycle,
      canonicalMatch,
      now,
    });

    if (mappingResult.created) {
      summary.sourceMappingCreatedCount += 1;
    } else {
      summary.sourceMappingUpdatedCount += 1;
    }

    if (mappingResult.previousCanonicalId) {
      freshnessCandidateIds.add(mappingResult.previousCanonicalId);
    }

    await upsertEligibility(canonicalResult.id, normalizationResult.job, connector.sourceName);
    processedCount += 1;
    if (processedCount % 25 === 0) {
      await onHeartbeat?.({
        acceptedCount: summary.acceptedCount,
        canonicalCreatedCount: summary.canonicalCreatedCount,
        fetchedCount: summary.fetchedCount,
        processedCount,
        rejectedCount: summary.rejectedCount,
        stage: "processing",
      });
    }
  }

  const shouldRunFreshnessRemoval =
    connector.freshnessMode === "FULL_SNAPSHOT" &&
    limit === undefined &&
    fetchExhausted;

  if (shouldRunFreshnessRemoval) {
    const removalResult = await markMissingSourceMappingsRemoved({
      connectorSourceName: connector.sourceName,
      seenSourceIds: [...seenSourceIds],
      now,
    });

    summary.sourceMappingsRemovedCount = removalResult.removedMappingCount;

    for (const canonicalId of removalResult.canonicalIds) {
      await refreshPrimarySourceMapping(canonicalId);
      freshnessCandidateIds.add(canonicalId);
    }
  }

  const statusTally = await refreshCanonicalStatuses([...freshnessCandidateIds], now);
  summary.liveCount = statusTally.liveCount;
  summary.visibleLiveCount = statusTally.liveCount;
  summary.staleCount = statusTally.staleCount;
  summary.expiredCount = statusTally.expiredCount;
  summary.removedCount = statusTally.removedCount;
  await onHeartbeat?.({
    acceptedCount: summary.acceptedCount,
    fetchedCount: summary.fetchedCount,
    processedCount,
    stage: "complete",
  });
}

async function performConnectorPreview(
  connector: SourceConnector,
  summary: IngestionSummary,
  now: Date,
  limit?: number
) {
  const fetchResult = await connector.fetchJobs({
    now,
    limit,
    log: createConnectorLogger(connector, null),
  });

  for (const sourceJob of fetchResult.jobs) {
    summary.fetchedCount += 1;

    const existingRawJob = await prisma.jobRaw.findUnique({
      where: {
        sourceName_sourceId: {
          sourceName: connector.sourceName,
          sourceId: sourceJob.sourceId,
        },
      },
      select: { id: true },
    });

    if (existingRawJob) {
      summary.rawUpdatedCount += 1;
    } else {
      summary.rawCreatedCount += 1;
    }

    const normalizationResult = normalizeSourceJob({
      job: sourceJob,
      fetchedAt: now,
    });

    if (normalizationResult.kind === "rejected") {
      summary.rejectedCount += 1;
      summary.skippedReasons[normalizationResult.reason] =
        (summary.skippedReasons[normalizationResult.reason] ?? 0) + 1;
      continue;
    }

    summary.acceptedCount += 1;
    summary.minimallyAcceptedCount += 1;
    if (isCanadaJob(normalizationResult.job)) {
      summary.acceptedCanadaCount += 1;
      if (isCanadaRemoteJob(normalizationResult.job)) {
        summary.acceptedCanadaRemoteCount += 1;
      }
    }

    const sourceIdentity = deriveSourceIdentitySnapshot({
      sourceName: connector.sourceName,
      sourceId: sourceJob.sourceId,
      sourceUrl: sourceJob.sourceUrl,
      applyUrl: normalizationResult.job.applyUrl,
      metadata: sourceJob.metadata,
    });

    const mappedCanonical = existingRawJob
      ? await findMappedCanonical(existingRawJob.id)
      : null;
    const compatibleMappedCanonical =
      mappedCanonical &&
      isCanonicalMatchCompatible(normalizationResult.job, mappedCanonical.canonical)
        ? mappedCanonical
        : null;
    const crossSourceMatch = compatibleMappedCanonical
      ? null
      : await findCrossSourceCanonicalMatch(normalizationResult.job, sourceIdentity);
    const canonicalMatch = compatibleMappedCanonical ?? crossSourceMatch;

    if (canonicalMatch && canonicalMatch.matchedBy !== "rawJob") {
      summary.dedupedCount += 1;
    }

    if (canonicalMatch) {
      summary.canonicalUpdatedCount += 1;
    } else {
      summary.canonicalCreatedCount += 1;
      if (isCanadaJob(normalizationResult.job)) {
        summary.canonicalCreatedCanadaCount += 1;
        if (isCanadaRemoteJob(normalizationResult.job)) {
          summary.canonicalCreatedCanadaRemoteCount += 1;
        }
      }
    }

    const existingMapping = existingRawJob
      ? await prisma.jobSourceMapping.findFirst({
          where: { rawJobId: existingRawJob.id },
          select: { id: true },
        })
      : null;

    if (existingMapping) {
      summary.sourceMappingUpdatedCount += 1;
    } else {
      summary.sourceMappingCreatedCount += 1;
    }
  }
}

function createEmptySummary(
  connector: SourceConnector,
  run: {
    runId: string;
    runMode: IngestionRunMode;
    status: IngestionRunStatus;
  }
): IngestionSummary {
  return {
    runId: run.runId,
    runMode: run.runMode,
    status: run.status,
    connectorKey: connector.key,
    sourceName: connector.sourceName,
    sourceTier: connector.sourceTier,
    freshnessMode: connector.freshnessMode,
    fetchedCount: 0,
    minimallyAcceptedCount: 0,
    acceptedCount: 0,
    acceptedCanadaCount: 0,
    acceptedCanadaRemoteCount: 0,
    rejectedCount: 0,
    rawCreatedCount: 0,
    rawUpdatedCount: 0,
    canonicalCreatedCount: 0,
    canonicalCreatedCanadaCount: 0,
    canonicalCreatedCanadaRemoteCount: 0,
    canonicalUpdatedCount: 0,
    dedupedCount: 0,
    sourceMappingCreatedCount: 0,
    sourceMappingUpdatedCount: 0,
    sourceMappingsRemovedCount: 0,
    visibleLiveCount: 0,
    liveCount: 0,
    staleCount: 0,
    expiredCount: 0,
    removedCount: 0,
    skippedReasons: {},
    checkpoint: null,
    checkpointExhausted: false,
  };
}

function createConnectorLogger(
  connector: SourceConnector,
  runMetadata: Prisma.InputJsonValue | null
) {
  const metadata = asJsonObject(runMetadata as Prisma.JsonValue | null);

  return (message: string) => {
    const origin =
      typeof metadata?.origin === "string" ? metadata.origin : "manual";
    const companySourceId =
      typeof metadata?.companySourceId === "string"
        ? metadata.companySourceId
        : null;
    const registryKey =
      typeof metadata?.registryKey === "string" ? metadata.registryKey : null;
    const validationState =
      typeof metadata?.validationState === "string"
        ? metadata.validationState
        : null;

    const tags = [
      `origin=${origin}`,
      registryKey ? `registryKey=${registryKey}` : null,
      companySourceId ? `companySourceId=${companySourceId}` : null,
      validationState ? `validationState=${validationState}` : null,
      `source=${connector.sourceName}`,
    ].filter(Boolean);

    console.log(`[connector:${connector.key}] [${tags.join(" ")}] ${message}`);
  };
}

function buildRunOptions(
  options: Omit<IngestConnectorOptions, "now" | "runMode">,
  checkpoint: Prisma.InputJsonValue | null
): Record<string, Prisma.InputJsonValue | null> {
  return {
    limit: options.limit ?? null,
    triggerLabel: options.triggerLabel ?? null,
    scheduleCadenceMinutes: options.scheduleCadenceMinutes ?? null,
    maxRuntimeMs: options.maxRuntimeMs ?? null,
    runMetadata: options.runMetadata ?? null,
    checkpoint,
    checkpointUpdatedAt: checkpoint ? new Date().toISOString() : null,
    checkpointExhausted: checkpoint == null,
    resultMetrics: null,
  };
}

function buildRunUpdateData(
  summary: IngestionSummary,
  status: IngestionRunStatus,
  endedAt: Date,
  errorSummary: string | null,
  runOptions: Prisma.InputJsonValue
) {
  return {
    status,
    endedAt,
    fetchedCount: summary.fetchedCount,
    acceptedCount: summary.acceptedCount,
    rejectedCount: summary.rejectedCount,
    rawCreatedCount: summary.rawCreatedCount,
    rawUpdatedCount: summary.rawUpdatedCount,
    canonicalCreatedCount: summary.canonicalCreatedCount,
    canonicalUpdatedCount: summary.canonicalUpdatedCount,
    dedupedCount: summary.dedupedCount,
    sourceMappingCreatedCount: summary.sourceMappingCreatedCount,
    sourceMappingUpdatedCount: summary.sourceMappingUpdatedCount,
    sourceMappingsRemovedCount: summary.sourceMappingsRemovedCount,
    liveCount: summary.liveCount,
    staleCount: summary.staleCount,
    expiredCount: summary.expiredCount,
    removedCount: summary.removedCount,
    skippedReasons: summary.skippedReasons as Prisma.InputJsonValue,
    runOptions,
    errorSummary,
  } satisfies Prisma.IngestionRunUncheckedUpdateInput;
}

async function loadResumeCheckpoint(connectorKey: string) {
  const recentRuns = await prisma.ingestionRun.findMany({
    where: { connectorKey },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: {
      runOptions: true,
    },
  });

  for (const run of recentRuns) {
    const options = asJsonObject(run.runOptions);
    if (!options) continue;
    const exhausted = options.checkpointExhausted;
    const checkpoint = options.checkpoint;
    if (exhausted === true) return null;
    if (checkpoint !== undefined && checkpoint !== null) {
      return checkpoint as Prisma.InputJsonValue;
    }
  }

  return null;
}

function buildRunResultMetrics(summary: IngestionSummary) {
  return {
    minimallyAcceptedCount: summary.minimallyAcceptedCount,
    acceptedCanadaCount: summary.acceptedCanadaCount,
    acceptedCanadaRemoteCount: summary.acceptedCanadaRemoteCount,
    canonicalCreatedCanadaCount: summary.canonicalCreatedCanadaCount,
    canonicalCreatedCanadaRemoteCount: summary.canonicalCreatedCanadaRemoteCount,
    visibleLiveCount: summary.visibleLiveCount,
  } satisfies Record<string, Prisma.InputJsonValue | null>;
}

function asJsonObject(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, Prisma.JsonValue | null>;
}

function isCanadaJob(job: NormalizedJobInput) {
  return job.region === "CA";
}

function isCanadaRemoteJob(job: NormalizedJobInput) {
  return job.region === "CA" && job.workMode === "REMOTE";
}

async function upsertRawJob({
  connector,
  sourceJob,
  fetchedAt,
}: {
  connector: SourceConnector;
  sourceJob: SourceConnectorJob;
  fetchedAt: Date;
}) {
  const existingRawJob = await prisma.jobRaw.findUnique({
    where: {
      sourceName_sourceId: {
        sourceName: connector.sourceName,
        sourceId: sourceJob.sourceId,
      },
    },
  });

  const data = {
    sourceId: sourceJob.sourceId,
    sourceName: connector.sourceName,
    sourceTier: connector.sourceTier,
    fetchedAt,
    rawPayload: buildRawPayload(sourceJob, fetchedAt),
  } satisfies Prisma.JobRawUncheckedCreateInput;

  if (existingRawJob) {
    const rawJob = await prisma.jobRaw.update({
      where: { id: existingRawJob.id },
      data,
    });
    return { rawJob, created: false as const };
  }

  const rawJob = await prisma.jobRaw.create({ data });
  return { rawJob, created: true as const };
}

async function findMappedCanonical(rawJobId: string) {
  const mappingMatch = await prisma.jobSourceMapping.findFirst({
    where: { rawJobId },
    include: {
      canonicalJob: {
        select: canonicalMatchSelect,
      },
    },
  });

  if (!mappingMatch) return null;

  return {
    matchedBy: "rawJob" as const,
    canonical: mappingMatch.canonicalJob,
    score: 100,
    evidence: {},
  };
}

const canonicalMatchSelect = {
  id: true,
  applyUrl: true,
  description: true,
  shortSummary: true,
  postedAt: true,
  deadline: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  companyKey: true,
  titleKey: true,
  titleCoreKey: true,
  descriptionFingerprint: true,
  locationKey: true,
  applyUrlKey: true,
  roleFamily: true,
  workMode: true,
} as const;

async function upsertCanonicalJob({
  currentCanonicalId,
  normalizedJob,
  sourceIdentity,
  sourceUrl,
  rawApplyUrl,
  now,
}: {
  currentCanonicalId: string | null;
  normalizedJob: NormalizedJobInput;
  sourceIdentity: SourceIdentitySnapshot;
  sourceUrl: string | null;
  rawApplyUrl: string | null;
  now: Date;
}) {
  const companyRecord = await ensureCompanyRecord({
    companyName: normalizedJob.company,
    companyKey: normalizedJob.companyKey,
    urls: [sourceUrl, rawApplyUrl, normalizedJob.applyUrl],
  });

  if (!currentCanonicalId) {
    const canonicalJob = await prisma.jobCanonical.create({
      data: {
        ...normalizedJob,
        companyId: companyRecord.id,
        status: "LIVE",
        firstSeenAt: now,
        lastSeenAt: now,
        lastSourceSeenAt: now,
        lastApplyCheckAt: null,
        lastConfirmedAliveAt: now,
        availabilityScore: 100,
        deadSignalAt: null,
        deadSignalReason: null,
        staleAt: null,
        expiredAt: null,
        removedAt: null,
      },
    });

    await assignCanonicalJobsToCompany(companyRecord.id, normalizedJob.companyKey);

    return {
      id: canonicalJob.id,
      created: true as const,
    };
  }

  const currentCanonical = await prisma.jobCanonical.findUniqueOrThrow({
    where: { id: currentCanonicalId },
    select: {
      id: true,
      companyId: true,
      title: true,
      company: true,
      companyKey: true,
      titleKey: true,
      titleCoreKey: true,
      descriptionFingerprint: true,
      location: true,
      locationKey: true,
      region: true,
      workMode: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      employmentType: true,
      experienceLevel: true,
      description: true,
      shortSummary: true,
      industry: true,
      roleFamily: true,
      applyUrl: true,
      applyUrlKey: true,
      postedAt: true,
      deadline: true,
      duplicateClusterId: true,
      availabilityScore: true,
      sourceMappings: {
        where: {
          removedAt: null,
          isPrimary: true,
        },
        select: {
          sourceQualityRank: true,
        },
        take: 1,
      },
    },
  });

  const currentPrimaryRank = currentCanonical.sourceMappings[0]?.sourceQualityRank ?? 0;
  const preferIncomingSource = sourceIdentity.sourceQualityRank >= currentPrimaryRank;
  const incomingHasSalary =
    normalizedJob.salaryMin != null || normalizedJob.salaryMax != null;
  const currentHasSalary =
    currentCanonical.salaryMin != null || currentCanonical.salaryMax != null;
  const useIncomingSalary = (preferIncomingSource && incomingHasSalary) || !currentHasSalary;

  const canonicalJob = await prisma.jobCanonical.update({
    where: { id: currentCanonical.id },
    data: {
      companyId: currentCanonical.companyId ?? companyRecord.id,
      title: chooseCanonicalStringValue({
        currentValue: currentCanonical.title,
        nextValue: normalizedJob.title,
        preferNext: preferIncomingSource,
      }),
      company: chooseCanonicalStringValue({
        currentValue: currentCanonical.company,
        nextValue: normalizedJob.company,
        preferNext: preferIncomingSource,
        unknownValues: ["Unknown"],
      }),
      companyKey: chooseCanonicalStringValue({
        currentValue: currentCanonical.companyKey,
        nextValue: normalizedJob.companyKey,
        preferNext: preferIncomingSource,
      }),
      titleKey: chooseCanonicalStringValue({
        currentValue: currentCanonical.titleKey,
        nextValue: normalizedJob.titleKey,
        preferNext: preferIncomingSource,
      }),
      titleCoreKey: chooseCanonicalStringValue({
        currentValue: currentCanonical.titleCoreKey,
        nextValue: normalizedJob.titleCoreKey,
        preferNext: preferIncomingSource,
      }),
      descriptionFingerprint: chooseCanonicalStringValue({
        currentValue: currentCanonical.descriptionFingerprint,
        nextValue: normalizedJob.descriptionFingerprint,
        preferNext: preferIncomingSource,
      }),
      location: chooseCanonicalStringValue({
        currentValue: currentCanonical.location,
        nextValue: normalizedJob.location,
        preferNext: preferIncomingSource,
        unknownValues: ["Unknown"],
      }),
      locationKey: chooseCanonicalStringValue({
        currentValue: currentCanonical.locationKey,
        nextValue: normalizedJob.locationKey,
        preferNext: preferIncomingSource,
      }),
      region: chooseCanonicalNullableValue({
        currentValue: currentCanonical.region,
        nextValue: normalizedJob.region,
        preferNext: preferIncomingSource,
      }),
      workMode: chooseCanonicalEnumValue({
        currentValue: currentCanonical.workMode,
        nextValue: normalizedJob.workMode,
        preferNext: preferIncomingSource,
        unknownValue: "UNKNOWN",
      }),
      salaryMin: useIncomingSalary ? normalizedJob.salaryMin : currentCanonical.salaryMin,
      salaryMax: useIncomingSalary ? normalizedJob.salaryMax : currentCanonical.salaryMax,
      salaryCurrency: useIncomingSalary
        ? normalizedJob.salaryCurrency ?? currentCanonical.salaryCurrency
        : currentCanonical.salaryCurrency ?? normalizedJob.salaryCurrency,
      employmentType: chooseCanonicalEnumValue({
        currentValue: currentCanonical.employmentType,
        nextValue: normalizedJob.employmentType,
        preferNext: preferIncomingSource,
        unknownValue: "UNKNOWN",
      }),
      experienceLevel: chooseCanonicalEnumValue({
        currentValue: currentCanonical.experienceLevel,
        nextValue: normalizedJob.experienceLevel,
        preferNext: preferIncomingSource,
        unknownValue: "UNKNOWN",
      }),
      description: chooseCanonicalDescription({
        currentValue: currentCanonical.description,
        nextValue: normalizedJob.description,
        preferNext: preferIncomingSource,
      }),
      shortSummary: chooseCanonicalDescription({
        currentValue: currentCanonical.shortSummary,
        nextValue: normalizedJob.shortSummary,
        preferNext: preferIncomingSource,
      }),
      industry: chooseCanonicalNullableValue({
        currentValue: currentCanonical.industry,
        nextValue: normalizedJob.industry,
        preferNext: preferIncomingSource,
      }),
      roleFamily: chooseCanonicalStringValue({
        currentValue: currentCanonical.roleFamily,
        nextValue: normalizedJob.roleFamily,
        preferNext: preferIncomingSource,
        unknownValues: ["Unknown"],
      }),
      applyUrl: chooseCanonicalUrl({
        currentValue: currentCanonical.applyUrl,
        nextValue: normalizedJob.applyUrl,
        preferNext: preferIncomingSource,
      }),
      applyUrlKey: chooseCanonicalNullableValue({
        currentValue: currentCanonical.applyUrlKey,
        nextValue: normalizedJob.applyUrlKey,
        preferNext: preferIncomingSource,
      }),
      postedAt: chooseEarlierDate(currentCanonical.postedAt, normalizedJob.postedAt),
      deadline: choosePreferredDeadline(currentCanonical.deadline, normalizedJob.deadline),
      duplicateClusterId: chooseCanonicalNullableValue({
        currentValue: currentCanonical.duplicateClusterId,
        nextValue: normalizedJob.duplicateClusterId,
        preferNext: preferIncomingSource,
      }),
      status: "LIVE",
      lastSeenAt: now,
      lastSourceSeenAt: now,
      lastConfirmedAliveAt: now,
      availabilityScore: currentCanonical.availabilityScore ?? 100,
      deadSignalAt: null,
      deadSignalReason: null,
      staleAt: null,
      expiredAt: null,
      removedAt: null,
    },
  });

  await assignCanonicalJobsToCompany(companyRecord.id, normalizedJob.companyKey);

  return {
    id: canonicalJob.id,
    created: false as const,
  };
}

async function upsertSourceMapping({
  canonicalId,
  connector,
  rawJobId,
  sourceUrl,
  sourceIdentity,
  sourceLifecycle,
  canonicalMatch,
  now,
}: {
  canonicalId: string;
  connector: SourceConnector;
  rawJobId: string;
  sourceUrl: string | null;
  sourceIdentity: SourceIdentitySnapshot;
  sourceLifecycle: ReturnType<typeof deriveSourceLifecycleSnapshot>;
  canonicalMatch: CanonicalMatchResult | null;
  now: Date;
}) {
  const existingMapping = await prisma.jobSourceMapping.findFirst({
    where: { rawJobId },
    select: {
      id: true,
      canonicalJobId: true,
    },
  });

  if (existingMapping) {
    await prisma.jobSourceMapping.update({
      where: { id: existingMapping.id },
      data: {
        canonicalJobId: canonicalId,
        sourceName: connector.sourceName,
        sourceUrl,
        applyUrlKey: sourceIdentity.applyUrlKey,
        sourceUrlKey: sourceIdentity.sourceUrlKey,
        postingIdKey: sourceIdentity.postingIdKey,
        sourceQualityKind: sourceIdentity.sourceQualityKind,
        sourceQualityRank: sourceIdentity.sourceQualityRank,
        sourceType: sourceLifecycle.sourceType,
        sourceReliability: sourceLifecycle.sourceReliability,
        isFullSnapshot: sourceLifecycle.isFullSnapshot,
        pollPattern: sourceLifecycle.pollPattern,
        dedupeMatchedBy: canonicalMatch?.matchedBy ?? null,
        dedupeScore: canonicalMatch?.score ?? null,
        dedupeEvidence:
          canonicalMatch?.evidence
            ? (canonicalMatch.evidence as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        lastSeenAt: now,
        removedAt: null,
        isPrimary: false,
      },
    });

    await refreshPrimarySourceMapping(canonicalId);
    if (existingMapping.canonicalJobId !== canonicalId) {
      await refreshPrimarySourceMapping(existingMapping.canonicalJobId);
    }

    return {
      created: false as const,
      previousCanonicalId:
        existingMapping.canonicalJobId !== canonicalId ? existingMapping.canonicalJobId : null,
    };
  }

  await prisma.jobSourceMapping.create({
    data: {
      canonicalJobId: canonicalId,
      rawJobId,
      sourceName: connector.sourceName,
      sourceUrl,
      applyUrlKey: sourceIdentity.applyUrlKey,
      sourceUrlKey: sourceIdentity.sourceUrlKey,
      postingIdKey: sourceIdentity.postingIdKey,
      sourceQualityKind: sourceIdentity.sourceQualityKind,
      sourceQualityRank: sourceIdentity.sourceQualityRank,
      sourceType: sourceLifecycle.sourceType,
      sourceReliability: sourceLifecycle.sourceReliability,
      isFullSnapshot: sourceLifecycle.isFullSnapshot,
      pollPattern: sourceLifecycle.pollPattern,
      dedupeMatchedBy: canonicalMatch?.matchedBy ?? null,
      dedupeScore: canonicalMatch?.score ?? null,
      dedupeEvidence:
        canonicalMatch?.evidence
          ? (canonicalMatch.evidence as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      isPrimary: false,
      lastSeenAt: now,
      removedAt: null,
    },
  });

  await refreshPrimarySourceMapping(canonicalId);

  return {
    created: true as const,
    previousCanonicalId: null,
  };
}

async function upsertEligibility(
  canonicalJobId: string,
  normalizedJob: NormalizedJobInput,
  sourceName: string
) {
  const eligibilityDraft = buildEligibilityDraft({
    job: normalizedJob,
    sourceName,
  });

  await prisma.jobEligibility.upsert({
    where: { canonicalJobId },
    create: {
      canonicalJobId,
      ...eligibilityDraft,
    },
    update: eligibilityDraft,
  });
}

async function markMissingSourceMappingsRemoved({
  connectorSourceName,
  seenSourceIds,
  now,
}: {
  connectorSourceName: string;
  seenSourceIds: string[];
  now: Date;
}) {
  const missingMappings = await prisma.jobSourceMapping.findMany({
    where: {
      sourceName: connectorSourceName,
      removedAt: null,
      ...(seenSourceIds.length > 0
        ? {
            rawJob: {
              sourceId: {
                notIn: seenSourceIds,
              },
            },
          }
        : {}),
    },
    select: {
      id: true,
      canonicalJobId: true,
    },
  });

  if (missingMappings.length === 0) {
    return {
      removedMappingCount: 0,
      canonicalIds: [] as string[],
    };
  }

  await prisma.jobSourceMapping.updateMany({
    where: {
      id: {
        in: missingMappings.map((mapping) => mapping.id),
      },
    },
    data: {
      removedAt: now,
    },
  });

  return {
    removedMappingCount: missingMappings.length,
    canonicalIds: [...new Set(missingMappings.map((mapping) => mapping.canonicalJobId))],
  };
}

async function markMappedJobAsDead({
  rawJobId,
  now,
  reason,
}: {
  rawJobId: string;
  now: Date;
  reason: string;
}) {
  const mapping = await prisma.jobSourceMapping.findFirst({
    where: { rawJobId },
    select: {
      id: true,
      canonicalJobId: true,
    },
  });

  if (!mapping) {
    return { canonicalId: null as string | null };
  }

  await prisma.jobSourceMapping.update({
    where: { id: mapping.id },
    data: {
      removedAt: now,
      isPrimary: false,
    },
  });

  await prisma.jobCanonical.update({
    where: { id: mapping.canonicalJobId },
    data: {
      deadSignalAt: now,
      deadSignalReason: reason,
      lastApplyCheckAt: now,
    },
  });

  await refreshPrimarySourceMapping(mapping.canonicalJobId);

  return { canonicalId: mapping.canonicalJobId };
}

async function refreshCanonicalStatuses(canonicalIds: string[], now: Date) {
  const uniqueCanonicalIds = [...new Set(canonicalIds)];
  const tally: CanonicalStatusTally = {
    liveCount: 0,
    agingCount: 0,
    staleCount: 0,
    expiredCount: 0,
    removedCount: 0,
    updatedCount: 0,
  };

  for (const canonicalId of uniqueCanonicalIds) {
    const result = await refreshCanonicalStatus(canonicalId, now);
    if (result.status === "LIVE" || result.status === "AGING") tally.liveCount += 1;
    if (result.status === "AGING") tally.agingCount += 1;
    if (result.status === "STALE") tally.staleCount += 1;
    if (result.status === "EXPIRED") tally.expiredCount += 1;
    if (result.status === "REMOVED") tally.removedCount += 1;
    if (result.updated) tally.updatedCount += 1;
  }

  return tally;
}

async function refreshCanonicalStatus(
  canonicalId: string,
  now: Date
): Promise<CanonicalStatusRefreshResult> {
  const canonicalJob = await prisma.jobCanonical.findUnique({
    where: { id: canonicalId },
    select: {
      id: true,
      applyUrl: true,
      status: true,
      firstSeenAt: true,
      lastSeenAt: true,
      lastSourceSeenAt: true,
      lastApplyCheckAt: true,
      lastConfirmedAliveAt: true,
      availabilityScore: true,
      deadSignalAt: true,
      deadSignalReason: true,
      deadline: true,
      staleAt: true,
      expiredAt: true,
      removedAt: true,
      sourceMappings: {
        select: {
          id: true,
          sourceName: true,
          sourceType: true,
          sourceReliability: true,
          isFullSnapshot: true,
          pollPattern: true,
          lastSeenAt: true,
          removedAt: true,
        },
      },
    },
  });

  if (!canonicalJob) {
    throw new Error(`Canonical job ${canonicalId} not found while refreshing freshness`);
  }

  return refreshCanonicalStatusFromSnapshot(canonicalJob, now);
}

async function refreshCanonicalStatusFromSnapshot(
  canonicalJob: CanonicalStatusSnapshot,
  now: Date
): Promise<CanonicalStatusRefreshResult> {
  const activeMappings = canonicalJob.sourceMappings.filter(
    (sourceMapping) => sourceMapping.removedAt === null
  );
  const removedMappings = canonicalJob.sourceMappings.filter(
    (sourceMapping) => sourceMapping.removedAt !== null
  );

  let applyCheckOutcome: ApplyUrlCheckOutcome | null = null;
  const provisionalLifecycle = computeLifecycleState({
    canonicalJob,
    activeMappings,
    removedMappings,
    now,
  });

  if (
    shouldRunApplyUrlCheck({
      canonicalJob,
      activeMappingsCount: activeMappings.length,
      provisionalScore: provisionalLifecycle.availabilityScore,
      now,
    })
  ) {
    applyCheckOutcome = await checkApplyUrlAvailability(canonicalJob.applyUrl, now);
  }

  const nextLifecycleData = buildLifecycleUpdateData({
    canonicalJob,
    activeMappings,
    removedMappings,
    applyCheckOutcome,
    now,
  });

  const shouldUpdate =
    nextLifecycleData.status !== canonicalJob.status ||
    nextLifecycleData.lastSeenAt.getTime() !== canonicalJob.lastSeenAt.getTime() ||
    !sameNullableDate(nextLifecycleData.lastSourceSeenAt, canonicalJob.lastSourceSeenAt) ||
    !sameNullableDate(nextLifecycleData.lastApplyCheckAt, canonicalJob.lastApplyCheckAt) ||
    !sameNullableDate(
      nextLifecycleData.lastConfirmedAliveAt,
      canonicalJob.lastConfirmedAliveAt
    ) ||
    nextLifecycleData.availabilityScore !== canonicalJob.availabilityScore ||
    !sameNullableDate(nextLifecycleData.deadSignalAt, canonicalJob.deadSignalAt) ||
    nextLifecycleData.deadSignalReason !== canonicalJob.deadSignalReason ||
    !sameNullableDate(nextLifecycleData.staleAt, canonicalJob.staleAt) ||
    !sameNullableDate(nextLifecycleData.expiredAt, canonicalJob.expiredAt) ||
    !sameNullableDate(nextLifecycleData.removedAt, canonicalJob.removedAt);

  if (shouldUpdate) {
    await prisma.jobCanonical.update({
      where: { id: canonicalJob.id },
      data: nextLifecycleData,
    });
  }

  return {
    status: nextLifecycleData.status,
    updated: shouldUpdate,
  };
}

function buildLifecycleUpdateData({
  canonicalJob,
  activeMappings,
  removedMappings,
  applyCheckOutcome,
  now,
}: {
  canonicalJob: CanonicalStatusSnapshot;
  activeMappings: CanonicalStatusSnapshot["sourceMappings"];
  removedMappings: CanonicalStatusSnapshot["sourceMappings"];
  applyCheckOutcome: ApplyUrlCheckOutcome | null;
  now: Date;
}) {
  const lastApplyCheckAt = applyCheckOutcome?.checkedAt ?? canonicalJob.lastApplyCheckAt;
  const lastConfirmedAliveAt =
    applyCheckOutcome?.aliveConfirmedAt ?? canonicalJob.lastConfirmedAliveAt;
  const deadSignalAt = applyCheckOutcome?.deadSignalAt ?? canonicalJob.deadSignalAt;
  const deadSignalReason = applyCheckOutcome?.deadSignalReason ?? canonicalJob.deadSignalReason;
  const computed = computeLifecycleState({
    canonicalJob: {
      ...canonicalJob,
      lastApplyCheckAt,
      lastConfirmedAliveAt,
      deadSignalAt,
      deadSignalReason,
    },
    activeMappings,
    removedMappings,
    now,
  });

  return {
    status: computed.status,
    lastSeenAt: computed.lastSeenAt,
    lastSourceSeenAt: computed.lastSourceSeenAt,
    lastApplyCheckAt,
    lastConfirmedAliveAt,
    availabilityScore: computed.availabilityScore,
    deadSignalAt,
    deadSignalReason,
    staleAt:
      computed.status === "STALE"
        ? canonicalJob.status === "STALE"
          ? canonicalJob.staleAt
          : now
        : null,
    expiredAt:
      computed.status === "EXPIRED"
        ? canonicalJob.status === "EXPIRED"
          ? canonicalJob.expiredAt
          : now
        : null,
    removedAt:
      computed.status === "REMOVED"
        ? canonicalJob.status === "REMOVED"
          ? canonicalJob.removedAt
          : now
        : null,
  } satisfies Prisma.JobCanonicalUncheckedUpdateInput;
}

type ApplyUrlCheckOutcome = {
  checkedAt: Date;
  aliveConfirmedAt: Date | null;
  deadSignalAt: Date | null;
  deadSignalReason: string | null;
};

function computeLifecycleState({
  canonicalJob,
  activeMappings,
  removedMappings,
  now,
}: {
  canonicalJob: Pick<
    CanonicalStatusSnapshot,
    | "status"
    | "firstSeenAt"
    | "lastSeenAt"
    | "lastSourceSeenAt"
    | "lastApplyCheckAt"
    | "lastConfirmedAliveAt"
    | "availabilityScore"
    | "deadline"
    | "deadSignalAt"
    | "deadSignalReason"
  >;
  activeMappings: CanonicalStatusSnapshot["sourceMappings"];
  removedMappings: CanonicalStatusSnapshot["sourceMappings"];
  now: Date;
}) {
  const lastSourceSeenAt = activeMappings.reduce<Date | null>(
    (latestSeenAt, sourceMapping) =>
      !latestSeenAt || sourceMapping.lastSeenAt > latestSeenAt
        ? sourceMapping.lastSeenAt
        : latestSeenAt,
    canonicalJob.lastSourceSeenAt
  );
  const lastEvidenceAt = getLatestEvidenceAt([
    lastSourceSeenAt,
    canonicalJob.lastConfirmedAliveAt,
    canonicalJob.lastSeenAt,
    canonicalJob.firstSeenAt,
  ]);
  const latestAliveEvidenceAt = getLatestEvidenceAt([
    lastSourceSeenAt,
    canonicalJob.lastConfirmedAliveAt,
  ]);

  if (
    canonicalJob.deadline &&
    canonicalJob.deadline.getTime() <= now.getTime() &&
    latestAliveEvidenceAt.getTime() <= canonicalJob.deadline.getTime()
  ) {
    return {
      status: "EXPIRED" as JobStatus,
      availabilityScore: 0,
      lastSeenAt: lastEvidenceAt,
      lastSourceSeenAt,
    };
  }

  if (
    canonicalJob.deadSignalAt &&
    (!canonicalJob.lastConfirmedAliveAt ||
      canonicalJob.deadSignalAt.getTime() >= canonicalJob.lastConfirmedAliveAt.getTime())
  ) {
    return {
      status: "EXPIRED" as JobStatus,
      availabilityScore: 0,
      lastSeenAt: lastEvidenceAt,
      lastSourceSeenAt,
    };
  }

  const activeEvidenceScore = Math.min(
    78,
    [...activeMappings]
      .map((sourceMapping) => scoreActiveMappingEvidence(sourceMapping, now))
      .sort((left, right) => right - left)
      .slice(0, 2)
      .reduce((sum, value) => sum + value, 0)
  );
  const consistencyBonus = Math.min(12, Math.max(0, activeMappings.length - 1) * 4);
  const confirmationBonus = scoreConfirmationEvidence(
    canonicalJob.lastConfirmedAliveAt,
    now
  );
  const agePenalty = scoreAgePenalty(canonicalJob.firstSeenAt, activeMappings.length, now);
  const removalPenalty = computeRemovalPenalty(removedMappings, activeMappings.length, now);

  const confirmationFloor = getRecentAliveConfirmationFloor(
    canonicalJob.lastConfirmedAliveAt,
    activeMappings.length,
    now
  );

  const availabilityScore = Math.max(
    confirmationFloor,
    clampScore(
    activeEvidenceScore + consistencyBonus + confirmationBonus - agePenalty - removalPenalty
    )
  );
  const strongRemovalEvidence = hasStrongRemovalEvidence(removedMappings, now);

  let status: JobStatus;
  if (availabilityScore >= 72) status = "LIVE";
  else if (availabilityScore >= 48) status = "AGING";
  else if (availabilityScore >= 22) status = "STALE";
  else if (activeMappings.length === 0 && strongRemovalEvidence) status = "REMOVED";
  else status = "EXPIRED";

  return {
    status,
    availabilityScore,
    lastSeenAt: lastEvidenceAt,
    lastSourceSeenAt,
  };
}

function scoreActiveMappingEvidence(
  sourceMapping: CanonicalStatusSnapshot["sourceMappings"][number],
  now: Date
) {
  const hoursSinceSeen = (now.getTime() - sourceMapping.lastSeenAt.getTime()) / 3_600_000;
  const recencyFactor =
    hoursSinceSeen <= 12
      ? 1
      : hoursSinceSeen <= 48
        ? 0.92
        : hoursSinceSeen <= 24 * 7
          ? 0.78
          : hoursSinceSeen <= 24 * 14
            ? 0.6
            : hoursSinceSeen <= 24 * 30
              ? 0.42
              : hoursSinceSeen <= 24 * 60
                ? 0.24
                : 0.12;

  let score = sourceMapping.sourceReliability * 55 * recencyFactor;

  if (sourceMapping.isFullSnapshot) score += 6 * recencyFactor;
  if (sourceMapping.sourceType === "ATS") score += 8 * recencyFactor;
  if (sourceMapping.sourceType === "BOARD") score += 4 * recencyFactor;
  if (sourceMapping.sourceType === "AGGREGATOR") score -= 3 * (1 - recencyFactor);

  return Math.max(0, score);
}

function scoreRemovalPenalty(
  sourceMapping: CanonicalStatusSnapshot["sourceMappings"][number],
  now: Date
) {
  if (!sourceMapping.removedAt) return 0;

  const daysSinceRemoved =
    (now.getTime() - sourceMapping.removedAt.getTime()) / (24 * 60 * 60 * 1000);
  const recencyFactor =
    daysSinceRemoved <= 2
      ? 1
      : daysSinceRemoved <= 7
        ? 0.85
        : daysSinceRemoved <= 21
          ? 0.65
          : daysSinceRemoved <= 45
            ? 0.35
            : 0.15;

  let score = sourceMapping.sourceReliability * 22;
  if (sourceMapping.isFullSnapshot) score += 12;
  if (sourceMapping.sourceType === "ATS") score += 8;
  if (sourceMapping.sourceType === "BOARD") score += 4;
  if (sourceMapping.sourceType === "AGGREGATOR") score -= 10;

  return Math.max(0, score * recencyFactor);
}

function computeRemovalPenalty(
  removedMappings: CanonicalStatusSnapshot["sourceMappings"],
  activeMappingsCount: number,
  now: Date
) {
  const latestRemovalBySource = new Map<
    string,
    CanonicalStatusSnapshot["sourceMappings"][number]
  >();

  for (const sourceMapping of removedMappings) {
    const key = sourceMapping.sourceName;
    const current = latestRemovalBySource.get(key);
    if (
      !current ||
      ((sourceMapping.removedAt?.getTime() ?? 0) > (current.removedAt?.getTime() ?? 0))
    ) {
      latestRemovalBySource.set(key, sourceMapping);
    }
  }

  const rawPenalty = [...latestRemovalBySource.values()].reduce(
    (sum, sourceMapping) => sum + scoreRemovalPenalty(sourceMapping, now),
    0
  );

  return Math.min(activeMappingsCount > 0 ? 28 : 70, rawPenalty);
}

function scoreConfirmationEvidence(lastConfirmedAliveAt: Date | null, now: Date) {
  if (!lastConfirmedAliveAt) return 0;

  const daysSinceConfirmed =
    (now.getTime() - lastConfirmedAliveAt.getTime()) / (24 * 60 * 60 * 1000);

  if (daysSinceConfirmed <= 1) return 15;
  if (daysSinceConfirmed <= 3) return 12;
  if (daysSinceConfirmed <= 7) return 8;
  if (daysSinceConfirmed <= 14) return 4;
  if (daysSinceConfirmed <= 30) return 1;
  return 0;
}

function getRecentAliveConfirmationFloor(
  lastConfirmedAliveAt: Date | null,
  activeMappingsCount: number,
  now: Date
) {
  if (!lastConfirmedAliveAt) return 0;

  const daysSinceConfirmed =
    (now.getTime() - lastConfirmedAliveAt.getTime()) / (24 * 60 * 60 * 1000);

  // A URL confirmed alive within 3 days is the strongest freshness signal —
  // treat as LIVE regardless of whether sources are currently listing the job.
  // Aggregator/board sources routinely drop and re-add listings without the
  // underlying job closing, so active mapping count is a poor proxy for liveness.
  if (daysSinceConfirmed <= 3) {
    return 72;
  }

  if (daysSinceConfirmed <= 7) {
    return activeMappingsCount > 0 ? 60 : 48;
  }

  if (daysSinceConfirmed <= 14) {
    return activeMappingsCount > 0 ? 48 : 30;
  }

  return 0;
}

function scoreAgePenalty(firstSeenAt: Date, activeMappingsCount: number, now: Date) {
  const daysSinceFirstSeen =
    (now.getTime() - firstSeenAt.getTime()) / (24 * 60 * 60 * 1000);

  if (daysSinceFirstSeen <= 120) return 0;
  if (daysSinceFirstSeen <= 240) return activeMappingsCount <= 1 ? 4 : 2;
  if (daysSinceFirstSeen <= 365) return activeMappingsCount === 0 ? 10 : 6;
  return activeMappingsCount === 0 ? 16 : 10;
}

function hasStrongRemovalEvidence(
  removedMappings: CanonicalStatusSnapshot["sourceMappings"],
  now: Date
) {
  return removedMappings.some((sourceMapping) => {
    if (!sourceMapping.removedAt) return false;
    const daysSinceRemoved =
      (now.getTime() - sourceMapping.removedAt.getTime()) / (24 * 60 * 60 * 1000);
    return (
      daysSinceRemoved <= 21 &&
      sourceMapping.isFullSnapshot &&
      sourceMapping.sourceReliability >= 0.8 &&
      (sourceMapping.sourceType === "ATS" ||
        sourceMapping.sourceType === "COMPANY_JSON" ||
        sourceMapping.sourceType === "COMPANY_HTML" ||
        sourceMapping.sourceType === "BOARD")
    );
  });
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getLatestEvidenceAt(dates: Array<Date | null>) {
  return dates.reduce<Date>((latestValue, currentValue) => {
    if (!currentValue) return latestValue;
    return currentValue > latestValue ? currentValue : latestValue;
  }, dates.find((value): value is Date => Boolean(value)) ?? new Date(0));
}

function shouldRunApplyUrlCheck({
  canonicalJob,
  activeMappingsCount,
  provisionalScore,
  now,
}: {
  canonicalJob: CanonicalStatusSnapshot;
  activeMappingsCount: number;
  provisionalScore: number;
  now: Date;
}) {
  if (!canonicalJob.applyUrl || !/^https?:\/\//i.test(canonicalJob.applyUrl)) return false;
  if (canonicalJob.deadSignalAt) return false;

  const hoursSinceLastApplyCheck = canonicalJob.lastApplyCheckAt
    ? (now.getTime() - canonicalJob.lastApplyCheckAt.getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  if (hoursSinceLastApplyCheck < APPLY_URL_CHECK_INTERVAL_HOURS) {
    return false;
  }

  return activeMappingsCount === 0 || provisionalScore < 48;
}

async function checkApplyUrlAvailability(
  applyUrl: string,
  now: Date
): Promise<ApplyUrlCheckOutcome> {
  // Use HEAD to avoid reading a response body. Some ATS pages (e.g. Taleo)
  // return response headers promptly but stream the body forever, causing
  // response.text() to hang indefinitely and keep the Node.js event loop alive.
  // HEAD is body-less by spec — the connection completes as soon as headers arrive.
  // Body-based dead-signal detection (detectDeadSignal) is intentionally skipped
  // here; it's done during full connector indexing where the HTML is already fetched.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPLY_URL_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(applyUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; autoapplication-lifecycle-check/1.0)",
      },
    });

    const status = response.status;

    if ([404, 410, 451].includes(status)) {
      return {
        checkedAt: now,
        aliveConfirmedAt: null,
        deadSignalAt: now,
        deadSignalReason: `Apply URL returned HTTP ${status}.`,
      };
    }

    if (response.ok || (status >= 300 && status < 400)) {
      return {
        checkedAt: now,
        aliveConfirmedAt: now,
        deadSignalAt: null,
        deadSignalReason: null,
      };
    }

    // 405 (HEAD not supported), 4xx, 5xx etc. — treat as unknown
    return {
      checkedAt: now,
      aliveConfirmedAt: null,
      deadSignalAt: null,
      deadSignalReason: null,
    };
  } catch {
    return {
      checkedAt: now,
      aliveConfirmedAt: null,
      deadSignalAt: null,
      deadSignalReason: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Strip PostgreSQL-unsafe C0 control characters (notably \u0000) from a string. */
function stripUnsafeChars(s: string | null | undefined): string | undefined {
  if (s == null) return undefined;
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function buildRawPayload(sourceJob: SourceConnectorJob, fetchedAt: Date) {
  return {
    title: sourceJob.title,
    company: sourceJob.company,
    location: sourceJob.location,
    // Strip null bytes before storing as JSON — PostgreSQL rejects \u0000 in
    // jsonb columns and this is the raw (pre-normalization) description path.
    description: stripUnsafeChars(sourceJob.description),
    applyUrl: sourceJob.applyUrl,
    sourceUrl: sourceJob.sourceUrl,
    postedAt: sourceJob.postedAt?.toISOString() ?? null,
    deadline: sourceJob.deadline?.toISOString() ?? null,
    salaryMin: sourceJob.salaryMin,
    salaryMax: sourceJob.salaryMax,
    salaryCurrency: sourceJob.salaryCurrency,
    fetchedAt: fetchedAt.toISOString(),
    metadata: sourceJob.metadata,
  } as Prisma.InputJsonValue;
}

async function refreshPrimarySourceMapping(canonicalJobId: string) {
  const activeMappings = await prisma.jobSourceMapping.findMany({
    where: {
      canonicalJobId,
      removedAt: null,
    },
    select: {
      id: true,
    },
    orderBy: [
      { sourceQualityRank: "desc" },
      { lastSeenAt: "desc" },
      { createdAt: "asc" },
    ],
  });

  if (activeMappings.length === 0) {
    await prisma.jobSourceMapping.updateMany({
      where: { canonicalJobId },
      data: { isPrimary: false },
    });
    return;
  }

  const primaryId = activeMappings[0]?.id;
  await prisma.jobSourceMapping.updateMany({
    where: {
      canonicalJobId,
      id: {
        not: primaryId,
      },
    },
    data: {
      isPrimary: false,
    },
  });
  await prisma.jobSourceMapping.update({
    where: { id: primaryId },
    data: { isPrimary: true },
  });
}

function chooseCanonicalStringValue({
  currentValue,
  nextValue,
  preferNext,
  unknownValues = [],
}: {
  currentValue: string;
  nextValue: string;
  preferNext: boolean;
  unknownValues?: string[];
}) {
  const currentKnown = isMeaningfulString(currentValue, unknownValues);
  const nextKnown = isMeaningfulString(nextValue, unknownValues);

  if (preferNext && nextKnown) return nextValue;
  if (currentKnown) return currentValue;
  if (nextKnown) return nextValue;
  if (preferNext && nextValue.trim()) return nextValue;
  return currentValue;
}

function chooseCanonicalNullableValue<T>({
  currentValue,
  nextValue,
  preferNext,
}: {
  currentValue: T | null;
  nextValue: T | null;
  preferNext: boolean;
}) {
  if (preferNext && nextValue != null) return nextValue;
  if (currentValue != null) return currentValue;
  return nextValue;
}

function chooseCanonicalEnumValue<T extends string | null>({
  currentValue,
  nextValue,
  preferNext,
  unknownValue,
}: {
  currentValue: T;
  nextValue: T;
  preferNext: boolean;
  unknownValue: string;
}) {
  const currentKnown = currentValue != null && currentValue !== unknownValue;
  const nextKnown = nextValue != null && nextValue !== unknownValue;

  if (preferNext && nextKnown) return nextValue;
  if (currentKnown) return currentValue;
  if (nextKnown) return nextValue;
  if (preferNext && nextValue != null) return nextValue;
  return currentValue ?? nextValue;
}

function chooseCanonicalDescription({
  currentValue,
  nextValue,
  preferNext,
}: {
  currentValue: string;
  nextValue: string;
  preferNext: boolean;
}) {
  const currentLength = currentValue.trim().length;
  const nextLength = nextValue.trim().length;

  if (preferNext) {
    if (nextLength > 0 && nextLength >= Math.floor(currentLength * 0.6)) {
      return nextValue;
    }
    if (currentLength === 0) return nextValue;
    return currentValue;
  }

  if (currentLength > 0) return currentValue;
  return nextValue;
}

function chooseCanonicalUrl({
  currentValue,
  nextValue,
  preferNext,
}: {
  currentValue: string;
  nextValue: string;
  preferNext: boolean;
}) {
  const normalizedCurrentValue = currentValue.trim();
  const normalizedNextValue = nextValue.trim();

  if (!normalizedCurrentValue) return normalizedNextValue;
  if (!normalizedNextValue) return normalizedCurrentValue;
  if (preferNext) return normalizedNextValue;
  return normalizedCurrentValue;
}

function isMeaningfulString(value: string, unknownValues: string[]) {
  const normalizedValue = value.trim();
  if (!normalizedValue) return false;
  return !unknownValues.some(
    (unknownValue) => normalizedValue.toLowerCase() === unknownValue.toLowerCase()
  );
}

function chooseEarlierDate(currentValue: Date, nextValue: Date) {
  return currentValue.getTime() <= nextValue.getTime() ? currentValue : nextValue;
}

function choosePreferredDeadline(
  currentValue: Date | null,
  nextValue: Date | null
): Date | null {
  if (!currentValue) return nextValue;
  if (!nextValue) return currentValue;
  return currentValue.getTime() <= nextValue.getTime() ? currentValue : nextValue;
}

function sameNullableDate(left: Date | null, right: Date | null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

function getErrorSummary(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 1000);
  }

  return String(error).slice(0, 1000);
}
