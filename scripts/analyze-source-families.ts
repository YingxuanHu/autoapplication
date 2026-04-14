import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";

type FamilyMetrics = {
  connectorName: string;
  sourceCount: number;
  validatedCount: number;
  pollableCount: number;
  successfulPollSourceCount: number;
  pendingValidationTasks: number;
  runningValidationTasks: number;
  pendingPollTasks: number;
  runningPollTasks: number;
  jobsFetchedCount: number;
  jobsAcceptedCount: number;
  jobsCreatedCount: number;
  retainedLiveSourceVolume: number;
  avgYieldScore: number;
  avgPriorityScore: number;
  liveCanonicalCount: number;
};

type LiveCanonicalRow = {
  connectorName: string | null;
  liveCanonicalCount: bigint | number;
};

type TaskRow = {
  connectorName: string | null;
  kind: string;
  status: string;
  count: bigint | number;
};

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data/discovery/source-family-funnel.json"
);

function normalizeConnectorName(value: string | null | undefined) {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "companyhtml" || normalized === "companyjson") {
    return "company-site";
  }
  return normalized;
}

function toInt(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") return Number(value);
  return value ?? 0;
}

async function main() {
  const [sources, liveCanonicals, taskRows] = await Promise.all([
    prisma.companySource.findMany({
      select: {
        connectorName: true,
        validationState: true,
        pollState: true,
        pollSuccessCount: true,
        jobsFetchedCount: true,
        jobsAcceptedCount: true,
        jobsCreatedCount: true,
        retainedLiveJobCount: true,
        yieldScore: true,
        priorityScore: true,
      },
    }),
    prisma.$queryRaw<LiveCanonicalRow[]>`
      SELECT
        LOWER(COALESCE(cs."connectorName", split_part(jsm."sourceName", ':', 1))) AS "connectorName",
        COUNT(DISTINCT jsm."canonicalJobId") AS "liveCanonicalCount"
      FROM "JobSourceMapping" jsm
      INNER JOIN "JobCanonical" jc
        ON jc."id" = jsm."canonicalJobId"
      LEFT JOIN "CompanySource" cs
        ON cs."sourceName" = jsm."sourceName"
      WHERE
        jsm."removedAt" IS NULL
        AND jc."status" IN ('LIVE', 'AGING')
      GROUP BY 1
    `,
    prisma.$queryRaw<TaskRow[]>`
      SELECT
        LOWER(cs."connectorName") AS "connectorName",
        st."kind" AS "kind",
        st."status" AS "status",
        COUNT(*) AS "count"
      FROM "SourceTask" st
      INNER JOIN "CompanySource" cs
        ON cs."id" = st."companySourceId"
      WHERE
        st."kind" IN ('SOURCE_VALIDATION', 'CONNECTOR_POLL')
        AND st."status" IN ('PENDING', 'RUNNING')
      GROUP BY 1, 2, 3
    `,
  ]);

  const metrics = new Map<string, FamilyMetrics>();

  const ensureMetrics = (connectorName: string) => {
    const normalized = normalizeConnectorName(connectorName);
    const existing = metrics.get(normalized);
    if (existing) return existing;
    const next: FamilyMetrics = {
      connectorName: normalized,
      sourceCount: 0,
      validatedCount: 0,
      pollableCount: 0,
      successfulPollSourceCount: 0,
      pendingValidationTasks: 0,
      runningValidationTasks: 0,
      pendingPollTasks: 0,
      runningPollTasks: 0,
      jobsFetchedCount: 0,
      jobsAcceptedCount: 0,
      jobsCreatedCount: 0,
      retainedLiveSourceVolume: 0,
      avgYieldScore: 0,
      avgPriorityScore: 0,
      liveCanonicalCount: 0,
    };
    metrics.set(normalized, next);
    return next;
  };

  const averageAccumulators = new Map<
    string,
    { yieldScoreTotal: number; priorityScoreTotal: number }
  >();

  for (const source of sources) {
    const connectorName = normalizeConnectorName(source.connectorName);
    const metric = ensureMetrics(connectorName);
    const averages = averageAccumulators.get(connectorName) ?? {
      yieldScoreTotal: 0,
      priorityScoreTotal: 0,
    };

    metric.sourceCount += 1;
    metric.jobsFetchedCount += source.jobsFetchedCount;
    metric.jobsAcceptedCount += source.jobsAcceptedCount;
    metric.jobsCreatedCount += source.jobsCreatedCount;
    metric.retainedLiveSourceVolume += source.retainedLiveJobCount;
    averages.yieldScoreTotal += source.yieldScore;
    averages.priorityScoreTotal += source.priorityScore;

    if (source.validationState === "VALIDATED") {
      metric.validatedCount += 1;
    }

    if (
      source.validationState === "VALIDATED" &&
      source.pollState !== "QUARANTINED"
    ) {
      metric.pollableCount += 1;
    }

    if (source.pollSuccessCount > 0) {
      metric.successfulPollSourceCount += 1;
    }

    averageAccumulators.set(connectorName, averages);
  }

  for (const [connectorName, averages] of averageAccumulators) {
    const metric = metrics.get(connectorName);
    if (!metric || metric.sourceCount === 0) continue;
    metric.avgYieldScore =
      Math.round((averages.yieldScoreTotal / metric.sourceCount) * 1000) / 1000;
    metric.avgPriorityScore =
      Math.round((averages.priorityScoreTotal / metric.sourceCount) * 1000) / 1000;
  }

  for (const row of liveCanonicals) {
    const connectorName = normalizeConnectorName(row.connectorName);
    ensureMetrics(connectorName).liveCanonicalCount = toInt(row.liveCanonicalCount);
  }

  for (const row of taskRows) {
    const connectorName = normalizeConnectorName(row.connectorName);
    const metric = ensureMetrics(connectorName);
    const count = toInt(row.count);

    if (row.kind === "SOURCE_VALIDATION" && row.status === "PENDING") {
      metric.pendingValidationTasks += count;
    } else if (row.kind === "SOURCE_VALIDATION" && row.status === "RUNNING") {
      metric.runningValidationTasks += count;
    } else if (row.kind === "CONNECTOR_POLL" && row.status === "PENDING") {
      metric.pendingPollTasks += count;
    } else if (row.kind === "CONNECTOR_POLL" && row.status === "RUNNING") {
      metric.runningPollTasks += count;
    }
  }

  const entries = [...metrics.values()]
    .filter(
      (entry) =>
        entry.sourceCount > 0 ||
        entry.liveCanonicalCount > 0 ||
        entry.pendingValidationTasks > 0 ||
        entry.pendingPollTasks > 0
    )
    .sort((left, right) => {
      if (right.liveCanonicalCount !== left.liveCanonicalCount) {
        return right.liveCanonicalCount - left.liveCanonicalCount;
      }
      if (right.retainedLiveSourceVolume !== left.retainedLiveSourceVolume) {
        return right.retainedLiveSourceVolume - left.retainedLiveSourceVolume;
      }
      return right.validatedCount - left.validatedCount;
    });

  const output = {
    updatedAt: new Date().toISOString(),
    summary: {
      families: entries.length,
      totalSources: entries.reduce((sum, entry) => sum + entry.sourceCount, 0),
      totalValidatedSources: entries.reduce(
        (sum, entry) => sum + entry.validatedCount,
        0
      ),
      totalLiveCanonicals: entries.reduce(
        (sum, entry) => sum + entry.liveCanonicalCount,
        0
      ),
    },
    entries,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(
      "[source:analyze-families] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
