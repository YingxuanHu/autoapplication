import "dotenv/config";

import process from "node:process";
import {
  enqueueCompanyDiscoveryTasks,
  enqueueCompanySourcePollTasks,
  enqueueRediscoveryTasks,
  enqueueSourceValidationTasks,
  runCompanyDiscoveryQueue,
  runCompanySourcePollQueue,
  runRediscoveryQueue,
  runSourceValidationQueue,
} from "../src/lib/ingestion/company-discovery";
import { resolveScaledInteger } from "../src/lib/ingestion/capacity";
import { prisma } from "../src/lib/db";

type WorkerRole = "poll" | "validation" | "discovery" | "all";

type ParsedArgs = {
  role: WorkerRole;
  intervalSeconds: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  let role: WorkerRole = "all";
  let intervalSeconds = 15;

  for (const rawArg of argv) {
    const arg = rawArg.replace(/^--/, "");
    const [key, value] = arg.split("=");
    if (
      key === "role" &&
      (value === "poll" ||
        value === "validation" ||
        value === "discovery" ||
        value === "all")
    ) {
      role = value;
      continue;
    }

    if (key === "interval" && value) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        intervalSeconds = parsed;
      }
    }
  }

  return { role, intervalSeconds };
}

const POLL_VALIDATION_LIMIT = resolveScaledInteger({
  base: 1_500,
  absoluteMax: 6_000,
  explicitEnvName: "RECOVERY_WORKER_VALIDATION_LIMIT",
});
const POLL_SOURCE_LIMIT = resolveScaledInteger({
  base: 1_500,
  absoluteMax: 6_000,
  explicitEnvName: "RECOVERY_WORKER_SOURCE_POLL_LIMIT",
});
const DISCOVERY_LIMIT = resolveScaledInteger({
  base: 1_000,
  absoluteMax: 4_000,
  explicitEnvName: "RECOVERY_WORKER_DISCOVERY_LIMIT",
});
const REDISCOVERY_LIMIT = resolveScaledInteger({
  base: 250,
  absoluteMax: 1_000,
  explicitEnvName: "RECOVERY_WORKER_REDISCOVERY_LIMIT",
});

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRelevantBacklog(role: WorkerRole, now: Date) {
  const whereBase = {
    status: "PENDING" as const,
    notBeforeAt: { lte: now },
  };

  if (role === "poll") {
    return prisma.sourceTask.count({
      where: { ...whereBase, kind: "CONNECTOR_POLL" },
    });
  }

  if (role === "validation") {
    return prisma.sourceTask.count({
      where: { ...whereBase, kind: "SOURCE_VALIDATION" },
    });
  }

  if (role === "discovery") {
    const [discovery, rediscovery] = await Promise.all([
      prisma.sourceTask.count({ where: { ...whereBase, kind: "COMPANY_DISCOVERY" } }),
      prisma.sourceTask.count({ where: { ...whereBase, kind: "REDISCOVERY" } }),
    ]);
    return discovery + rediscovery;
  }

  const [discovery, validation, poll, rediscovery] = await Promise.all([
    prisma.sourceTask.count({ where: { ...whereBase, kind: "COMPANY_DISCOVERY" } }),
    prisma.sourceTask.count({ where: { ...whereBase, kind: "SOURCE_VALIDATION" } }),
    prisma.sourceTask.count({ where: { ...whereBase, kind: "CONNECTOR_POLL" } }),
    prisma.sourceTask.count({ where: { ...whereBase, kind: "REDISCOVERY" } }),
  ]);

  return discovery + validation + poll + rediscovery;
}

async function runPollCycle(now: Date) {
  const scheduledPoll = await enqueueCompanySourcePollTasks({
    limit: POLL_SOURCE_LIMIT,
    now,
  });
  const sourcePoll = await runCompanySourcePollQueue({
    limit: POLL_SOURCE_LIMIT,
    now,
  });

  return {
    scheduledPoll,
    sourcePoll,
  };
}

