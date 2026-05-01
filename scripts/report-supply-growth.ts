import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

process.env.DATABASE_PROCESS_ROLE ??= "expansion_pipeline";
process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ??= "10000";

let prismaHandle: { $disconnect(): Promise<void> } | null = null;

type Args = {
  days: number;
  topSources: number;
};

type FamilyRunRow = {
  sourceFamily: string | null;
  runCount: bigint | number;
  fetchedCount: bigint | number;
  acceptedCount: bigint | number;
  canonicalCreatedCount: bigint | number;
  dedupedCount: bigint | number;
};

type FamilyCountRow = {
  sourceFamily: string | null;
  count: bigint | number;
};

type SourceRunRow = {
  sourceName: string;
  sourceFamily: string | null;
  runCount: bigint | number;
  fetchedCount: bigint | number;
  acceptedCount: bigint | number;
  canonicalCreatedCount: bigint | number;
  dedupedCount: bigint | number;
};

type SourceCountRow = {
  sourceName: string;
  sourceFamily: string | null;
  count: bigint | number;
};

type DailyRow = {
  day: string;
  canonicalsFirstSeen: bigint | number;
  currentlyVisibleFirstSeen: bigint | number;
};

type CoverageRow = {
  label: string | null;
  canonicalCount: bigint | number;
  visibleCanonicalCount: bigint | number;
};

const VISIBLE_STATUSES = ["LIVE", "AGING", "STALE"] as const;
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data/discovery/source-supply-growth.json"
);

function parseArgs(argv: string[]): Args {
  let days = 30;
  let topSources = 50;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--days" || arg === "-d") && next) {
      days = parsePositiveInt(next, days);
      index += 1;
      continue;
    }

    if ((arg === "--top-sources" || arg === "--top") && next) {
      topSources = parsePositiveInt(next, topSources);
      index += 1;
    }
  }

  return { days, topSources };
}

