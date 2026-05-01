import "dotenv/config";

import process from "node:process";

process.env.DATABASE_PROCESS_ROLE ??= "recovery_poll";
process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ??= "10000";
process.env.INGEST_GROWTH_MODE ??= "true";
process.env.INGEST_FRONTIER_POLL_ONLY ??= "true";

const VISIBLE_STATUSES = ["LIVE", "AGING"] as const;

type ParsedArgs = {
  cycles: number;
  validationLimit: number;
  pollLimit: number;
  maxWallClockMs: number;
  frontierOnly: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const cyclesArg = argv.find((arg) => arg.startsWith("--cycles="));
  const validationLimitArg = argv.find((arg) =>
    arg.startsWith("--validation-limit=")
  );
  const pollLimitArg = argv.find((arg) => arg.startsWith("--poll-limit="));
  const maxWallClockArg = argv.find((arg) =>
    arg.startsWith("--max-wall-clock-ms=")
  );

  return {
    cycles: cyclesArg
      ? Math.max(1, Number.parseInt(cyclesArg.slice("--cycles=".length), 10) || 1)
      : 4,
    validationLimit: validationLimitArg
      ? Math.max(
          1,
          Number.parseInt(validationLimitArg.slice("--validation-limit=".length), 10) || 1
        )
      : 120,
    pollLimit: pollLimitArg
      ? Math.max(1, Number.parseInt(pollLimitArg.slice("--poll-limit=".length), 10) || 1)
      : 80,
    maxWallClockMs: maxWallClockArg
      ? Math.max(
          120_000,
          Number.parseInt(maxWallClockArg.slice("--max-wall-clock-ms=".length), 10) ||
            120_000
        )
      : 8 * 60 * 1000,
    frontierOnly: !argv.includes("--include-non-frontier"),
  };
}

async function countVisibleJobs() {
  const { prisma } = await import("../src/lib/db");
  return prisma.jobCanonical.count({
    where: {
      status: { in: [...VISIBLE_STATUSES] },
    },
  });
}

async function countFirstSeenSince(since: Date) {
  const { prisma } = await import("../src/lib/db");
  const [firstSeenCanonicals, visibleFirstSeen] = await Promise.all([
    prisma.jobCanonical.count({
      where: {
        firstSeenAt: { gte: since },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        firstSeenAt: { gte: since },
        status: { in: [...VISIBLE_STATUSES] },
      },
    }),
  ]);

  return {
    firstSeenCanonicals,
    visibleFirstSeen,
  };
}

async function readNoveltyByFamily(since: Date) {
  const { prisma } = await import("../src/lib/db");
  const rows = await prisma.$queryRaw<
    Array<{
      sourceFamily: string | null;
      acceptedCount: bigint | number;
      canonicalCreatedCount: bigint | number;
    }>
  >`
    SELECT
      LOWER(split_part("sourceName", ':', 1)) AS "sourceFamily",
      SUM("acceptedCount") AS "acceptedCount",
      SUM("canonicalCreatedCount") AS "canonicalCreatedCount"
    FROM "IngestionRun"
    WHERE "startedAt" >= ${since}
    GROUP BY 1
    ORDER BY SUM("canonicalCreatedCount") DESC, SUM("acceptedCount") DESC
  `;

  return rows.map((row) => {
    const acceptedCount =
      typeof row.acceptedCount === "bigint"
        ? Number(row.acceptedCount)
        : row.acceptedCount ?? 0;
    const canonicalCreatedCount =
      typeof row.canonicalCreatedCount === "bigint"
        ? Number(row.canonicalCreatedCount)
        : row.canonicalCreatedCount ?? 0;

    return {
      sourceFamily: (row.sourceFamily ?? "unknown").trim().toLowerCase() || "unknown",
      acceptedCount,
      canonicalCreatedCount,
      noveltyYield:
        acceptedCount > 0
          ? Math.round((canonicalCreatedCount / acceptedCount) * 10_000) / 10_000
          : 0,
    };
  });
}

async function runCycle(args: ParsedArgs, cycle: number) {
  const {
    enqueueCompanySourcePollTasks,
    enqueueSourceValidationTasks,
    runCompanySourcePollSlice,
    runSourceValidationQueue,
  } = await import("../src/lib/ingestion/company-discovery");
  const cycleStartedAt = new Date();
  const validationEnqueue = await enqueueSourceValidationTasks({
    limit: args.validationLimit,
    now: cycleStartedAt,
    frontierOnly: args.frontierOnly,
    growthMode: true,
  });
  const validation = await runSourceValidationQueue({
    limit: args.validationLimit,
    now: new Date(),
    companySourceIds: validationEnqueue.companySourceIds,
  });
  const pollEnqueue = await enqueueCompanySourcePollTasks({
    limit: args.pollLimit,
    now: new Date(),
    frontierOnly: args.frontierOnly,
    growthMode: true,
  });
  const poll = await runCompanySourcePollSlice({
    companySourceIds: pollEnqueue.companySourceIds,
    limit: args.pollLimit,
    now: new Date(),
    maxRuntimeMs: Math.min(args.maxWallClockMs, 180_000),
    concurrency: 1,
  });

  return {
    cycle,
    cycleStartedAt: cycleStartedAt.toISOString(),
    scheduledValidationCount: validationEnqueue.enqueuedCount,
    processedValidationCount: validation.processedCount,
    scheduledPollCount: pollEnqueue.enqueuedCount,
    processedPollCount: poll.processedCount,
    pollSuccessCount: poll.successCount,
    pollFailedCount: poll.failedCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const visibleBefore = await countVisibleJobs();
  const cycles: Array<Record<string, unknown>> = [];
  let idleCycles = 0;

  for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
    const result = await runCycle(args, cycle);
    cycles.push(result);

    const didWork =
      (result.processedValidationCount as number) > 0 ||
      (result.processedPollCount as number) > 0;
    idleCycles = didWork ? 0 : idleCycles + 1;
    if (idleCycles >= 2) {
      break;
    }
  }

  const visibleAfter = await countVisibleJobs();
  const firstSeen = await countFirstSeenSince(startedAt);
  const noveltyByFamily = await readNoveltyByFamily(startedAt);

  console.log(
    JSON.stringify(
      {
        ok: true,
        startedAt: startedAt.toISOString(),
        frontierOnly: args.frontierOnly,
        visibleBefore,
        visibleAfter,
        visibleDelta: visibleAfter - visibleBefore,
        firstSeenCanonicals: firstSeen.firstSeenCanonicals,
        currentlyVisibleFirstSeen: firstSeen.visibleFirstSeen,
        noveltyByFamily,
        cycles,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      "[run-frontier-growth-pass] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/db");
    await prisma.$disconnect().catch(() => undefined);
  });