async function runValidationCycle(now: Date) {
  const scheduledValidation = await enqueueSourceValidationTasks({
    limit: POLL_VALIDATION_LIMIT,
    now,
  });
  const validation = await runSourceValidationQueue({
    limit: POLL_VALIDATION_LIMIT,
    now,
  });

  return {
    scheduledValidation,
    validation,
  };
}

async function runDiscoveryCycle(now: Date) {
  const [scheduledDiscovery, scheduledRediscovery] = await Promise.all([
    enqueueCompanyDiscoveryTasks({ limit: DISCOVERY_LIMIT, now }),
    enqueueRediscoveryTasks({ limit: REDISCOVERY_LIMIT, now }),
  ]);
  const [discovery, rediscovery] = await Promise.all([
    runCompanyDiscoveryQueue({ limit: DISCOVERY_LIMIT, now }),
    runRediscoveryQueue({ limit: REDISCOVERY_LIMIT, now }),
  ]);

  return {
    scheduledDiscovery,
    scheduledRediscovery,
    discovery,
    rediscovery,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let running = true;
  let cycle = 0;

  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  console.log(
    `[recovery-worker] role=${args.role} interval=${args.intervalSeconds}s validationLimit=${POLL_VALIDATION_LIMIT} sourcePollLimit=${POLL_SOURCE_LIMIT} discoveryLimit=${DISCOVERY_LIMIT} rediscoveryLimit=${REDISCOVERY_LIMIT}`
  );

  while (running) {
    cycle += 1;
    const now = new Date();
    const startedAt = Date.now();

    try {
      if (args.role === "poll") {
        const summary = await runPollCycle(now);
        console.log(
          `[recovery-worker] cycle=${cycle} role=poll scheduled(poll=${summary.scheduledPoll.enqueuedCount}) processed(poll=${summary.sourcePoll.processedCount})`
        );
      } else if (args.role === "validation") {
        const summary = await runValidationCycle(now);
        console.log(
          `[recovery-worker] cycle=${cycle} role=validation scheduled(validation=${summary.scheduledValidation.enqueuedCount}) processed(validation=${summary.validation.processedCount})`
        );
      } else if (args.role === "discovery") {
        const summary = await runDiscoveryCycle(now);
        console.log(
          `[recovery-worker] cycle=${cycle} role=discovery scheduled(discovery=${summary.scheduledDiscovery.enqueuedCount}, rediscovery=${summary.scheduledRediscovery.enqueuedCount}) processed(discovery=${summary.discovery.processedCount}, rediscovery=${summary.rediscovery.processedCount})`
        );
      } else {
        const [pollSummary, validationSummary, discoverySummary] = await Promise.all([
          runPollCycle(now),
          runValidationCycle(now),
          runDiscoveryCycle(now),
        ]);
        console.log(
          `[recovery-worker] cycle=${cycle} role=all scheduled(validation=${validationSummary.scheduledValidation.enqueuedCount}, poll=${pollSummary.scheduledPoll.enqueuedCount}, discovery=${discoverySummary.scheduledDiscovery.enqueuedCount}, rediscovery=${discoverySummary.scheduledRediscovery.enqueuedCount}) processed(validation=${validationSummary.validation.processedCount}, poll=${pollSummary.sourcePoll.processedCount}, discovery=${discoverySummary.discovery.processedCount}, rediscovery=${discoverySummary.rediscovery.processedCount})`
        );
      }
    } catch (error) {
      console.error(
        `[recovery-worker] cycle=${cycle} role=${args.role} failed:`,
        error instanceof Error ? error.message : error
      );
    }

    const backlog = await getRelevantBacklog(args.role, new Date());
    const elapsedMs = Date.now() - startedAt;
    const nextSleepMs =
      backlog > 0 ? Math.max(5_000, args.intervalSeconds * 1_000) : Math.max(30_000, args.intervalSeconds * 2_000);

    console.log(
      `[recovery-worker] cycle=${cycle} role=${args.role} elapsed=${Math.round(elapsedMs / 1000)}s backlog=${backlog} nextSleep=${Math.round(nextSleepMs / 1000)}s`
    );

    if (!running) break;
    await sleep(nextSleepMs);
  }

  await prisma.$disconnect().catch(() => undefined);
}

void main();
