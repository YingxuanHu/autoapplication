import { prisma } from "@/lib/db";
import { buildEligibilityDraft } from "@/lib/ingestion/classify";
import {
  APPLY_LINK_VALIDATION_STATUS,
  hasBadApplyLinkValidationStatus,
  isClearlyGenericFinalApplyUrl,
} from "@/lib/ingestion/apply-link-quality";
import {
  assignCanonicalJobsToCompany,
  ensureCompanyRecord,
} from "@/lib/ingestion/company-records";
import {
  backfillCanonicalDedupeFields,
  findCrossSourceCanonicalMatch,
  isCanonicalMatchCompatibleForSource,
  type CanonicalMatchResult,
} from "@/lib/ingestion/dedupe";
import { getLifecycleProfile } from "@/lib/ingestion/lifecycle-config";
import { detectDeadSignal, normalizeSourceJob } from "@/lib/ingestion/normalize";
import { upsertNormalizedJobRecordFromSourceJob } from "@/lib/ingestion/normalized-records";
import { computeNormalizedQualityScore } from "@/lib/ingestion/quality";
import { upsertJobFeedIndex } from "@/lib/ingestion/search-index";
import { readCompanySiteCompletenessSignal } from "@/lib/ingestion/source-fetch-quality";
import {
  deriveSourceIdentitySnapshot,
  deriveSourceLifecycleSnapshot,
  deriveSourceProvenanceMetadata,
  type SourceIdentitySnapshot,
} from "@/lib/ingestion/source-quality";
import {
  createRuntimeBudgetExceededError,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";
import { hasUnresolvedGenericCompanyName } from "@/lib/job-cleanup";
import { classifyJobMetadata, coerceNormalizedIndustry } from "@/lib/job-metadata";
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
const APPLY_URL_CHECK_TIMEOUT_MS = 5000;
const LIFECYCLE_PROFILE = getLifecycleProfile();
const RAW_PAYLOAD_FINGERPRINT_IGNORED_KEYS = new Set([
  "fetchedAt",
  // Aggregator records can surface the same provider job through many search
  // frontiers. These fields describe how we found the row, not the row itself.
  "searchKeyword",
  "searchLocation",
]);

const GENERIC_ATS_COMPANY_UNKNOWN_VALUES = [
  "Unknown",
  "Ashbyhq",
  "Greenhouse",
  "Lever",
  "Myworkdayjobs",
  "Smartrecruiters",
  "Workable",
  "Icims",
  "Jobvite",
  "Bamboohr",
  "J",
  "Oraclecloud",
  "GC",
];

const GENERIC_ATS_COMPANY_KEY_UNKNOWN_VALUES = GENERIC_ATS_COMPANY_UNKNOWN_VALUES.map((value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "")
);

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
  applyUrlValidationStatus: string | null;
  applyUrlValidationReason: string | null;
  finalResolvedApplyUrl: string | null;
  applyUrlRedirectDepth: number | null;
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

// Full-snapshot freshness removal marks every mapping the connector did NOT
// report this run as removed. It is only safe when the fetch is authoritative:
// a full snapshot (not a bounded/limited fetch), fully paginated in this
// invocation, and not an errored fetch. Connectors surface upstream failures
// as `metadata.error` without throwing, returning an empty job list — treating
// that as a snapshot would wipe a whole source's live jobs on a single 429/5xx
// blip. The same is true for a parser regression that returns zero or a sharp
// fraction of a previously healthy source: preserve existing mappings and let
// the source retry instead of making an irreversible claim about job closure.
export function shouldRunFreshnessRemovalFor(input: {
  freshnessMode: SourceConnector["freshnessMode"];
  limit: number | undefined;
  fetchExhausted: boolean;
  fetchHadError: boolean;
  startingCheckpoint?: Prisma.InputJsonValue | null;
  fetchedCount?: number;
  existingActiveMappingCount?: number;
}): boolean {
  if (
    input.freshnessMode !== "FULL_SNAPSHOT" ||
    input.limit !== undefined ||
    !input.fetchExhausted ||
    input.fetchHadError
  ) {
    return false;
  }

  // A resumed cursor only contains the final page range. Until snapshot
  // membership is persisted across all pages, it cannot safely remove entries
  // that were seen in an earlier run.
  if (input.startingCheckpoint != null) return false;

  const previousMappings = Math.max(0, input.existingActiveMappingCount ?? 0);
  const fetchedCount = Math.max(0, input.fetchedCount ?? 0);
  if (previousMappings === 0) return true;

  // Empty results after a source has had live mappings are never authoritative.
  if (fetchedCount === 0) return false;

  // A single fetch returning less than one quarter of a materially populated
  // source is almost always pagination/parser degradation, not genuine closure.
  // Keep the old mappings available until a later successful snapshot confirms
  // the change or normal lifecycle evidence expires them.
  return previousMappings < 50 || fetchedCount * 4 >= previousMappings;
}

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

    if (process.env.INGEST_RUN_GLOBAL_DEDUPE_BACKFILL === "1") {
      try {
        await backfillCanonicalDedupeFields();
      } catch (error) {
        console.warn(
          `[connector:${connector.key}] Skipping global canonical dedupe backfill before ingestion: ${getErrorSummary(error)}`
        );
      }
    }
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
  companySourceOnly?: boolean;
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
    const runMetadata = asJsonObject(runOptions?.runMetadata as Prisma.JsonValue | null);
    const origin = typeof runMetadata?.origin === "string" ? runMetadata.origin : null;

    if (options.companySourceOnly && origin !== "company_source") {
      return false;
    }

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
  /** Max number of canonical rows to bulk-status-sync per daemon cycle. Default 5000. */
  bulkLimit?: number;
} = {}) {
  const now = options.now ?? new Date();
  const perJobLimit = options.perJobLimit ?? 3_000;
  const bulkLimit = options.bulkLimit ?? 5_000;
  const confirmationLiveCutoff = new Date(
    now.getTime() - LIFECYCLE_PROFILE.confirmationWindowsDays.liveFloor * 24 * 60 * 60 * 1000
  );
  const {
    liveMinScore,
    agingMinScore,
    staleMinScore,
  } = LIFECYCLE_PROFILE.statusThresholds;
  const { live: liveConfirmationFloor } = LIFECYCLE_PROFILE.confirmationFloorScores;

  // 1. Bulk SQL status sync based on stored availabilityScore.
  //    Also applies the confirmation floor inline: a URL-confirmed-alive job within
  //    the configured live confirmation window always has its availabilityScore bumped
  //    to the configured LIVE floor (from
  //    getRecentAliveConfirmationFloor), so status correctly reflects the confirmation.
  //    This avoids needing a per-job refresh for every recently-confirmed job.
  //    REMOVED jobs are never touched.
  //
  // IMPORTANT: This single-statement UPDATE touches every non-REMOVED row in
  // JobCanonical (~270k+ at the time of writing). DO managed Postgres defaults
  // `statement_timeout` to ~120-180s on the doadmin role, which the bulk
  // UPDATE breaches and kills the entire daemon cycle. Prisma also defaults
  // interactive transactions to 5s, so keep the DB and Prisma timeouts aligned.
  const [syncResult, feedVisibilitySyncResult] = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15min'");
      const canonicalSyncResult =
        bulkLimit > 0
          ? await tx.$executeRaw`
        WITH candidates AS (
          SELECT id
          FROM "JobCanonical"
          WHERE status != 'REMOVED'::"JobStatus"
            -- Select rows whose stored status disagrees with the authoritative
            -- bulk status (this CASE MUST stay identical to the SET below), or
            -- that are confirmation-live but below the score floor. A recent
            -- alive-confirmation is authoritative only when no fresher dead
            -- signal or passed deadline contradicts it — otherwise the fast
            -- bulk path would leave a dead/expired job marked LIVE.
            AND (
              status IS DISTINCT FROM CASE
                WHEN "lastConfirmedAliveAt" >= ${confirmationLiveCutoff}
                  AND "deadSignalAt" IS NULL
                  AND ("deadline" IS NULL OR "deadline" > ${now})
                  THEN 'LIVE'::"JobStatus"
                WHEN ("deadline" IS NOT NULL AND "deadline" <= ${now})
                  THEN 'EXPIRED'::"JobStatus"
                WHEN "availabilityScore" >= ${liveMinScore} THEN 'LIVE'::"JobStatus"
                WHEN "availabilityScore" >= ${agingMinScore} THEN 'AGING'::"JobStatus"
                WHEN "availabilityScore" >= ${staleMinScore} THEN 'STALE'::"JobStatus"
                ELSE                                'EXPIRED'::"JobStatus"
              END
              OR (
                "lastConfirmedAliveAt" >= ${confirmationLiveCutoff}
                AND "deadSignalAt" IS NULL
                AND ("deadline" IS NULL OR "deadline" > ${now})
                AND "availabilityScore" < ${liveConfirmationFloor}
              )
            )
          ORDER BY "updatedAt" ASC
          LIMIT ${bulkLimit}
        )
        UPDATE "JobCanonical" jc
        SET
          "availabilityScore" = CASE
            WHEN jc."lastConfirmedAliveAt" >= ${confirmationLiveCutoff}
              AND jc."deadSignalAt" IS NULL
              AND (jc."deadline" IS NULL OR jc."deadline" > ${now})
              THEN GREATEST(jc."availabilityScore", ${liveConfirmationFloor})
            ELSE jc."availabilityScore"
          END,
          status = CASE
            -- Confirmation-live override only when no fresher dead signal or
            -- passed deadline contradicts it (matches computeLifecycleState).
            WHEN jc."lastConfirmedAliveAt" >= ${confirmationLiveCutoff}
              AND jc."deadSignalAt" IS NULL
              AND (jc."deadline" IS NULL OR jc."deadline" > ${now})
              THEN 'LIVE'::"JobStatus"
            WHEN (jc."deadline" IS NOT NULL AND jc."deadline" <= ${now})
              THEN 'EXPIRED'::"JobStatus"
            WHEN jc."availabilityScore" >= ${liveMinScore} THEN 'LIVE'::"JobStatus"
            WHEN jc."availabilityScore" >= ${agingMinScore} THEN 'AGING'::"JobStatus"
            WHEN jc."availabilityScore" >= ${staleMinScore} THEN 'STALE'::"JobStatus"
            ELSE                                'EXPIRED'::"JobStatus"
          END
        FROM candidates
        WHERE jc.id = candidates.id
      `
          : 0;
      const feedSyncResult = await tx.$executeRaw`
        UPDATE "JobFeedIndex" jfi
        SET
          status = 'REMOVED'::"JobStatus",
          "updatedAt" = NOW()
        FROM "JobCanonical" jc
        WHERE jfi."canonicalJobId" = jc.id
          AND jfi.status = 'LIVE'::"JobStatus"
          AND (
            jc.status != 'LIVE'::"JobStatus"
            OR jc."availabilityScore" < 60
            OR jc."deadSignalAt" IS NOT NULL
            OR jfi."sourceCount" <= 0
            OR COALESCE(jc."applyUrlValidationStatus", 'ACTIVE') IN (
              'EXPIRED',
              'BROKEN_APPLY_LINK',
              'GENERIC_APPLY_PAGE',
              'SOURCE_STALE',
              'HIDDEN_LOW_QUALITY'
            )
            OR (jc.deadline IS NOT NULL AND jc.deadline < ${now})
            OR jc."applyUrl" !~* '^https?://'
          )
      `;

      return [canonicalSyncResult, feedSyncResult] as const;
    },
    { maxWait: 30_000, timeout: 15 * 60 * 1000 }
  );

  // 2. Incremental per-job refresh for AGING/STALE cohort — these are most
  //    likely to transition and need freshness/expiry logic applied.
  const tally =
    perJobLimit > 0
      ? await (async () => {
          const atRiskJobs = await prisma.jobCanonical.findMany({
            where: { status: { in: ["AGING", "STALE"] } },
            select: { id: true },
            orderBy: { lastApplyCheckAt: "asc" }, // oldest-checked first
            take: perJobLimit,
          });

          return refreshCanonicalStatuses(
            atRiskJobs.map((j) => j.id),
            now
          );
        })()
      : {
          liveCount: 0,
          agingCount: 0,
          staleCount: 0,
          expiredCount: 0,
          removedCount: 0,
          updatedCount: 0,
        };

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
    updatedCount:
      (syncResult as number) +
      (feedVisibilitySyncResult as number) +
      tally.updatedCount,
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
  // Connectors return `metadata.error` (without throwing) when the upstream
  // responded non-OK (429 rate-limit, 5xx outage). Such a fetch yields an
  // empty job list that is NOT authoritative: treating it as a full snapshot
  // would mark every one of the source's mappings removed and drive the whole
  // company's canonical jobs to REMOVED on a single transient blip.
  const fetchHadUpstreamError =
    typeof fetchResult.metadata === "object" &&
    fetchResult.metadata !== null &&
    "error" in fetchResult.metadata &&
    Boolean((fetchResult.metadata as { error?: unknown }).error);
  // A known partial company-site extraction is not an authoritative snapshot.
  // Keep prior mappings alive while the source recovery loop finds the board's
  // structured route or a replacement ATS.
  const fetchHadError =
    fetchHadUpstreamError || readCompanySiteCompletenessSignal(fetchResult.metadata) !== null;
  summary.fetchMetadata = fetchResult.metadata ?? null;
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

    if (!rawJobResult.created && rawJobResult.unchanged) {
      const refreshResult = await refreshUnchangedMappedRawJob({
        rawJobId: rawJobResult.rawJob.id,
        now,
      });

      if (refreshResult) {
        summary.acceptedCount += 1;
        summary.minimallyAcceptedCount += 1;
        summary.canonicalUpdatedCount += 1;
        summary.sourceMappingUpdatedCount += 1;

        if (refreshResult.region === "CA") {
          summary.acceptedCanadaCount += 1;
          if (refreshResult.workMode === "REMOTE") {
            summary.acceptedCanadaRemoteCount += 1;
          }
        }

        freshnessCandidateIds.add(refreshResult.canonicalId);
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
        continue;
      }
    }

    await upsertNormalizedJobRecordFromSourceJob({
      rawJobId: rawJobResult.rawJob.id,
      rawSourceName: connector.sourceName,
      rawSourceId: sourceJob.sourceId,
      rawPayload: rawJobResult.rawJob.rawPayload,
      fetchedAt: now,
    });

    const normalizationResult = normalizeSourceJob({
      job: sourceJob,
      fetchedAt: now,
      sourceName: connector.sourceName,
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
      isCanonicalMatchCompatibleForSource(
        normalizationResult.job,
        mappedCanonical.canonical,
        sourceIdentity
      )
        ? mappedCanonical
        : null;
    const incompatibleMappedCanonicalId =
      mappedCanonical && !compatibleMappedCanonical ? mappedCanonical.canonical.id : null;
    const crossSourceMatch = compatibleMappedCanonical
      ? null
      : await findCrossSourceCanonicalMatch(normalizationResult.job, sourceIdentity, {
          excludeCanonicalIds: incompatibleMappedCanonicalId
            ? [incompatibleMappedCanonicalId]
            : [],
        });
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
    await prisma.jobCanonical.update({
      where: { id: canonicalResult.id },
      data: {
        qualityScore: computeNormalizedQualityScore(normalizationResult.job),
      },
    });
    await upsertJobFeedIndex(canonicalResult.id);
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

  const existingActiveMappingCount =
    connector.freshnessMode === "FULL_SNAPSHOT"
      ? await prisma.jobSourceMapping.count({
          where: {
            sourceName: connector.sourceName,
            removedAt: null,
          },
        })
      : 0;
  const shouldRunFreshnessRemoval = shouldRunFreshnessRemovalFor({
    freshnessMode: connector.freshnessMode,
    limit,
    fetchExhausted,
    fetchHadError,
    startingCheckpoint: checkpoint,
    fetchedCount: summary.fetchedCount,
    existingActiveMappingCount,
  });

  if (
    connector.freshnessMode === "FULL_SNAPSHOT" &&
    !shouldRunFreshnessRemoval &&
    existingActiveMappingCount > 0
  ) {
    const skipReason =
      checkpoint != null
        ? "freshness_removal_resumed_snapshot"
        : summary.fetchedCount === 0
          ? "freshness_removal_empty_snapshot"
          :
              summary.fetchedCount * 4 < existingActiveMappingCount
            ? "freshness_removal_snapshot_collapse"
            : null;
    if (skipReason) {
      summary.skippedReasons[skipReason] =
        (summary.skippedReasons[skipReason] ?? 0) + 1;
      console.warn(
        `[connector:${connector.key}] Preserved ${existingActiveMappingCount} active mappings; ${skipReason} (fetched=${summary.fetchedCount}).`
      );
    }
  }

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
  summary.fetchMetadata = fetchResult.metadata ?? null;

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
      sourceName: connector.sourceName,
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
      isCanonicalMatchCompatibleForSource(
        normalizationResult.job,
        mappedCanonical.canonical,
        sourceIdentity
      )
        ? mappedCanonical
        : null;
    const incompatibleMappedCanonicalId =
      mappedCanonical && !compatibleMappedCanonical ? mappedCanonical.canonical.id : null;
    const crossSourceMatch = compatibleMappedCanonical
      ? null
      : await findCrossSourceCanonicalMatch(normalizationResult.job, sourceIdentity, {
          excludeCanonicalIds: incompatibleMappedCanonicalId
            ? [incompatibleMappedCanonicalId]
            : [],
        });
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
    fetchMetadata: null,
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
    where: {
      connectorKey,
      status: "SUCCESS",
    },
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
    extractionCompleteness: readCompanySiteCompletenessSignal(summary.fetchMetadata),
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
    rawPayload: buildRawPayload(connector, sourceJob, fetchedAt),
  } satisfies Prisma.JobRawUncheckedCreateInput;

  if (existingRawJob) {
    const nextRawPayload = data.rawPayload;
    const unchanged = rawPayloadsEquivalent(existingRawJob.rawPayload, nextRawPayload);
    const rawJob = unchanged
      ? await prisma.jobRaw.update({
          where: { id: existingRawJob.id },
          data: {
            sourceTier: connector.sourceTier,
            fetchedAt,
          },
        })
      : await prisma.jobRaw.update({
          where: { id: existingRawJob.id },
          data,
        });
    return { rawJob, created: false as const, unchanged };
  }

  const rawJob = await prisma.jobRaw.create({ data });
  return { rawJob, created: true as const, unchanged: false };
}

