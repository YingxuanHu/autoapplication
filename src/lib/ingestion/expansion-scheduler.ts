import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { reconcileCanonicalLifecycleByIds } from "@/lib/ingestion/pipeline";
import {
  claimPipelineTasks,
  enqueueUniquePipelineTask,
  finishPipelineTask,
  readPipelinePayload,
} from "@/lib/ingestion/pipeline-queue";
import { upsertJobFeedIndex } from "@/lib/ingestion/search-index";
import {
  canonicalizeNormalizedJobRecord,
} from "@/lib/ingestion/staged-pipeline";
import { upsertNormalizedJobRecordFromRawJob } from "@/lib/ingestion/normalized-records";
import {
  listSourceCandidatesForExploration,
  promoteSourceCandidate,
  rejectSourceCandidate,
} from "@/lib/ingestion/discovery/source-registry";
import { buildDiscoveredSourceName } from "@/lib/ingestion/discovery/sources";
import type {
  AtsPlatform,
  CompanySource,
  DiscoveryMode,
  PipelineQueueName,
  SourceCandidateType,
} from "@/generated/prisma/client";
import type { SupportedConnectorName } from "@/lib/ingestion/registry";

function mapAtsPlatformToConnectorName(platform: AtsPlatform) {
  switch (platform) {
    case "ASHBY":
      return "ashby";
    case "GREENHOUSE":
      return "greenhouse";
    case "ICIMS":
      return "icims";
    case "JOBVITE":
      return "jobvite";
    case "LEVER":
      return "lever";
    case "RECRUITEE":
      return "recruitee";
    case "RIPPLING":
      return "rippling";
    case "SMARTRECRUITERS":
      return "smartrecruiters";
    case "SUCCESSFACTORS":
      return "successfactors";
    case "TALEO":
      return "taleo";
    case "TEAMTAILOR":
      return "teamtailor";
    case "WORKABLE":
      return "workable";
    case "WORKDAY":
      return "workday";
    default:
      return null;
  }
}

export function computeExplorationPriorityScore(input: {
  noveltyScore: number;
  coverageGapScore: number;
  potentialYieldScore: number;
  sourceQualityScore: number;
  failureCount: number;
  confidence: number;
  candidateType: SourceCandidateType;
  status: "NEW" | "VALIDATED" | "PROMOTED" | "REJECTED" | "STALE";
  hasAtsTenant: boolean;
}) {
  const candidateTypeBonus = getExplorationCandidateTypeBonus(input.candidateType);
  const statusBonus =
    input.status === "VALIDATED" ? 35 : input.status === "STALE" ? -8 : 0;
  const atsTenantBonus = input.hasAtsTenant ? 10 : 0;

  return (
    input.noveltyScore * 1.35 +
    input.coverageGapScore * 1.2 +
    input.potentialYieldScore * 1.15 +
    input.sourceQualityScore * 0.7 +
    input.confidence * 0.5 -
    input.failureCount * 10 +
    candidateTypeBonus +
    statusBonus +
    atsTenantBonus
  );
}

function getExplorationCandidateTypeBonus(candidateType: SourceCandidateType) {
  switch (candidateType) {
    case "ATS_BOARD":
      return 24;
    case "CAREER_PAGE":
      return 18;
    case "SITEMAP":
      return 10;
    case "JOB_PAGE":
      return 6;
    case "COMPANY_ROOT":
      return 2;
    case "AGGREGATOR_LEAD":
      return -6;
    default:
      return 0;
  }
}

export function computeExploitationPriorityScore(input: Pick<
  CompanySource,
  | "priorityScore"
  | "yieldScore"
  | "sourceQualityScore"
  | "pollSuccessCount"
  | "failureStreak"
  | "retainedLiveJobCount"
  | "jobsCreatedCount"
>) {
  return (
    input.priorityScore * 0.35 +
    input.yieldScore * 0.3 +
    input.sourceQualityScore * 0.2 +
    Math.min(input.retainedLiveJobCount, 200) * 0.15 +
    Math.min(input.jobsCreatedCount, 200) * 0.2 +
    Math.min(input.pollSuccessCount, 50) * 0.25 -
    input.failureStreak * 8
  );
}

export async function scheduleExplorationPipeline(limit = 500) {
  const candidates = await listSourceCandidatesForExploration(limit);
  let queued = 0;

  for (const candidate of candidates) {
    const queueName: PipelineQueueName =
      candidate.status === "NEW" ? "SOURCE_DISCOVERY" : "SOURCE_VALIDATION";
    const priorityScore = computeExplorationPriorityScore({
      noveltyScore: candidate.noveltyScore,
      coverageGapScore: candidate.coverageGapScore,
      potentialYieldScore: candidate.potentialYieldScore,
      sourceQualityScore: candidate.sourceQualityScore,
      failureCount: candidate.failureCount,
      confidence: candidate.confidence,
      candidateType: candidate.candidateType,
      status: candidate.status,
      hasAtsTenant: Boolean(candidate.atsTenantId),
    });

    await enqueueUniquePipelineTask({
      queueName,
      mode: "EXPLORATION",
      priorityScore,
      idempotencyKey: candidate.id,
      payloadJson: {
        sourceCandidateId: candidate.id,
      },
    });
    queued += 1;
  }

  return {
    considered: candidates.length,
    queued,
  };
}