function parsePositiveInt(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeFamily(value: string | null | undefined) {
  return (value ?? "unknown").trim().toLowerCase() || "unknown";
}

function normalizeLabel(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function toInt(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return value ?? 0;
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

async function main() {
  const { prisma } = await import("../src/lib/db");
  prismaHandle = prisma;
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const cutoff = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);

  const familyRunRows = await prisma.$queryRaw<FamilyRunRow[]>`
      SELECT
        LOWER(split_part("sourceName", ':', 1)) AS "sourceFamily",
        COUNT(*) AS "runCount",
        SUM("fetchedCount") AS "fetchedCount",
        SUM("acceptedCount") AS "acceptedCount",
        SUM("canonicalCreatedCount") AS "canonicalCreatedCount",
        SUM("dedupedCount") AS "dedupedCount"
      FROM "IngestionRun"
      WHERE "startedAt" >= ${cutoff}
      GROUP BY 1
    `;
  const sourceRunRows = await prisma.$queryRaw<SourceRunRow[]>`
      SELECT
        "sourceName",
        LOWER(split_part("sourceName", ':', 1)) AS "sourceFamily",
        COUNT(*) AS "runCount",
        SUM("fetchedCount") AS "fetchedCount",
        SUM("acceptedCount") AS "acceptedCount",
        SUM("canonicalCreatedCount") AS "canonicalCreatedCount",
        SUM("dedupedCount") AS "dedupedCount"
      FROM "IngestionRun"
      WHERE "startedAt" >= ${cutoff}
      GROUP BY 1, 2
      ORDER BY SUM("canonicalCreatedCount") DESC, SUM("acceptedCount") DESC
      LIMIT ${args.topSources}
    `;
  const dailyRows = await prisma.$queryRaw<DailyRow[]>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${cutoff}::timestamp),
          date_trunc('day', ${now}::timestamp),
          interval '1 day'
        ) AS day
      ),
      daily AS (
        SELECT
          date_trunc('day', "firstSeenAt") AS day,
          COUNT(*) AS "canonicalsFirstSeen",
          COUNT(*) FILTER (WHERE "status" IN ('LIVE', 'AGING', 'STALE')) AS "currentlyVisibleFirstSeen"
        FROM "JobCanonical"
        WHERE "firstSeenAt" >= ${cutoff}
        GROUP BY 1
      )
      SELECT
        TO_CHAR(days.day, 'YYYY-MM-DD') AS "day",
        COALESCE(daily."canonicalsFirstSeen", 0) AS "canonicalsFirstSeen",
        COALESCE(daily."currentlyVisibleFirstSeen", 0) AS "currentlyVisibleFirstSeen"
      FROM days
      LEFT JOIN daily
        ON daily.day = days.day
      ORDER BY days.day
    `;
  const regionRows = await prisma.$queryRaw<CoverageRow[]>`
      SELECT
        COALESCE("region"::text, 'UNKNOWN') AS "label",
        COUNT(*) AS "canonicalCount",
        COUNT(*) FILTER (WHERE "status" IN ('LIVE', 'AGING', 'STALE')) AS "visibleCanonicalCount"
      FROM "JobCanonical"
      WHERE "firstSeenAt" >= ${cutoff}
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1 ASC
    `;
  const roleRows = await prisma.$queryRaw<CoverageRow[]>`
      SELECT
        COALESCE(NULLIF(TRIM("roleFamily"), ''), 'unknown') AS "label",
        COUNT(*) AS "canonicalCount",
        COUNT(*) FILTER (WHERE "status" IN ('LIVE', 'AGING', 'STALE')) AS "visibleCanonicalCount"
      FROM "JobCanonical"
      WHERE "firstSeenAt" >= ${cutoff}
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1 ASC
      LIMIT 40
    `;
  const totalVisibleCanonicalCount = await prisma.jobCanonical.count({
    where: {
      status: { in: [...VISIBLE_STATUSES] },
    },
  });

  const familyMetrics = familyRunRows
    .map((row) => {
      const sourceFamily = normalizeFamily(row.sourceFamily);
      const fetchedCount = toInt(row.fetchedCount);
      const acceptedCount = toInt(row.acceptedCount);
      const canonicalCreatedCount = toInt(row.canonicalCreatedCount);
      const dedupedCount = toInt(row.dedupedCount);
      const firstSeenCanonicals = canonicalCreatedCount;

      return {
        sourceFamily,
        runCount: toInt(row.runCount),
        jobsIngested: fetchedCount,
        jobsAccepted: acceptedCount,
        canonicalsCreated: canonicalCreatedCount,
        firstSeenCanonicals,
        duplicatesMerged: dedupedCount,
        duplicateRate: ratio(dedupedCount, Math.max(acceptedCount, 1)),
        mergeRate: ratio(dedupedCount, Math.max(dedupedCount + canonicalCreatedCount, 1)),
        noveltyRatio: ratio(canonicalCreatedCount, Math.max(acceptedCount, 1)),
      };
    })
    .sort((left, right) => {
      if (right.firstSeenCanonicals !== left.firstSeenCanonicals) {
        return right.firstSeenCanonicals - left.firstSeenCanonicals;
      }
      if (right.canonicalsCreated !== left.canonicalsCreated) {
        return right.canonicalsCreated - left.canonicalsCreated;
      }
      return right.jobsAccepted - left.jobsAccepted;
    });

  const topSources = sourceRunRows
    .map((row) => {
      const acceptedCount = toInt(row.acceptedCount);
      const canonicalCreatedCount = toInt(row.canonicalCreatedCount);
      const dedupedCount = toInt(row.dedupedCount);

      return {
        sourceName: row.sourceName,
        sourceFamily: normalizeFamily(row.sourceFamily),
        runCount: toInt(row.runCount),
        jobsIngested: toInt(row.fetchedCount),
        jobsAccepted: acceptedCount,
        canonicalsCreated: canonicalCreatedCount,
        firstSeenCanonicals: canonicalCreatedCount,
        duplicatesMerged: dedupedCount,
        noveltyRatio: ratio(canonicalCreatedCount, Math.max(acceptedCount, 1)),
        duplicateRate: ratio(dedupedCount, Math.max(acceptedCount, 1)),
      };
    })
    .sort((left, right) => {
      if (right.canonicalsCreated !== left.canonicalsCreated) {
        return right.canonicalsCreated - left.canonicalsCreated;
      }
      if (right.firstSeenCanonicals !== left.firstSeenCanonicals) {
        return right.firstSeenCanonicals - left.firstSeenCanonicals;
      }
      return right.jobsAccepted - left.jobsAccepted;
    });

  let cumulativeVisibleDelta = 0;
  const visibleJobDeltaOverTime = dailyRows.map((row) => {
    const canonicalsFirstSeen = toInt(row.canonicalsFirstSeen);
    const currentlyVisibleFirstSeen = toInt(row.currentlyVisibleFirstSeen);
    cumulativeVisibleDelta += currentlyVisibleFirstSeen;

    return {
      day: row.day,
      canonicalsFirstSeen,
      currentlyVisibleFirstSeen,
      visibleJobCountDelta: currentlyVisibleFirstSeen,
      cumulativeVisibleDelta,
    };
  });

  const geographyCoverage = regionRows.map((row) => ({
    region: normalizeLabel(row.label, "UNKNOWN"),
    canonicalCount: toInt(row.canonicalCount),
    visibleCanonicalCount: toInt(row.visibleCanonicalCount),
  }));

  const roleCoverage = roleRows.map((row) => ({
    roleFamily: normalizeLabel(row.label, "unknown"),
    canonicalCount: toInt(row.canonicalCount),
    visibleCanonicalCount: toInt(row.visibleCanonicalCount),
  }));

  const output = {
    updatedAt: now.toISOString(),
    windowDays: args.days,
    cutoff: cutoff.toISOString(),
    summary: {
      currentVisibleCanonicalCount: totalVisibleCanonicalCount,
      sourceFamiliesInWindow: familyMetrics.length,
      topSourceCount: topSources.length,
      canonicalsCreatedInWindow: familyMetrics.reduce(
        (sum, row) => sum + row.canonicalsCreated,
        0
      ),
      firstSeenCanonicalsInWindow: familyMetrics.reduce(
        (sum, row) => sum + row.firstSeenCanonicals,
        0
      ),
      acceptedJobsInWindow: familyMetrics.reduce(
        (sum, row) => sum + row.jobsAccepted,
        0
      ),
    },
    sourceFamilies: familyMetrics,
    topSources,
    visibleJobDeltaOverTime,
    geographyCoverage,
    roleCoverage,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(
      "[source:supply-report] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaHandle?.$disconnect();
  });