async function refreshUnchangedMappedRawJob({
  rawJobId,
  now,
}: {
  rawJobId: string;
  now: Date;
}) {
  const mapping = await prisma.jobSourceMapping.findFirst({
    where: { rawJobId },
    select: {
      id: true,
      canonicalJobId: true,
      removedAt: true,
      canonicalJob: {
        select: {
          region: true,
          workMode: true,
          availabilityScore: true,
        },
      },
    },
  });

  if (!mapping) return null;

  await prisma.jobSourceMapping.update({
    where: { id: mapping.id },
    data: {
      lastSeenAt: now,
      removedAt: null,
    },
  });

  if (mapping.removedAt) {
    await refreshPrimarySourceMapping(mapping.canonicalJobId);
  }

  await prisma.jobCanonical.update({
    where: { id: mapping.canonicalJobId },
    data: {
      status: "LIVE",
      lastSeenAt: now,
      lastSourceSeenAt: now,
      lastConfirmedAliveAt: now,
      availabilityScore: mapping.canonicalJob.availabilityScore ?? 100,
      deadSignalAt: null,
      deadSignalReason: null,
      staleAt: null,
      expiredAt: null,
      removedAt: null,
    },
  });

  return {
    canonicalId: mapping.canonicalJobId,
    region: mapping.canonicalJob.region,
    workMode: mapping.canonicalJob.workMode,
  };
}

