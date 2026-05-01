import { prisma } from "@/lib/db";
import {
  runPipelineWorker,
  scheduleExploitationPipeline,
  scheduleExplorationPipeline,
} from "@/lib/ingestion/expansion-scheduler";
import { seedSourceRegistryFromExistingSignals } from "@/lib/ingestion/discovery/seed-registry";
import {
  enqueueCompanySourcePollTasks,
  runCompanySourcePollQueue,
  runSourceValidationQueue,
} from "@/lib/ingestion/company-discovery";
import type { DiscoveryMode, PipelineQueueName } from "@/generated/prisma/client";
import { acquireRuntimeLock } from "./_runtime-lock";

let releaseRuntimeLock: (() => Promise<void>) | null = null;

function readArg(name: string) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!exact) return null;
  return exact.slice(name.length + 1);
}

function readIntArg(name: string, fallback: number) {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRuntimeLockKey(options: {
  mode: "all" | "exploration" | "exploitation";
  queueName: PipelineQueueName | null;
  scheduleOnly: boolean;
  workerOnly: boolean;
  skipSeed: boolean;
}) {
  const parts = ["expansion-pipeline", options.mode];
  if (options.queueName) {
    parts.push(options.queueName.toLowerCase());
  }
  if (options.scheduleOnly) parts.push("schedule-only");
  if (options.workerOnly) parts.push("worker-only");
  if (options.skipSeed) parts.push("skip-seed");
  return parts.join(":");
}

async function drainPipelineQueue(options: {
  queueName: PipelineQueueName;
  claimLimit: number;
  mode: DiscoveryMode;
  maxBatches: number;
  concurrency?: number;
}) {
  const batches: Array<Record<string, unknown>> = [];

  for (let batchIndex = 0; batchIndex < options.maxBatches; batchIndex += 1) {
    const result = await runPipelineWorker({
      queueName: options.queueName,
      limit: options.claimLimit,
      mode: options.mode,
      concurrency: options.concurrency,
    });
    batches.push(result);
    if (result.claimed < options.claimLimit) {
      break;
    }
  }

  return batches;
}

function getQueueWorkerConfig(queueName: PipelineQueueName, requestedLimit: number) {
  switch (queueName) {
    case "SOURCE_DISCOVERY":
      return {
        claimLimit: Math.min(requestedLimit, 200),
        concurrency: 8,
      };
    case "SOURCE_VALIDATION":
      return {
        claimLimit: Math.min(requestedLimit, 100),
        concurrency: 4,
      };
    case "RAW_PARSE":
      return {
        claimLimit: Math.min(requestedLimit, 250),
        concurrency: 8,
      };
    case "DEDUPE":
      return {
        claimLimit: Math.min(requestedLimit, 100),
        concurrency: 4,
      };
    case "SEARCH_INDEX":
      return {
        claimLimit: Math.min(requestedLimit, 500),
        concurrency: 12,
      };
    case "LIFECYCLE":
      return {
        claimLimit: Math.min(requestedLimit, 250),
        concurrency: 6,
      };
    default:
      return {
        claimLimit: Math.min(requestedLimit, 100),
        concurrency: 4,
      };
  }
}

async function drainSourceValidationQueue(limit: number, maxBatches: number) {
  const batches: Array<Record<string, unknown>> = [];

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const result = await runSourceValidationQueue({
      limit,
      now: new Date(),
    });
    batches.push(result);
    if ((result.processedCount ?? 0) < limit) {
      break;
    }
  }

  return batches;
}

async function readMetrics(since?: Date) {
  const visibleStatuses = ["LIVE", "AGING", "STALE"] as const;
  const sinceFilter = since
    ? {
        gte: since,
      }
    : undefined;

  const [
    sourceCandidateCount,
    newSourceCandidateCount,
    promotedSourceCandidateCount,
    atsTenantCount,
    newAtsTenantCount,
    companySourceCount,
    newCompanySourceCount,
    rawJobCount,
    newRawJobCount,
    normalizedJobRecordCount,
    newNormalizedJobRecordCount,
    canonicalCount,
    newCanonicalCount,
    visibleCanonicalCount,
    jobFeedIndexCount,
    visibleJobFeedIndexCount,
  ] = await Promise.all([
    prisma.sourceCandidate.count(),
    prisma.sourceCandidate.count({
      where: since ? { createdAt: sinceFilter } : undefined,
    }),
    prisma.sourceCandidate.count({
      where: since ? { promotedAt: sinceFilter } : undefined,
    }),
    prisma.aTSTenant.count(),
    prisma.aTSTenant.count({
      where: since ? { createdAt: sinceFilter } : undefined,
    }),
    prisma.companySource.count(),
    prisma.companySource.count({
      where: since ? { createdAt: sinceFilter } : undefined,
    }),
    prisma.jobRaw.count(),
    prisma.jobRaw.count({
      where: since ? { fetchedAt: sinceFilter } : undefined,
    }),
    prisma.normalizedJobRecord.count(),
    prisma.normalizedJobRecord.count({
      where: since ? { createdAt: sinceFilter } : undefined,
    }),
    prisma.jobCanonical.count(),
    prisma.jobCanonical.count({
      where: since ? { createdAt: sinceFilter } : undefined,
    }),
    prisma.jobCanonical.count({
      where: {
        status: { in: [...visibleStatuses] },
      },
    }),
    prisma.jobFeedIndex.count(),
    prisma.jobFeedIndex.count({
      where: {
        status: { in: [...visibleStatuses] },
      },
    }),
  ]);

  return {
    sourceCandidateCount,
    newSourceCandidateCount,
    promotedSourceCandidateCount,
    atsTenantCount,
    newAtsTenantCount,
    companySourceCount,
    newCompanySourceCount,
    rawJobCount,
    newRawJobCount,
    normalizedJobRecordCount,
    newNormalizedJobRecordCount,
    canonicalCount,
    newCanonicalCount,
    visibleCanonicalCount,
    jobFeedIndexCount,
    visibleJobFeedIndexCount,
  };
}