export async function scheduleExploitationPipeline(options: {
  rawParseLimit?: number;
  dedupeLimit?: number;
  lifecycleLimit?: number;
  searchIndexLimit?: number;
} = {}) {
  const rawParseLimit = options.rawParseLimit ?? 2_000;
  const dedupeLimit = options.dedupeLimit ?? 2_000;
  const lifecycleLimit = options.lifecycleLimit ?? 2_000;
  const searchIndexLimit = options.searchIndexLimit ?? 2_000;

  const [rawRows, normalizedRows, canonicalRows, indexRows] = await Promise.all([
    prisma.jobRaw.findMany({
      where: { normalizedRecord: null },
      orderBy: { fetchedAt: "desc" },
      take: rawParseLimit,
      select: { id: true },
    }),
    prisma.normalizedJobRecord.findMany({
      where: {
        status: { in: ["VALIDATED", "NORMALIZED"] },
        canonicalJobId: null,
      },
      orderBy: { updatedAt: "desc" },
      take: dedupeLimit,
      select: { id: true },
    }),
    prisma.jobCanonical.findMany({
      where: {
        status: { in: ["LIVE", "AGING", "STALE"] },
      },
      orderBy: [{ freshnessScore: "asc" }, { updatedAt: "asc" }],
      take: lifecycleLimit,
      select: { id: true },
    }),
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT jc.id
      FROM "JobCanonical" jc
      LEFT JOIN "JobFeedIndex" jfi
        ON jfi."canonicalJobId" = jc.id
      WHERE
        jc.status IN ('LIVE', 'AGING', 'STALE')
        AND (
          jfi."canonicalJobId" IS NULL
          OR jfi."indexedAt" < jc."updatedAt"
        )
      ORDER BY
        CASE WHEN jfi."canonicalJobId" IS NULL THEN 0 ELSE 1 END ASC,
        jc."updatedAt" DESC
      LIMIT ${searchIndexLimit}
    `),
  ]);

  let rawQueued = 0;
  for (const row of rawRows) {
    await enqueueUniquePipelineTask({
      queueName: "RAW_PARSE",
      mode: "EXPLOITATION",
      idempotencyKey: row.id,
      priorityScore: 100,
      payloadJson: { rawJobId: row.id },
    });
    rawQueued += 1;
  }

  let dedupeQueued = 0;
  for (const row of normalizedRows) {
    await enqueueUniquePipelineTask({
      queueName: "DEDUPE",
      mode: "EXPLOITATION",
      idempotencyKey: row.id,
      priorityScore: 90,
      payloadJson: { normalizedJobRecordId: row.id },
    });
    dedupeQueued += 1;
  }

  let lifecycleQueued = 0;
  for (const row of canonicalRows) {
    await enqueueUniquePipelineTask({
      queueName: "LIFECYCLE",
      mode: "EXPLOITATION",
      idempotencyKey: row.id,
      priorityScore: 60,
      reactivateOnSuccess: true,
      payloadJson: { canonicalJobId: row.id },
    });
    lifecycleQueued += 1;
  }

  let indexQueued = 0;
  for (const row of indexRows) {
    await enqueueUniquePipelineTask({
      queueName: "SEARCH_INDEX",
      mode: "EXPLOITATION",
      idempotencyKey: row.id,
      priorityScore: 70,
      reactivateOnSuccess: true,
      payloadJson: { canonicalJobId: row.id },
    });
    indexQueued += 1;
  }

  return {
    rawQueued,
    dedupeQueued,
    lifecycleQueued,
    indexQueued,
  };
}

async function processSourceDiscoveryTask(taskId: string, sourceCandidateId: string) {
  await prisma.sourceCandidate.update({
    where: { id: sourceCandidateId },
    data: {
      status: "VALIDATED",
      lastValidatedAt: new Date(),
    },
  });
  await enqueueUniquePipelineTask({
    queueName: "SOURCE_VALIDATION",
    mode: "EXPLORATION",
    priorityScore: 100,
    idempotencyKey: sourceCandidateId,
    payloadJson: {
      sourceCandidateId,
    },
  });
  await finishPipelineTask(taskId, "SUCCESS");
}

async function processSourceValidationTask(taskId: string, sourceCandidateId: string) {
  const candidate = await prisma.sourceCandidate.findUnique({
    where: { id: sourceCandidateId },
    include: {
      atsTenant: true,
    },
  });

  if (!candidate) {
    await finishPipelineTask(taskId, "SKIPPED", {
      lastError: `Missing source candidate ${sourceCandidateId}`,
    });
    return;
  }

  let connectorName: SupportedConnectorName | "company-site" | null = "company-site";
  let token = candidate.rootDomain ?? candidate.id;
  let sourceName = `CompanySite:${candidate.rootDomain ?? candidate.id}`;
  let boardUrl = candidate.candidateUrl;

  if (candidate.atsTenant && candidate.atsTenantKey && candidate.atsPlatform) {
    connectorName = mapAtsPlatformToConnectorName(candidate.atsPlatform);
    if (!connectorName) {
      await rejectSourceCandidate(
        candidate.id,
        `Unsupported ATS platform for promotion: ${candidate.atsPlatform}`
      );
      await finishPipelineTask(taskId, "FAILED", {
        lastError: `Unsupported ATS platform for promotion: ${candidate.atsPlatform}`,
      });
      return;
    }

    token = candidate.atsTenant.tenantKey;
    sourceName = buildDiscoveredSourceName(
      connectorName as SupportedConnectorName,
      candidate.atsTenant.tenantKey
    );
    boardUrl = candidate.atsTenant.normalizedBoardUrl;
  }

  await promoteSourceCandidate({
    sourceCandidateId: candidate.id,
    connectorName,
    token,
    sourceName,
    boardUrl,
    sourceType: candidate.candidateType as SourceCandidateType,
    priorityScore: candidate.potentialYieldScore,
  });
  await finishPipelineTask(taskId, "SUCCESS");
}

async function processRawParseTask(taskId: string, rawJobId: string) {
  await upsertNormalizedJobRecordFromRawJob(rawJobId);
  await finishPipelineTask(taskId, "SUCCESS");
}

async function processDedupeTask(taskId: string, normalizedJobRecordId: string) {
  await canonicalizeNormalizedJobRecord(normalizedJobRecordId);
  await finishPipelineTask(taskId, "SUCCESS");
}

async function processLifecycleTask(taskId: string, canonicalJobId: string) {
  await reconcileCanonicalLifecycleByIds([canonicalJobId]);
  await finishPipelineTask(taskId, "SUCCESS");
}

async function processSearchIndexTask(taskId: string, canonicalJobId: string) {
  await upsertJobFeedIndex(canonicalJobId);
  await finishPipelineTask(taskId, "SUCCESS");
}

export async function runPipelineWorker(options: {
  queueName: PipelineQueueName;
  limit?: number;
  mode?: DiscoveryMode | null;
  concurrency?: number;
}) {
  const concurrency = Math.max(1, options.concurrency ?? defaultQueueConcurrency(options.queueName));
  const claimed = await claimPipelineTasks(
    options.queueName,
    options.limit ?? 50,
    { mode: options.mode ?? null }
  );

  let successCount = 0;
  let failedCount = 0;

  for (let start = 0; start < claimed.length; start += concurrency) {
    const batch = claimed.slice(start, start + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (task) => {
        const payload = readPipelinePayload(task);

        try {
          switch (task.queueName) {
            case "SOURCE_DISCOVERY":
              if (typeof payload.sourceCandidateId !== "string") {
                throw new Error("Missing sourceCandidateId payload.");
              }
              await processSourceDiscoveryTask(task.id, payload.sourceCandidateId);
              break;
            case "SOURCE_VALIDATION":
              if (typeof payload.sourceCandidateId !== "string") {
                throw new Error("Missing sourceCandidateId payload.");
              }
              await processSourceValidationTask(task.id, payload.sourceCandidateId);
              break;
            case "RAW_PARSE":
              if (typeof payload.rawJobId !== "string") {
                throw new Error("Missing rawJobId payload.");
              }
              await processRawParseTask(task.id, payload.rawJobId);
              break;
            case "DEDUPE":
              if (typeof payload.normalizedJobRecordId !== "string") {
                throw new Error("Missing normalizedJobRecordId payload.");
              }
              await processDedupeTask(task.id, payload.normalizedJobRecordId);
              break;
            case "LIFECYCLE":
              if (typeof payload.canonicalJobId !== "string") {
                throw new Error("Missing canonicalJobId payload.");
              }
              await processLifecycleTask(task.id, payload.canonicalJobId);
              break;
            case "SEARCH_INDEX":
              if (typeof payload.canonicalJobId !== "string") {
                throw new Error("Missing canonicalJobId payload.");
              }
              await processSearchIndexTask(task.id, payload.canonicalJobId);
              break;
            default:
              await finishPipelineTask(task.id, "SKIPPED", {
                lastError: `Queue ${task.queueName} is not handled by this worker yet.`,
              });
              break;
          }

          return { success: true } as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryAt =
            task.attemptCount < task.maxAttempts
              ? new Date(Date.now() + Math.min(60_000 * task.attemptCount, 15 * 60_000))
              : null;
          await finishPipelineTask(task.id, "FAILED", {
            lastError: message,
            retryAt,
          });
          return { success: false } as const;
        }
      })
    );

    for (const result of batchResults) {
      if (result.success) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }
  }

  return {
    queueName: options.queueName,
    claimed: claimed.length,
    successCount,
    failedCount,
    concurrency,
  };
}

function defaultQueueConcurrency(queueName: PipelineQueueName) {
  switch (queueName) {
    case "SEARCH_INDEX":
      return 12;
    case "RAW_PARSE":
      return 8;
    case "SOURCE_DISCOVERY":
      return 8;
    case "DEDUPE":
      return 4;
    case "LIFECYCLE":
      return 6;
    case "SOURCE_VALIDATION":
      return 4;
    default:
      return 4;
  }
}