function rawPayloadsEquivalent(
  currentPayload: Prisma.JsonValue,
  nextPayload: Prisma.InputJsonValue
) {
  return (
    stableRawPayloadFingerprint(currentPayload) ===
    stableRawPayloadFingerprint(nextPayload)
  );
}

function stableRawPayloadFingerprint(value: Prisma.JsonValue | Prisma.InputJsonValue) {
  return JSON.stringify(normalizeRawPayloadForFingerprint(value));
}

function normalizeRawPayloadForFingerprint(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeRawPayloadForFingerprint(entry));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !RAW_PAYLOAD_FINGERPRINT_IGNORED_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeRawPayloadForFingerprint(entry)])
  );
}

export async function findMappedCanonical(rawJobId: string) {
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
  normalizedEmploymentType: true,
  normalizedEmploymentTypeConfidence: true,
  normalizedCareerStage: true,
  normalizedCareerStageConfidence: true,
  experienceLevelGroup: true,
  experienceLevelSource: true,
  experienceLevelEvidenceJson: true,
  experienceLevelWarningsJson: true,
  normalizedIndustry: true,
  normalizedIndustries: true,
  normalizedIndustryConfidence: true,
  normalizedRoleCategory: true,
  normalizedRoleCategoryConfidence: true,
  normalizedRoleCategoryGroup: true,
  normalizedRoleCategoryStatus: true,
  normalizedRoleCategorySource: true,
  classificationStatus: true,
  workMode: true,
} as const;