async function runOnce(options: {
  mode: "all" | "exploration" | "exploitation";
  queueName: PipelineQueueName | null;
  limit: number;
  maxBatches: number;
  rawParseLimit: number;
  dedupeLimit: number;
  lifecycleLimit: number;
  searchIndexLimit: number;
  scheduleOnly: boolean;
  workerOnly: boolean;
  skipSeed: boolean;
  skipMetrics: boolean;
}) {
  const startedAt = new Date();
  const {
    mode,
    queueName,
    limit,
    maxBatches,
    rawParseLimit,
    dedupeLimit,
    lifecycleLimit,
    searchIndexLimit,
    scheduleOnly,
    workerOnly,
    skipSeed,
    skipMetrics,
  } = options;

  const results: Record<string, unknown> = {};
  if (!skipMetrics) {
    results.before = await readMetrics();
  }

  if (!workerOnly) {
    if (mode === "all" || mode === "exploration") {
      if (!skipSeed) {
        results.seed = await seedSourceRegistryFromExistingSignals({
          existingSourceLimit: Math.max(500, limit * 2),
          urlSeedLimit: Math.max(1_000, limit * 4),
          companySeedLimit: Math.max(250, limit * 2),
          companyPageScanLimit: Math.max(100, limit),
          enterpriseSeedLimit: Math.max(150, limit),
          pageDiscoveryConcurrency: 8,
        });
      }
      results.exploration = await scheduleExplorationPipeline(limit);
    }

    if ((mode === "exploitation" || (mode === "all" && scheduleOnly))) {
      results.exploitation = await scheduleExploitationPipeline({
        rawParseLimit,
        dedupeLimit,
        lifecycleLimit,
        searchIndexLimit,
      });
    }
  }

  if (!scheduleOnly) {
    if (queueName) {
      const workerConfig = getQueueWorkerConfig(queueName, limit);
      results.worker = await drainPipelineQueue({
        queueName,
        claimLimit: workerConfig.claimLimit,
        mode:
          mode === "exploration"
            ? ("EXPLORATION" as DiscoveryMode)
            : ("EXPLOITATION" as DiscoveryMode),
        maxBatches,
        concurrency: workerConfig.concurrency,
      });
    } else {
      const workers: Array<Record<string, unknown>> = [];

      if (mode === "all" || mode === "exploration") {
        const discoveryConfig = getQueueWorkerConfig("SOURCE_DISCOVERY", limit);
        workers.push({
          queueName: "SOURCE_DISCOVERY",
          batches: await drainPipelineQueue({
            queueName: "SOURCE_DISCOVERY",
            claimLimit: discoveryConfig.claimLimit,
            mode: "EXPLORATION",
            maxBatches,
            concurrency: discoveryConfig.concurrency,
          }),
        });
        const sourceValidationConfig = getQueueWorkerConfig("SOURCE_VALIDATION", limit);
        workers.push({
          queueName: "SOURCE_VALIDATION",
          batches: await drainPipelineQueue({
            queueName: "SOURCE_VALIDATION",
            claimLimit: sourceValidationConfig.claimLimit,
            mode: "EXPLORATION",
            maxBatches,
            concurrency: sourceValidationConfig.concurrency,
          }),
        });
      }

      if (mode === "all") {
        results.operationalValidation = await drainSourceValidationQueue(
          Math.max(50, limit),
          maxBatches
        );
        results.operationalPollEnqueue = await enqueueCompanySourcePollTasks({
          limit: Math.max(100, limit * 2),
          now: new Date(),
        });
        results.operationalPoll = await runCompanySourcePollQueue({
          limit: Math.max(50, limit),
          now: new Date(),
        });
        results.exploitation = await scheduleExploitationPipeline({
          rawParseLimit,
          dedupeLimit,
          lifecycleLimit,
          searchIndexLimit,
        });
      }

      if (mode === "all" || mode === "exploitation") {
        const rawParseConfig = getQueueWorkerConfig("RAW_PARSE", limit);
        workers.push({
          queueName: "RAW_PARSE",
          batches: await drainPipelineQueue({
            queueName: "RAW_PARSE",
            claimLimit: rawParseConfig.claimLimit,
            mode: "EXPLOITATION",
            maxBatches,
            concurrency: rawParseConfig.concurrency,
          }),
        });
        const dedupeConfig = getQueueWorkerConfig("DEDUPE", limit);
        workers.push({
          queueName: "DEDUPE",
          batches: await drainPipelineQueue({
            queueName: "DEDUPE",
            claimLimit: dedupeConfig.claimLimit,
            mode: "EXPLOITATION",
            maxBatches,
            concurrency: dedupeConfig.concurrency,
          }),
        });
        const searchIndexConfig = getQueueWorkerConfig("SEARCH_INDEX", limit);
        workers.push({
          queueName: "SEARCH_INDEX",
          batches: await drainPipelineQueue({
            queueName: "SEARCH_INDEX",
            claimLimit: searchIndexConfig.claimLimit,
            mode: "EXPLOITATION",
            maxBatches,
            concurrency: searchIndexConfig.concurrency,
          }),
        });
        const lifecycleConfig = getQueueWorkerConfig(
          "LIFECYCLE",
          Math.max(50, Math.floor(limit / 2))
        );
        workers.push({
          queueName: "LIFECYCLE",
          batches: await drainPipelineQueue({
            queueName: "LIFECYCLE",
            claimLimit: lifecycleConfig.claimLimit,
            mode: "EXPLOITATION",
            maxBatches: Math.max(2, Math.floor(maxBatches / 2)),
            concurrency: lifecycleConfig.concurrency,
          }),
        });
      }

      results.workers = workers;
    }
  }

  if (!skipMetrics) {
    results.after = await readMetrics(startedAt);
  }
  return results;
}

