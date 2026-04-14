import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { parseWorkdaySourceToken } from "../src/lib/ingestion/connectors";

type WorkdayRow = {
  id: string;
  sourceName: string;
  token: string;
  boardUrl: string;
  retainedLiveJobCount: number;
  jobsAcceptedCount: number;
  jobsCreatedCount: number;
  jobsFetchedCount: number;
  pollAttemptCount: number;
  pollSuccessCount: number;
  lastSuccessfulPollAt: Date | null;
  yieldScore: number;
  priorityScore: number;
  status: string;
  validationState: string;
  pollState: string;
  lastHttpStatus: number | null;
  company: {
    name: string;
    companyKey: string;
  } | null;
};

type WorkdayTier = "A" | "B" | "C";

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data/discovery/workday-cohorts.json"
);

const TIER_A_VALUE_SCORE = 60;
const TIER_B_VALUE_SCORE = 20;

function computeValueScore(row: Pick<WorkdayRow, "retainedLiveJobCount" | "jobsAcceptedCount" | "pollAttemptCount" | "pollSuccessCount">) {
  const recentSuccessRate =
    row.pollAttemptCount > 0 ? row.pollSuccessCount / row.pollAttemptCount : 0;

  return (
    row.retainedLiveJobCount * 0.5 +
    row.jobsAcceptedCount * 0.3 +
    recentSuccessRate * 100 * 0.2
  );
}

function getTier(valueScore: number): WorkdayTier {
  if (valueScore >= TIER_A_VALUE_SCORE) return "A";
  if (valueScore >= TIER_B_VALUE_SCORE) return "B";
  return "C";
}

async function main() {
  const rows = (await prisma.companySource.findMany({
    where: {
      connectorName: "workday",
      validationState: {
        not: "INVALID",
      },
    },
    select: {
      id: true,
      sourceName: true,
      token: true,
      boardUrl: true,
      retainedLiveJobCount: true,
      jobsAcceptedCount: true,
      jobsCreatedCount: true,
      jobsFetchedCount: true,
      pollAttemptCount: true,
      pollSuccessCount: true,
      lastSuccessfulPollAt: true,
      yieldScore: true,
      priorityScore: true,
      status: true,
      validationState: true,
      pollState: true,
      lastHttpStatus: true,
      company: {
        select: {
          name: true,
          companyKey: true,
        },
      },
    },
    orderBy: [
      { retainedLiveJobCount: "desc" },
      { jobsAcceptedCount: "desc" },
      { yieldScore: "desc" },
    ],
  })) as WorkdayRow[];

  const enriched = rows.map((row) => {
    const valueScore = computeValueScore(row);
    const tier = getTier(valueScore);
    const target = parseWorkdaySourceToken(row.token);
    const successRate =
      row.pollAttemptCount > 0 ? row.pollSuccessCount / row.pollAttemptCount : 0;

    return {
      ...row,
      host: target.host,
      tenant: target.tenant,
      site: target.site,
      valueScore: Math.round(valueScore * 1000) / 1000,
      successRate: Math.round(successRate * 1000) / 1000,
      tier,
    };
  });

  const totalRetained = enriched.reduce((sum, row) => sum + row.retainedLiveJobCount, 0);

  const summarizeTop = (count: number) => {
    const slice = enriched.slice(0, count);
    const retained = slice.reduce((sum, row) => sum + row.retainedLiveJobCount, 0);
    const accepted = slice.reduce((sum, row) => sum + row.jobsAcceptedCount, 0);
    return {
      count: slice.length,
      retainedLiveJobs: retained,
      acceptedJobs: accepted,
      shareOfRetainedLiveJobs:
        totalRetained > 0 ? Math.round((retained / totalRetained) * 1000) / 1000 : 0,
    };
  };

  const hostStats = new Map<
    string,
    {
      sourceCount: number;
      retainedLiveJobs: number;
      acceptedJobs: number;
      blockedCount: number;
    }
  >();

  for (const row of enriched) {
    const current = hostStats.get(row.host) ?? {
      sourceCount: 0,
      retainedLiveJobs: 0,
      acceptedJobs: 0,
      blockedCount: 0,
    };
    current.sourceCount += 1;
    current.retainedLiveJobs += row.retainedLiveJobCount;
    current.acceptedJobs += row.jobsAcceptedCount;
    if ([401, 403, 429, 500, 502, 503, 504].includes(row.lastHttpStatus ?? 0)) {
      current.blockedCount += 1;
    }
    hostStats.set(row.host, current);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    totalSources: enriched.length,
    totalRetainedLiveJobs: totalRetained,
    tierCounts: {
      A: enriched.filter((row) => row.tier === "A").length,
      B: enriched.filter((row) => row.tier === "B").length,
      C: enriched.filter((row) => row.tier === "C").length,
    },
    top20: summarizeTop(20),
    top50: summarizeTop(50),
    top100: summarizeTop(100),
    topSources: enriched.slice(0, 100).map((row) => ({
      sourceName: row.sourceName,
      companyName: row.company?.name ?? null,
      host: row.host,
      site: row.site,
      retainedLiveJobCount: row.retainedLiveJobCount,
      jobsAcceptedCount: row.jobsAcceptedCount,
      valueScore: row.valueScore,
      tier: row.tier,
      successRate: row.successRate,
      yieldScore: row.yieldScore,
      lastSuccessfulPollAt: row.lastSuccessfulPollAt?.toISOString() ?? null,
      lastHttpStatus: row.lastHttpStatus,
    })),
    topHosts: [...hostStats.entries()]
      .map(([host, stats]) => ({ host, ...stats }))
      .sort((left, right) => right.retainedLiveJobs - left.retainedLiveJobs)
      .slice(0, 25),
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(
      "[workday:analyze] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