function applyCompanyIndustryToNormalizedJob(
  normalizedJob: NormalizedJobInput,
  companyRecord: {
    normalizedIndustry?: string | null;
    normalizedIndustries?: string[] | null;
    normalizedIndustryConfidence?: number | null;
  }
): NormalizedJobInput {
  const normalizedIndustry = coerceNormalizedIndustry(companyRecord.normalizedIndustry);
  const normalizedIndustries = normalizeCompanyIndustryValues(
    companyRecord.normalizedIndustries,
    normalizedIndustry
  );
  const normalizedIndustryConfidence =
    companyRecord.normalizedIndustryConfidence ??
    (normalizedIndustries.length === 0 ? 0.2 : 0.9);
  const roleMetadata = classifyJobMetadata({
    title: normalizedJob.title,
    company: normalizedJob.company,
    description: normalizedJob.description,
    location: normalizedJob.location,
    roleFamily: normalizedJob.roleFamily,
    companyIndustries: normalizedIndustries,
    legacyIndustry: normalizedJob.industry,
    sourceEmploymentType: normalizedJob.employmentType,
    inferredEmploymentType: normalizedJob.employmentType,
    workMode: normalizedJob.workMode,
    applyUrl: normalizedJob.applyUrl,
  });
  const useRoleMetadata =
    roleMetadata.normalizedRoleCategory === normalizedJob.normalizedRoleCategory ||
    normalizedJob.normalizedRoleCategory === "OTHER_UNKNOWN" ||
    roleMetadata.confidence.roleCategory > normalizedJob.normalizedRoleCategoryConfidence;

  return {
    ...normalizedJob,
    normalizedIndustry,
    normalizedIndustries,
    normalizedIndustryConfidence,
    normalizedRoleCategory: useRoleMetadata
      ? roleMetadata.normalizedRoleCategory
      : normalizedJob.normalizedRoleCategory,
    normalizedRoleCategoryConfidence: useRoleMetadata
      ? roleMetadata.confidence.roleCategory
      : normalizedJob.normalizedRoleCategoryConfidence,
    normalizedRoleCategoryGroup: useRoleMetadata
      ? roleMetadata.normalizedRoleCategoryGroup
      : normalizedJob.normalizedRoleCategoryGroup,
    normalizedRoleCategoryStatus: useRoleMetadata
      ? roleMetadata.normalizedRoleCategoryStatus
      : normalizedJob.normalizedRoleCategoryStatus,
    normalizedRoleCategorySource: useRoleMetadata
      ? roleMetadata.normalizedRoleCategorySource
      : normalizedJob.normalizedRoleCategorySource,
    normalizedRoleCategoryCandidatesJson: useRoleMetadata
      ? (roleMetadata.normalizedRoleCategoryCandidates as unknown as Prisma.InputJsonValue)
      : normalizedJob.normalizedRoleCategoryCandidatesJson,
    normalizedRoleCategoryEvidenceJson: useRoleMetadata
      ? (roleMetadata.normalizedRoleCategoryEvidence as unknown as Prisma.InputJsonValue)
      : normalizedJob.normalizedRoleCategoryEvidenceJson,
    normalizedRoleCategoryWarningsJson: useRoleMetadata
      ? (roleMetadata.normalizedRoleCategoryWarnings as unknown as Prisma.InputJsonValue)
      : normalizedJob.normalizedRoleCategoryWarningsJson,
    classificationStatus: useRoleMetadata
      ? roleMetadata.classificationStatus
      : normalizedJob.classificationStatus,
  };
}

function normalizeCompanyIndustryValues(
  values: string[] | null | undefined,
  primaryIndustry: string | null | undefined
) {
  const seen = new Set<string>();
  const industries: NormalizedJobInput["normalizedIndustries"] = [];
  for (const value of [...(values ?? []), primaryIndustry ?? ""]) {
    const industry = coerceNormalizedIndustry(value);
    if (industry === "UNKNOWN" || seen.has(industry)) continue;
    seen.add(industry);
    industries.push(industry);
  }
  return industries;
}