async function main() {
  const mode = (readArg("--mode") ?? "all") as "all" | "exploration" | "exploitation";
  const queueName = readArg("--queue") as PipelineQueueName | null;
  const limit = readIntArg("--limit", 100);
  const maxBatches = readIntArg("--max-batches", 6);
  const idleSleepMs = readIntArg("--idle-sleep-ms", 5000);
  const rawParseLimit = readIntArg("--raw-parse-limit", limit);
  const dedupeLimit = readIntArg("--dedupe-limit", limit);
  const lifecycleLimit = readIntArg(
    "--lifecycle-limit",
    Math.max(50, Math.floor(limit / 2))
  );
  const searchIndexLimit = readIntArg(
    "--search-index-limit",
    Math.max(5_000, limit * 20)
  );
  const scheduleOnly = process.argv.includes("--schedule-only");
  const workerOnly = process.argv.includes("--worker-only");
  const skipSeed = process.argv.includes("--skip-seed");
  const forever = process.argv.includes("--forever");
  const skipMetrics = process.argv.includes("--skip-metrics") || forever;
  const errorSleepMs = readIntArg(
    "--error-sleep-ms",
    Math.max(30_000, idleSleepMs * 3)
  );
  const runtimeLock = await acquireRuntimeLock(
    buildRuntimeLockKey({
      mode,
      queueName,
      scheduleOnly,
      workerOnly,
      skipSeed,
    })
  );

  if (!runtimeLock.acquired) {
    console.error(
      JSON.stringify(
        {
          refused: true,
          reason: "runtime-lock-held",
          existingPid: runtimeLock.existingPid,
        },
        null,
        2
      )
    );
    await prisma.$disconnect();
    return;
  }

  let releaseRequested = false;
  const releaseLock = async () => {
    if (releaseRequested) return;
    releaseRequested = true;
    await runtimeLock.release();
  };
  releaseRuntimeLock = releaseLock;

  process.on("SIGINT", () => {
    void releaseLock().finally(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void releaseLock().finally(() => process.exit(143));
  });

  if (!forever) {
    const results = await runOnce({
      mode,
      queueName,
      limit,
      maxBatches,
      rawParseLimit,
      dedupeLimit,
      lifecycleLimit,
      searchIndexLimit,
      scheduleOnly,
      workerOnly,
      skipSeed,
      skipMetrics,
    });
    console.log(JSON.stringify(results, null, 2));
    await releaseLock();
    await prisma.$disconnect();
    return;
  }

  let iteration = 0;
  while (true) {
    iteration += 1;
    try {
      const results = await runOnce({
        mode,
        queueName,
        limit,
        maxBatches,
        rawParseLimit,
        dedupeLimit,
        lifecycleLimit,
        searchIndexLimit,
        scheduleOnly,
        workerOnly,
        skipSeed,
        skipMetrics,
      });
      console.log(
        JSON.stringify(
          {
            iteration,
            executedAt: new Date().toISOString(),
            results,
          },
          null,
          2
        )
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify(
          {
            iteration,
            executedAt: new Date().toISOString(),
            error: errorMessage,
            errorSleepMs,
          },
          null,
          2
        )
      );
      await sleep(errorSleepMs);
      continue;
    }
    await sleep(idleSleepMs);
  }
}

main().catch((error) => {
  console.error(error);
  prisma.$disconnect()
    .catch(() => {})
    .finally(async () => {
      if (releaseRuntimeLock) {
        await releaseRuntimeLock();
      }
    });
  process.exitCode = 1;
});
