import "dotenv/config";

import process from "node:process";

process.env.DATABASE_PROCESS_ROLE ??= "other";
process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ??= "10000";
process.env.INGEST_GROWTH_MODE ??= "true";

const DEFAULT_FAMILIES = [
  "adzuna",
  "jooble",
  "jobicy",
  "weworkremotely",
  "themuse",
  "usajobs",
] as const;
const VISIBLE_STATUSES = ["LIVE", "AGING"] as const;

type ParsedArgs = {
  families: string[];
  limit?: number;
  maxRounds: number;
  maxRuntimeMs?: number;
  untilExhausted: boolean;
};

type FamilyOutcomeRow = {
  sourceFamily: string | null;
  acceptedCount: bigint | number;
  canonicalCreatedCount: bigint | number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const familiesArg = argv.find((arg) => arg.startsWith("--families="));
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const maxRoundsArg = argv.find((arg) => arg.startsWith("--max-rounds="));
  const maxRuntimeArg = argv.find((arg) => arg.startsWith("--max-runtime-ms="));

  return {
    families: familiesArg
      ? familiesArg
          .slice("--families=".length)
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      : [...DEFAULT_FAMILIES],
    limit: limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : undefined,
    maxRounds: maxRoundsArg
      ? Math.max(1, Number.parseInt(maxRoundsArg.slice("--max-rounds=".length), 10) || 1)
      : 6,
    maxRuntimeMs: maxRuntimeArg
      ? Math.max(
          15_000,
          Number.parseInt(maxRuntimeArg.slice("--max-runtime-ms=".length), 10) || 15_000
        )
      : undefined,
    untilExhausted: !argv.includes("--single-pass"),
  };
}

function inferFamily(sourceName: string) {
  return (sourceName.split(":")[0] ?? sourceName).trim().toLowerCase();
}

function uniqueByKey<T>(items: T[], getKey: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getRuntimeBudgetMs(sourceName: string, explicit?: number) {
  if (explicit && explicit > 0) {
    return explicit;
  }

  const family = inferFamily(sourceName);
  if (family === "jooble" || family === "usajobs") return 150_000;
  if (family === "adzuna" || family === "themuse") return 120_000;
  return 90_000;
}

function toInt(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return value ?? 0;
}

function withHardTimeout<T>(
  promise: Promise<T>,
  sourceName: string,
  timeoutMs: number
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${sourceName} exceeded hard timeout of ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function countVisibleJobs() {
  const { prisma } = await import("../src/lib/db");
  return prisma.jobCanonical.count({
    where: {
      status: { in: [...VISIBLE_STATUSES] },
    },
  });
}

async function readOutcomeMetrics(since: Date) {
  const { prisma } = await import("../src/lib/db");
  const [firstSeenCanonicals, currentlyVisibleFirstSeen, familyRows] =
    await Promise.all([
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
      prisma.$queryRaw<FamilyOutcomeRow[]>`
        SELECT
          LOWER(split_part("sourceName", ':', 1)) AS "sourceFamily",
          SUM("acceptedCount") AS "acceptedCount",
          SUM("canonicalCreatedCount") AS "canonicalCreatedCount"
        FROM "IngestionRun"
        WHERE "startedAt" >= ${since}
        GROUP BY 1
        ORDER BY SUM("canonicalCreatedCount") DESC, SUM("acceptedCount") DESC
      `,
    ]);

  return {
    firstSeenCanonicals,
    currentlyVisibleFirstSeen,
    noveltyByFamily: familyRows.map((row) => {
      const acceptedCount = toInt(row.acceptedCount);
      const canonicalCreatedCount = toInt(row.canonicalCreatedCount);
      return {
        sourceFamily: (row.sourceFamily ?? "unknown").trim().toLowerCase() || "unknown",
        acceptedCount,
        canonicalCreatedCount,
        noveltyYield:
          acceptedCount > 0
            ? Math.round((canonicalCreatedCount / acceptedCount) * 10_000) / 10_000
            : 0,
      };
    }),
  };
}

async function main() {
  const { getScheduledConnectors } = await import("../src/lib/ingestion/registry");
  const {
    ingestConnector,
    recoverStaleRunningIngestionRuns,
  } = await import("../src/lib/ingestion/pipeline");
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const visibleBefore = await countVisibleJobs();
  const scheduledConnectors = uniqueByKey(
    getScheduledConnectors()
      .map((definition) => definition.connector)
      .filter((connector) => args.families.includes(inferFamily(connector.sourceName))),
    (connector) => connector.key
  );

  if (scheduledConnectors.length === 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: "no_connectors",
          requestedFamilies: args.families,
          availableFamilies: uniqueByKey(
            getScheduledConnectors().map((definition) => inferFamily(definition.connector.sourceName)),
            (family) => family
          ),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const runs: Array<Record<string, unknown>> = [];

  for (const connector of scheduledConnectors) {
    try {
      await recoverStaleRunningIngestionRuns({
        now: new Date(),
        connectorKeys: [connector.key],
      });

      for (let round = 1; round <= args.maxRounds; round += 1) {
        const runtimeBudgetMs = getRuntimeBudgetMs(
          connector.sourceName,
          args.maxRuntimeMs
        );
        const summary = await withHardTimeout(
          ingestConnector(connector, {
            now: new Date(),
            runMode: "MANUAL",
            triggerLabel: "bulk-direct-board-ingest",
            allowOverlappingRuns: false,
            maxRuntimeMs: runtimeBudgetMs,
            limit: args.limit,
          }),
          connector.sourceName,
          runtimeBudgetMs + 60_000
        );

        runs.push({
          connectorKey: connector.key,
          sourceName: connector.sourceName,
          round,
          status: summary.status,
          fetchedCount: summary.fetchedCount,
          acceptedCount: summary.acceptedCount,
          canonicalCreatedCount: summary.canonicalCreatedCount,
          liveCount: summary.liveCount,
          checkpointExhausted: summary.checkpointExhausted ?? false,
        });

        const shouldStop =
          summary.status === "SKIPPED" ||
          !args.untilExhausted ||
          summary.checkpointExhausted === true ||
          ((summary.fetchedCount ?? 0) === 0 &&
            (summary.acceptedCount ?? 0) === 0 &&
            (summary.canonicalCreatedCount ?? 0) === 0);

        if (shouldStop) {
          break;
        }
      }
    } catch (error) {
      runs.push({
        connectorKey: connector.key,
        sourceName: connector.sourceName,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const visibleAfter = await countVisibleJobs();
  const outcomes = await readOutcomeMetrics(startedAt);

  console.log(
    JSON.stringify(
      {
        ok: true,
        startedAt: startedAt.toISOString(),
        families: args.families,
        connectorCount: scheduledConnectors.length,
        visibleBefore,
        visibleAfter,
        visibleDelta: visibleAfter - visibleBefore,
        firstSeenCanonicals: outcomes.firstSeenCanonicals,
        currentlyVisibleFirstSeen: outcomes.currentlyVisibleFirstSeen,
        noveltyByFamily: outcomes.noveltyByFamily,
        runs,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      "[bulk-direct-board-ingest] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/db");
    await prisma.$disconnect().catch(() => undefined);
  });