export async function upsertCanonicalJob({
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
  const companyDisplayName = companyRecord.name.trim() || normalizedJob.company;
  normalizedJob = applyCompanyIndustryToNormalizedJob(
    { ...normalizedJob, company: companyDisplayName },
    companyRecord
  );

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
      displayTitle: true,
      titleConfidence: true,
      titleStatus: true,
      titleSource: true,
      titleCandidatesJson: true,
      titleRejectedFragmentsJson: true,
      titleExtractionWarnings: true,
      jobPageType: true,
      company: true,
      companyKey: true,
      titleKey: true,
      titleCoreKey: true,
      descriptionFingerprint: true,
      location: true,
      locationConfidence: true,
      locationStatus: true,
      locationSource: true,
      locationCandidatesJson: true,
      locationKey: true,
      region: true,
      workMode: true,
      workModeConfidence: true,
      workModeStatus: true,
      workModeSource: true,
      workModeCandidatesJson: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      salaryStatus: true,
      salaryPeriod: true,
      salaryRawText: true,
      salaryConfidence: true,
      salarySource: true,
      employmentType: true,
      employmentTypeGroup: true,
      employmentTypeConfidence: true,
      employmentTypeStatus: true,
      employmentTypeSource: true,
      employmentTypeCandidatesJson: true,
      experienceLevel: true,
      experienceLevelGroup: true,
      experienceLevelSource: true,
      experienceLevelEvidenceJson: true,
      experienceLevelWarningsJson: true,
      description: true,
      descriptionStatus: true,
      descriptionConfidence: true,
      descriptionWordCount: true,
      shortSummary: true,
      industry: true,
      roleFamily: true,
      normalizedEmploymentType: true,
      normalizedEmploymentTypeConfidence: true,
      normalizedCareerStage: true,
      normalizedCareerStageConfidence: true,
      normalizedIndustry: true,
      normalizedIndustries: true,
      normalizedIndustryConfidence: true,
      normalizedRoleCategory: true,
      normalizedRoleCategoryConfidence: true,
      normalizedRoleCategoryGroup: true,
      normalizedRoleCategoryStatus: true,
      normalizedRoleCategorySource: true,
      normalizedRoleCategoryCandidatesJson: true,
      normalizedRoleCategoryEvidenceJson: true,
      normalizedRoleCategoryWarningsJson: true,
      classificationStatus: true,
      applyUrl: true,
      applyUrlKey: true,
      postedAt: true,
      datePostedConfidence: true,
      datePostedStatus: true,
      datePostedSource: true,
      datePostedRawText: true,
      deadline: true,
      applicationDeadlineConfidence: true,
      applicationDeadlineStatus: true,
      applicationDeadlineSource: true,
      applicationDeadlineRawText: true,
      duplicateClusterId: true,
      metadataExtractionWarnings: true,
      extractionWarnings: true,
      extractionRejectionReasons: true,
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
  const preferIncomingSource = shouldIncomingSourceUpdateCanonicalFields({
    currentPrimaryRank,
    incomingRank: sourceIdentity.sourceQualityRank,
    incomingOriginPreference: sourceIdentity.canonicalOriginPreference,
  });
  const currentCompanyIsGeneric = hasUnresolvedGenericCompanyName(
    currentCanonical.company,
    currentCanonical.applyUrl
  );
  const incomingCompanyIsGeneric = hasUnresolvedGenericCompanyName(
    normalizedJob.company,
    normalizedJob.applyUrl
  );
  const shouldReplaceGenericCompany =
    currentCompanyIsGeneric && !incomingCompanyIsGeneric;
  const shouldUseCompanyRecordName =
    companyDisplayName.length > 0 &&
    currentCanonical.company !== companyDisplayName;
  const incomingHasSalary =
    normalizedJob.salaryMin != null || normalizedJob.salaryMax != null;
  const currentHasSalary =
    currentCanonical.salaryMin != null || currentCanonical.salaryMax != null;
  const useIncomingSalary = (preferIncomingSource && incomingHasSalary) || !currentHasSalary;
  const useIncomingTitleExtraction =
    preferIncomingSource ||
    currentCanonical.titleStatus == null ||
    currentCanonical.titleConfidence == null;
  const useIncomingLocationExtraction =
    preferIncomingSource ||
    currentCanonical.locationStatus == null ||
    currentCanonical.locationConfidence == null;
  const useIncomingDescriptionExtraction =
    preferIncomingSource ||
    currentCanonical.descriptionStatus == null ||
    currentCanonical.descriptionConfidence == null;
  const useIncomingWorkModeExtraction =
    preferIncomingSource ||
    currentCanonical.workModeStatus == null ||
    currentCanonical.workModeConfidence == null;
  const useIncomingEmploymentTypeExtraction =
    preferIncomingSource ||
    currentCanonical.employmentTypeStatus == null ||
    currentCanonical.employmentTypeConfidence == null;
  const useIncomingExperienceLevelExtraction =
    preferIncomingSource ||
    currentCanonical.experienceLevelGroup == null ||
    currentCanonical.normalizedCareerStageConfidence == null;
  const useIncomingRoleCategoryExtraction =
    preferIncomingSource ||
    currentCanonical.normalizedRoleCategoryGroup == null ||
    currentCanonical.normalizedRoleCategoryStatus == null ||
    currentCanonical.normalizedRoleCategorySource == null ||
    currentCanonical.normalizedRoleCategoryConfidence == null;
  const useIncomingDatePostedExtraction =
    preferIncomingSource ||
    currentCanonical.datePostedStatus == null ||
    currentCanonical.datePostedConfidence == null;
  const useIncomingDeadlineExtraction =
    preferIncomingSource ||
    currentCanonical.applicationDeadlineStatus == null ||
    currentCanonical.applicationDeadlineConfidence == null;
  const normalizedEmploymentType = chooseCanonicalStringValue({
    currentValue: currentCanonical.normalizedEmploymentType ?? "UNKNOWN",
    nextValue: normalizedJob.normalizedEmploymentType,
    preferNext: preferIncomingSource,
    unknownValues: ["UNKNOWN"],
  });
  const normalizedCareerStage = chooseCanonicalStringValue({
    currentValue: currentCanonical.normalizedCareerStage ?? "UNKNOWN",
    nextValue: normalizedJob.normalizedCareerStage,
    preferNext: preferIncomingSource,
    unknownValues: ["UNKNOWN"],
  });
  const normalizedIndustry = chooseCanonicalStringValue({
    currentValue: coerceNormalizedIndustry(currentCanonical.normalizedIndustry),
    nextValue: normalizedJob.normalizedIndustry,
    preferNext: preferIncomingSource,
    unknownValues: ["UNKNOWN", "OTHER_UNKNOWN"],
  });
  const normalizedIndustries =
    normalizedJob.normalizedIndustries.length > 0
      ? normalizedJob.normalizedIndustries
      : normalizeCompanyIndustryValues(currentCanonical.normalizedIndustries, normalizedIndustry);
  const normalizedRoleCategory = chooseCanonicalStringValue({
    currentValue: currentCanonical.normalizedRoleCategory ?? "OTHER_UNKNOWN",
    nextValue: normalizedJob.normalizedRoleCategory,
    preferNext: preferIncomingSource,
    unknownValues: ["OTHER_UNKNOWN"],
  });
  const normalizedEmploymentTypeConfidence = chooseCanonicalMetadataConfidence({
    currentValue: currentCanonical.normalizedEmploymentType ?? "UNKNOWN",
    nextValue: normalizedJob.normalizedEmploymentType,
    chosenValue: normalizedEmploymentType,
    currentConfidence: currentCanonical.normalizedEmploymentTypeConfidence,
    nextConfidence: normalizedJob.normalizedEmploymentTypeConfidence,
  });
  const normalizedCareerStageConfidence = chooseCanonicalMetadataConfidence({
    currentValue: currentCanonical.normalizedCareerStage ?? "UNKNOWN",
    nextValue: normalizedJob.normalizedCareerStage,
    chosenValue: normalizedCareerStage,
    currentConfidence: currentCanonical.normalizedCareerStageConfidence,
    nextConfidence: normalizedJob.normalizedCareerStageConfidence,
  });
  const normalizedIndustryConfidence = chooseCanonicalMetadataConfidence({
    currentValue: coerceNormalizedIndustry(currentCanonical.normalizedIndustry),
    nextValue: normalizedJob.normalizedIndustry,
    chosenValue: normalizedIndustry,
    currentConfidence: currentCanonical.normalizedIndustryConfidence,
    nextConfidence: normalizedJob.normalizedIndustryConfidence,
  });
  const normalizedRoleCategoryConfidence = chooseCanonicalMetadataConfidence({
    currentValue: currentCanonical.normalizedRoleCategory ?? "OTHER_UNKNOWN",
    nextValue: normalizedJob.normalizedRoleCategory,
    chosenValue: normalizedRoleCategory,
    currentConfidence: currentCanonical.normalizedRoleCategoryConfidence,
    nextConfidence: normalizedJob.normalizedRoleCategoryConfidence,
  });
  const usingIncomingMetadata =
    normalizedEmploymentType === normalizedJob.normalizedEmploymentType &&
    normalizedCareerStage === normalizedJob.normalizedCareerStage &&
    normalizedIndustry === normalizedJob.normalizedIndustry &&
    normalizedRoleCategory === normalizedJob.normalizedRoleCategory;
  const usingIncomingRoleCategory =
    normalizedRoleCategory === normalizedJob.normalizedRoleCategory ||
    useIncomingRoleCategoryExtraction;

  const canonicalJob = await prisma.jobCanonical.update({
    where: { id: currentCanonical.id },
    data: {
      companyId: shouldReplaceGenericCompany
        ? companyRecord.id
        : (currentCanonical.companyId ?? companyRecord.id),
      title: chooseCanonicalStringValue({
        currentValue: currentCanonical.title,
        nextValue: normalizedJob.title,
        preferNext: preferIncomingSource,
      }),
      displayTitle: chooseCanonicalNullableValue({
        currentValue: currentCanonical.displayTitle,
        nextValue: normalizedJob.displayTitle ?? null,
        preferNext: useIncomingTitleExtraction,
      }),
      titleConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.titleConfidence,
        nextValue: normalizedJob.titleConfidence,
        preferNext: useIncomingTitleExtraction,
      }),
      titleStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.titleStatus,
        nextValue: normalizedJob.titleStatus,
        preferNext: useIncomingTitleExtraction,
      }),
      titleSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.titleSource,
        nextValue: normalizedJob.titleSource,
        preferNext: useIncomingTitleExtraction,
      }),
      titleCandidatesJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.titleCandidatesJson,
        nextValue: normalizedJob.titleCandidatesJson ?? null,
        preferNext: useIncomingTitleExtraction,
      }),
      titleRejectedFragmentsJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.titleRejectedFragmentsJson,
        nextValue: normalizedJob.titleRejectedFragmentsJson ?? null,
        preferNext: useIncomingTitleExtraction,
      }),
      titleExtractionWarnings: chooseCanonicalJsonValue({
        currentValue: currentCanonical.titleExtractionWarnings,
        nextValue: normalizedJob.titleExtractionWarnings ?? null,
        preferNext: useIncomingTitleExtraction,
      }),
      jobPageType: chooseCanonicalNullableValue({
        currentValue: currentCanonical.jobPageType,
        nextValue: normalizedJob.jobPageType ?? null,
        preferNext: useIncomingTitleExtraction,
      }),
      company: chooseCanonicalStringValue({
        currentValue: currentCanonical.company,
        nextValue: normalizedJob.company,
        preferNext:
          shouldUseCompanyRecordName ||
          preferIncomingSource ||
          shouldReplaceGenericCompany,
        unknownValues: GENERIC_ATS_COMPANY_UNKNOWN_VALUES,
      }),
      companyKey: chooseCanonicalStringValue({
        currentValue: currentCanonical.companyKey,
        nextValue: normalizedJob.companyKey,
        preferNext: preferIncomingSource || shouldReplaceGenericCompany,
        unknownValues: GENERIC_ATS_COMPANY_KEY_UNKNOWN_VALUES,
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
      locationConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.locationConfidence,
        nextValue: normalizedJob.locationConfidence,
        preferNext: useIncomingLocationExtraction,
      }),
      locationStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.locationStatus,
        nextValue: normalizedJob.locationStatus,
        preferNext: useIncomingLocationExtraction,
      }),
      locationSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.locationSource,
        nextValue: normalizedJob.locationSource,
        preferNext: useIncomingLocationExtraction,
      }),
      locationCandidatesJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.locationCandidatesJson,
        nextValue: normalizedJob.locationCandidatesJson ?? null,
        preferNext: useIncomingLocationExtraction,
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
      workModeConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.workModeConfidence,
        nextValue: normalizedJob.workModeConfidence,
        preferNext: useIncomingWorkModeExtraction,
      }),
      workModeStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.workModeStatus,
        nextValue: normalizedJob.workModeStatus,
        preferNext: useIncomingWorkModeExtraction,
      }),
      workModeSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.workModeSource,
        nextValue: normalizedJob.workModeSource,
        preferNext: useIncomingWorkModeExtraction,
      }),
      workModeCandidatesJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.workModeCandidatesJson,
        nextValue: normalizedJob.workModeCandidatesJson ?? null,
        preferNext: useIncomingWorkModeExtraction,
      }),
      salaryMin: useIncomingSalary ? normalizedJob.salaryMin : currentCanonical.salaryMin,
      salaryMax: useIncomingSalary ? normalizedJob.salaryMax : currentCanonical.salaryMax,
      salaryCurrency: useIncomingSalary
        ? normalizedJob.salaryCurrency ?? currentCanonical.salaryCurrency
        : currentCanonical.salaryCurrency ?? normalizedJob.salaryCurrency,
      salaryStatus: useIncomingSalary
        ? normalizedJob.salaryStatus
        : currentCanonical.salaryStatus ?? normalizedJob.salaryStatus,
      salaryPeriod: useIncomingSalary
        ? normalizedJob.salaryPeriod
        : currentCanonical.salaryPeriod ?? normalizedJob.salaryPeriod,
      salaryRawText: useIncomingSalary
        ? normalizedJob.salaryRawText
        : currentCanonical.salaryRawText ?? normalizedJob.salaryRawText,
      salaryConfidence: useIncomingSalary
        ? normalizedJob.salaryConfidence
        : currentCanonical.salaryConfidence ?? normalizedJob.salaryConfidence,
      salarySource: useIncomingSalary
        ? normalizedJob.salarySource
        : currentCanonical.salarySource ?? normalizedJob.salarySource,
      employmentType: chooseCanonicalEnumValue({
        currentValue: currentCanonical.employmentType,
        nextValue: normalizedJob.employmentType,
        preferNext: preferIncomingSource,
        unknownValue: "UNKNOWN",
      }),
      employmentTypeGroup: chooseCanonicalNullableValue({
        currentValue: currentCanonical.employmentTypeGroup,
        nextValue: normalizedJob.employmentTypeGroup,
        preferNext: useIncomingEmploymentTypeExtraction,
      }),
      employmentTypeConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.employmentTypeConfidence,
        nextValue: normalizedJob.employmentTypeConfidence,
        preferNext: useIncomingEmploymentTypeExtraction,
      }),
      employmentTypeStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.employmentTypeStatus,
        nextValue: normalizedJob.employmentTypeStatus,
        preferNext: useIncomingEmploymentTypeExtraction,
      }),
      employmentTypeSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.employmentTypeSource,
        nextValue: normalizedJob.employmentTypeSource,
        preferNext: useIncomingEmploymentTypeExtraction,
      }),
      employmentTypeCandidatesJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.employmentTypeCandidatesJson,
        nextValue: normalizedJob.employmentTypeCandidatesJson ?? null,
        preferNext: useIncomingEmploymentTypeExtraction,
      }),
      experienceLevel: chooseCanonicalEnumValue({
        currentValue: currentCanonical.experienceLevel,
        nextValue: normalizedJob.experienceLevel,
        preferNext: useIncomingExperienceLevelExtraction,
        unknownValue: "UNKNOWN",
      }),
      experienceLevelGroup: chooseCanonicalNullableValue({
        currentValue: currentCanonical.experienceLevelGroup,
        nextValue: normalizedJob.experienceLevelGroup,
        preferNext: useIncomingExperienceLevelExtraction,
      }),
      experienceLevelSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.experienceLevelSource,
        nextValue: normalizedJob.experienceLevelSource,
        preferNext: useIncomingExperienceLevelExtraction,
      }),
      experienceLevelEvidenceJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.experienceLevelEvidenceJson,
        nextValue: normalizedJob.experienceLevelEvidenceJson ?? null,
        preferNext: useIncomingExperienceLevelExtraction,
      }),
      experienceLevelWarningsJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.experienceLevelWarningsJson,
        nextValue: normalizedJob.experienceLevelWarningsJson ?? null,
        preferNext: useIncomingExperienceLevelExtraction,
      }),
      description: chooseCanonicalDescription({
        currentValue: currentCanonical.description,
        nextValue: normalizedJob.description,
        preferNext: preferIncomingSource,
      }),
      descriptionStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.descriptionStatus,
        nextValue: normalizedJob.descriptionStatus,
        preferNext: useIncomingDescriptionExtraction,
      }),
      descriptionConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.descriptionConfidence,
        nextValue: normalizedJob.descriptionConfidence,
        preferNext: useIncomingDescriptionExtraction,
      }),
      descriptionWordCount: chooseCanonicalNullableValue({
        currentValue: currentCanonical.descriptionWordCount,
        nextValue: normalizedJob.descriptionWordCount,
        preferNext: useIncomingDescriptionExtraction,
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
      normalizedEmploymentType,
      normalizedEmploymentTypeConfidence,
      normalizedCareerStage,
      normalizedCareerStageConfidence,
      normalizedIndustry,
      normalizedIndustries,
      normalizedIndustryConfidence,
      normalizedRoleCategory,
      normalizedRoleCategoryConfidence,
      normalizedRoleCategoryGroup: usingIncomingRoleCategory
        ? normalizedJob.normalizedRoleCategoryGroup
        : currentCanonical.normalizedRoleCategoryGroup ?? normalizedJob.normalizedRoleCategoryGroup,
      normalizedRoleCategoryStatus: usingIncomingRoleCategory
        ? normalizedJob.normalizedRoleCategoryStatus
        : currentCanonical.normalizedRoleCategoryStatus ?? normalizedJob.normalizedRoleCategoryStatus,
      normalizedRoleCategorySource: usingIncomingRoleCategory
        ? normalizedJob.normalizedRoleCategorySource
        : currentCanonical.normalizedRoleCategorySource ?? normalizedJob.normalizedRoleCategorySource,
      normalizedRoleCategoryCandidatesJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.normalizedRoleCategoryCandidatesJson,
        nextValue: normalizedJob.normalizedRoleCategoryCandidatesJson ?? null,
        preferNext: usingIncomingRoleCategory,
      }),
      normalizedRoleCategoryEvidenceJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.normalizedRoleCategoryEvidenceJson,
        nextValue: normalizedJob.normalizedRoleCategoryEvidenceJson ?? null,
        preferNext: usingIncomingRoleCategory,
      }),
      normalizedRoleCategoryWarningsJson: chooseCanonicalJsonValue({
        currentValue: currentCanonical.normalizedRoleCategoryWarningsJson,
        nextValue: normalizedJob.normalizedRoleCategoryWarningsJson ?? null,
        preferNext: usingIncomingRoleCategory,
      }),
      classificationStatus: usingIncomingMetadata
        ? normalizedJob.classificationStatus
        : (currentCanonical.classificationStatus ?? normalizedJob.classificationStatus),
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
      datePostedConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.datePostedConfidence,
        nextValue: normalizedJob.datePostedConfidence,
        preferNext: useIncomingDatePostedExtraction,
      }),
      datePostedStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.datePostedStatus,
        nextValue: normalizedJob.datePostedStatus,
        preferNext: useIncomingDatePostedExtraction,
      }),
      datePostedSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.datePostedSource,
        nextValue: normalizedJob.datePostedSource,
        preferNext: useIncomingDatePostedExtraction,
      }),
      datePostedRawText: chooseCanonicalNullableValue({
        currentValue: currentCanonical.datePostedRawText,
        nextValue: normalizedJob.datePostedRawText,
        preferNext: useIncomingDatePostedExtraction,
      }),
      deadline: choosePreferredDeadline(currentCanonical.deadline, normalizedJob.deadline),
      applicationDeadlineConfidence: chooseCanonicalNullableValue({
        currentValue: currentCanonical.applicationDeadlineConfidence,
        nextValue: normalizedJob.applicationDeadlineConfidence,
        preferNext: useIncomingDeadlineExtraction,
      }),
      applicationDeadlineStatus: chooseCanonicalNullableValue({
        currentValue: currentCanonical.applicationDeadlineStatus,
        nextValue: normalizedJob.applicationDeadlineStatus,
        preferNext: useIncomingDeadlineExtraction,
      }),
      applicationDeadlineSource: chooseCanonicalNullableValue({
        currentValue: currentCanonical.applicationDeadlineSource,
        nextValue: normalizedJob.applicationDeadlineSource,
        preferNext: useIncomingDeadlineExtraction,
      }),
      applicationDeadlineRawText: chooseCanonicalNullableValue({
        currentValue: currentCanonical.applicationDeadlineRawText,
        nextValue: normalizedJob.applicationDeadlineRawText,
        preferNext: useIncomingDeadlineExtraction,
      }),
      duplicateClusterId: chooseCanonicalNullableValue({
        currentValue: currentCanonical.duplicateClusterId,
        nextValue: normalizedJob.duplicateClusterId,
        preferNext: preferIncomingSource,
      }),
      extractionWarnings: chooseCanonicalJsonValue({
        currentValue: currentCanonical.extractionWarnings,
        nextValue: normalizedJob.extractionWarnings ?? null,
        preferNext: preferIncomingSource || currentCanonical.extractionWarnings == null,
      }),
      metadataExtractionWarnings: chooseCanonicalJsonValue({
        currentValue: currentCanonical.metadataExtractionWarnings,
        nextValue: normalizedJob.metadataExtractionWarnings ?? null,
        preferNext: preferIncomingSource || currentCanonical.metadataExtractionWarnings == null,
      }),
      extractionRejectionReasons: chooseCanonicalJsonValue({
        currentValue: currentCanonical.extractionRejectionReasons,
        nextValue: normalizedJob.extractionRejectionReasons ?? null,
        preferNext: preferIncomingSource || currentCanonical.extractionRejectionReasons == null,
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

export async function upsertSourceMapping({
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
  connector: Pick<SourceConnector, "key" | "sourceName" | "sourceTier" | "freshnessMode">;
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

export async function upsertEligibility(
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
      applyUrlValidationStatus: true,
      applyUrlValidationReason: true,
      finalResolvedApplyUrl: true,
      applyUrlRedirectDepth: true,
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
    nextLifecycleData.applyUrlValidationStatus !== canonicalJob.applyUrlValidationStatus ||
    nextLifecycleData.applyUrlValidationReason !== canonicalJob.applyUrlValidationReason ||
    nextLifecycleData.finalResolvedApplyUrl !== canonicalJob.finalResolvedApplyUrl ||
    nextLifecycleData.applyUrlRedirectDepth !== canonicalJob.applyUrlRedirectDepth ||
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
  const applyUrlValidationStatus =
    applyCheckOutcome?.validationStatus ?? canonicalJob.applyUrlValidationStatus;
  const applyUrlValidationReason =
    applyCheckOutcome?.validationReason ?? canonicalJob.applyUrlValidationReason;
  const finalResolvedApplyUrl =
    applyCheckOutcome?.finalResolvedApplyUrl ?? canonicalJob.finalResolvedApplyUrl;
  const applyUrlRedirectDepth =
    applyCheckOutcome?.redirectDepth ?? canonicalJob.applyUrlRedirectDepth;
  const computed = computeLifecycleState({
    canonicalJob: {
      ...canonicalJob,
      lastApplyCheckAt,
      lastConfirmedAliveAt,
      applyUrlValidationStatus,
      applyUrlValidationReason,
      finalResolvedApplyUrl,
      applyUrlRedirectDepth,
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
    applyUrlValidationStatus,
    applyUrlValidationReason,
    finalResolvedApplyUrl,
    applyUrlRedirectDepth,
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
  validationStatus: string | null;
  validationReason: string | null;
  finalResolvedApplyUrl: string | null;
  redirectDepth: number | null;
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
    | "applyUrlValidationStatus"
    | "applyUrlValidationReason"
    | "finalResolvedApplyUrl"
    | "applyUrlRedirectDepth"
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
  const strongRemovalEvidence = hasStrongRemovalEvidence(removedMappings, now);

  if (activeMappings.length === 0 && strongRemovalEvidence) {
    return {
      status: "REMOVED" as JobStatus,
      availabilityScore: 0,
      lastSeenAt: lastEvidenceAt,
      lastSourceSeenAt,
    };
  }

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
    hasBadApplyLinkValidationStatus(canonicalJob.applyUrlValidationStatus) ||
    (canonicalJob.deadSignalAt &&
      (!canonicalJob.lastConfirmedAliveAt ||
        canonicalJob.deadSignalAt.getTime() >= canonicalJob.lastConfirmedAliveAt.getTime()))
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
  const {
    liveMinScore,
    agingMinScore,
    staleMinScore,
  } = LIFECYCLE_PROFILE.statusThresholds;

  const availabilityScore = Math.max(
    confirmationFloor,
    clampScore(
    activeEvidenceScore + consistencyBonus + confirmationBonus - agePenalty - removalPenalty
    )
  );
  let status: JobStatus;
  if (availabilityScore >= liveMinScore) status = "LIVE";
  else if (availabilityScore >= agingMinScore) status = "AGING";
  else if (availabilityScore >= staleMinScore) status = "STALE";
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
  const recencyWindows = LIFECYCLE_PROFILE.activeMappingRecencyHours;
  const recencyFactor =
    hoursSinceSeen <= recencyWindows.hottest
      ? 1
      : hoursSinceSeen <= recencyWindows.warm
        ? 0.92
        : hoursSinceSeen <= recencyWindows.recent
          ? 0.78
          : hoursSinceSeen <= recencyWindows.aging
            ? 0.6
            : hoursSinceSeen <= recencyWindows.stale
              ? 0.42
              : hoursSinceSeen <= recencyWindows.longTail
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

  return Math.min(
    activeMappingsCount > 0
      ? LIFECYCLE_PROFILE.removalPenaltyCaps.withActiveMappings
      : LIFECYCLE_PROFILE.removalPenaltyCaps.withoutActiveMappings,
    rawPenalty
  );
}

function scoreConfirmationEvidence(lastConfirmedAliveAt: Date | null, now: Date) {
  if (!lastConfirmedAliveAt) return 0;

  const daysSinceConfirmed =
    (now.getTime() - lastConfirmedAliveAt.getTime()) / (24 * 60 * 60 * 1000);
  const bonusWindows = LIFECYCLE_PROFILE.confirmationBonusDays;

  if (daysSinceConfirmed <= bonusWindows.hottest) return 15;
  if (daysSinceConfirmed <= bonusWindows.warm) return 12;
  if (daysSinceConfirmed <= bonusWindows.recent) return 8;
  if (daysSinceConfirmed <= bonusWindows.aging) return 4;
  if (daysSinceConfirmed <= bonusWindows.stale) return 1;
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
  const windows = LIFECYCLE_PROFILE.confirmationWindowsDays;
  const floors = LIFECYCLE_PROFILE.confirmationFloorScores;

  // A URL confirmed alive within the live-floor window is the strongest freshness signal —
  // treat as LIVE regardless of whether sources are currently listing the job.
  // Aggregator/board sources routinely drop and re-add listings without the
  // underlying job closing, so active mapping count is a poor proxy for liveness.
  if (daysSinceConfirmed <= windows.liveFloor) {
    return floors.live;
  }

  if (daysSinceConfirmed <= windows.agingFloor) {
    return activeMappingsCount > 0
      ? floors.agingWithActiveMappings
      : floors.agingWithoutActiveMappings;
  }

  if (daysSinceConfirmed <= windows.staleFloor) {
    return activeMappingsCount > 0
      ? floors.staleWithActiveMappings
      : floors.staleWithoutActiveMappings;
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
      daysSinceRemoved <= LIFECYCLE_PROFILE.strongRemovalEvidenceWindowDays &&
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

  if (hoursSinceLastApplyCheck < LIFECYCLE_PROFILE.applyUrlCheckIntervalHours) {
    return false;
  }

  return (
    activeMappingsCount === 0 ||
    provisionalScore < LIFECYCLE_PROFILE.statusThresholds.agingMinScore
  );
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
        "User-Agent": "Mozilla/5.0 (compatible; applyoverflow-lifecycle-check/1.0)",
      },
    });

    const status = response.status;

    if ([404, 410, 451].includes(status)) {
      return {
        checkedAt: now,
        aliveConfirmedAt: null,
        deadSignalAt: now,
        deadSignalReason: `Apply URL returned HTTP ${status}.`,
        validationStatus: APPLY_LINK_VALIDATION_STATUS.BROKEN_APPLY_LINK,
        validationReason: `Apply URL returned HTTP ${status}.`,
        finalResolvedApplyUrl: response.url,
        redirectDepth: response.redirected ? 1 : 0,
      };
    }

    if (response.ok && isClearlyGenericFinalApplyUrl(applyUrl, response.url)) {
      return {
        checkedAt: now,
        aliveConfirmedAt: null,
        deadSignalAt: now,
        deadSignalReason: "Apply URL redirects to a generic careers/search page.",
        validationStatus: APPLY_LINK_VALIDATION_STATUS.GENERIC_APPLY_PAGE,
        validationReason: "Apply URL redirects to a generic careers/search page.",
        finalResolvedApplyUrl: response.url,
        redirectDepth: response.redirected ? 1 : 0,
      };
    }

    if (response.ok || (status >= 300 && status < 400)) {
      return {
        checkedAt: now,
        aliveConfirmedAt: now,
        deadSignalAt: null,
        deadSignalReason: null,
        validationStatus: APPLY_LINK_VALIDATION_STATUS.ACTIVE,
        validationReason: null,
        finalResolvedApplyUrl: response.url,
        redirectDepth: response.redirected ? 1 : 0,
      };
    }

    // 405 (HEAD not supported), 4xx, 5xx etc. — treat as unknown
    return {
      checkedAt: now,
      aliveConfirmedAt: null,
      deadSignalAt: null,
      deadSignalReason: null,
      validationStatus: APPLY_LINK_VALIDATION_STATUS.NEEDS_REVALIDATION,
      validationReason: `Apply URL returned HTTP ${status}.`,
      finalResolvedApplyUrl: response.url,
      redirectDepth: response.redirected ? 1 : 0,
    };
  } catch {
    return {
      checkedAt: now,
      aliveConfirmedAt: null,
      deadSignalAt: null,
      deadSignalReason: null,
      validationStatus: APPLY_LINK_VALIDATION_STATUS.NEEDS_REVALIDATION,
      validationReason: "Apply URL availability check failed.",
      finalResolvedApplyUrl: applyUrl,
      redirectDepth: null,
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

function sanitizeJsonForPostgres(value: Prisma.InputJsonValue): Prisma.InputJsonValue {
  if (typeof value === "string") {
    return stripUnsafeChars(value) ?? "";
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeJsonForPostgres(entry as Prisma.InputJsonValue)
    ) as Prisma.InputJsonArray;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, Prisma.InputJsonValue | null>).map(
      ([key, entry]) => [
        stripUnsafeChars(key) ?? key,
        entry == null ? entry : sanitizeJsonForPostgres(entry),
      ]
    )
  ) as Prisma.InputJsonObject;
}

function buildRawPayload(
  connector: Pick<SourceConnector, "sourceName" | "freshnessMode">,
  sourceJob: SourceConnectorJob,
  fetchedAt: Date
) {
  const provenance = deriveSourceProvenanceMetadata({
    sourceName: connector.sourceName,
    sourceId: sourceJob.sourceId,
    sourceUrl: sourceJob.sourceUrl,
    applyUrl: sourceJob.applyUrl,
    metadata: sourceJob.metadata,
    freshnessMode: connector.freshnessMode,
  });

  return {
    title: stripUnsafeChars(sourceJob.title) ?? "",
    company: stripUnsafeChars(sourceJob.company) ?? "",
    location: stripUnsafeChars(sourceJob.location) ?? "",
    description: stripUnsafeChars(sourceJob.description),
    applyUrl: stripUnsafeChars(sourceJob.applyUrl) ?? "",
    sourceUrl: stripUnsafeChars(sourceJob.sourceUrl) ?? null,
    postedAt: sourceJob.postedAt?.toISOString() ?? null,
    deadline: sourceJob.deadline?.toISOString() ?? null,
    salaryMin: sourceJob.salaryMin,
    salaryMax: sourceJob.salaryMax,
    salaryCurrency: stripUnsafeChars(sourceJob.salaryCurrency) ?? null,
    fetchedAt: fetchedAt.toISOString(),
    metadata: sanitizeJsonForPostgres(mergeSourceMetadata(sourceJob.metadata, provenance)),
  } as Prisma.InputJsonValue;
}

function mergeSourceMetadata(
  metadata: Prisma.InputJsonValue,
  provenance: ReturnType<typeof deriveSourceProvenanceMetadata>
) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return {
      ...(metadata as Record<string, Prisma.InputJsonValue | null>),
      provenance,
    } satisfies Record<string, Prisma.InputJsonValue | null>;
  }

  return {
    providerMetadata: metadata,
    provenance,
  } satisfies Record<string, Prisma.InputJsonValue | null>;
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

function shouldIncomingSourceUpdateCanonicalFields(input: {
  currentPrimaryRank: number;
  incomingRank: number;
  incomingOriginPreference: string | null | undefined;
}) {
  if (input.currentPrimaryRank <= 0) {
    return true;
  }

  if (input.incomingOriginPreference === "PRIMARY") {
    return input.incomingRank >= input.currentPrimaryRank;
  }

  if (input.incomingOriginPreference === "SECONDARY") {
    return input.incomingRank > input.currentPrimaryRank;
  }

  // Aggregators and weak scraped copies are useful as discovery/fallback
  // mappings, but they should not churn canonical user-facing fields unless
  // the current primary source is also weak and the incoming source is better.
  return input.currentPrimaryRank < 200 && input.incomingRank > input.currentPrimaryRank;
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
  nextValue: T | null | undefined;
  preferNext: boolean;
}) {
  if (preferNext && nextValue != null) return nextValue;
  if (currentValue != null) return currentValue;
  return nextValue;
}

function chooseCanonicalJsonValue({
  currentValue,
  nextValue,
  preferNext,
}: {
  currentValue: Prisma.JsonValue | null;
  nextValue: Prisma.InputJsonValue | null | undefined;
  preferNext: boolean;
}) {
  const selected =
    preferNext && nextValue != null
      ? nextValue
      : currentValue != null
        ? currentValue
        : nextValue;

  return selected == null ? undefined : (selected as Prisma.InputJsonValue);
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

function chooseCanonicalMetadataConfidence({
  currentValue,
  nextValue,
  chosenValue,
  currentConfidence,
  nextConfidence,
}: {
  currentValue: string;
  nextValue: string;
  chosenValue: string;
  currentConfidence: number | null;
  nextConfidence: number;
}) {
  if (chosenValue === nextValue && chosenValue !== currentValue) {
    return nextConfidence;
  }

  if (chosenValue === currentValue && chosenValue !== nextValue) {
    return currentConfidence ?? null;
  }

  if (chosenValue === nextValue && chosenValue === currentValue) {
    return Math.max(currentConfidence ?? 0, nextConfidence);
  }

  return currentConfidence ?? nextConfidence;
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
