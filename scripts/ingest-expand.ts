import "dotenv/config";
import { prisma } from "../src/lib/db";
import {
  getExpansionProfileTargets,
  type IngestionExpansionProfile,
} from "../src/lib/ingestion/coverage";
import {
  previewConnectorIngestion,
  ingestConnector,
  reconcileCanonicalLifecycle,
} from "../src/lib/ingestion/pipeline";
import { resolveConnectors } from "../src/lib/ingestion/registry";

type Snapshot = {
  liveCount: number;
  roleFamilyCounts: Array<{ roleFamily: string; count: number }>;
  experienceCounts: Array<{ experienceLevel: string | null; count: number }>;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = args.profile ?? "recruitee_growth_batch";
  const target = getExpansionProfileTargets(profile);

  const before = await getSnapshot();
  const connectors = resolveConnectors(target.connector, buildConnectorArgs(target));

  const summaries = [];
  for (const connector of connectors) {
    summaries.push(
      args.dryRun
        ? await previewConnectorIngestion(connector, {
            runMode: "MANUAL",
          })
        : await ingestConnector(connector, {
            runMode: "MANUAL",
            triggerLabel: `expansion.${profile}`,
          })
    );
  }

  const lifecycle = args.dryRun ? null : await reconcileCanonicalLifecycle();
  const after = await getSnapshot();

  const sourceNames = summaries.map((summary) => summary.sourceName);
  const liveCoverageAfter = await prisma.jobCanonical.count({
    where: {
      status: "LIVE",
      sourceMappings: {
        some: {
          sourceName: {
            in: sourceNames,
          },
          removedAt: null,
        },
      },
    },
  });

  console.log(
    JSON.stringify(
      {
        profile,
        dryRun: args.dryRun ?? false,
        description: target.description,
        addedTargets: target.tokens,
        summaries,
        totals: summarizeRuns(summaries),
        delta: {
          liveCountBefore: before.liveCount,
          liveCountAfter: after.liveCount,
          liveCountDelta: after.liveCount - before.liveCount,
          liveCoverageAfter,
        },
        distributions: {
          roleFamilyBefore: before.roleFamilyCounts,
          roleFamilyAfter: after.roleFamilyCounts,
          experienceBefore: before.experienceCounts,
          experienceAfter: after.experienceCounts,
        },
        lifecycle,
      },
      null,
      2
    )
  );
}

function buildConnectorArgs(target: ReturnType<typeof getExpansionProfileTargets>) {
  if (target.connector === "ashby") {
    return {
      orgs: target.tokens.join(","),
    };
  }

  if (target.connector === "greenhouse") {
    return {
      boards: target.tokens.join(","),
    };
  }

  if (target.connector === "recruitee") {
    return {
      companies: target.tokens.join(","),
    };
  }

  if (target.connector === "rippling") {
    return {
      boards: target.tokens.join(","),
    };
  }

  return {};
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs: {
    profile?: IngestionExpansionProfile;
    dryRun?: boolean;
  } = {};

  for (const rawArg of rawArgs) {
    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "dry-run") {
      parsedArgs.dryRun = true;
      continue;
    }

    if (value === undefined) continue;

    if (key === "profile") {
      parsedArgs.profile = value as IngestionExpansionProfile;
    }
  }

  return parsedArgs;
}

async function getSnapshot(): Promise<Snapshot> {
  const [liveCount, roleFamilyCounts, experienceCounts] = await Promise.all([
    prisma.jobCanonical.count({
      where: { status: "LIVE" },
    }),
    prisma.jobCanonical.groupBy({
      by: ["roleFamily"],
      where: { status: "LIVE" },
      _count: { _all: true },
      orderBy: { _count: { roleFamily: "desc" } },
      take: 12,
    }),
    prisma.jobCanonical.groupBy({
      by: ["experienceLevel"],
      where: { status: "LIVE" },
      _count: { _all: true },
      orderBy: { _count: { experienceLevel: "desc" } },
    }),
  ]);

  return {
    liveCount,
    roleFamilyCounts: roleFamilyCounts.map((entry) => ({
      roleFamily: entry.roleFamily,
      count: entry._count._all,
    })),
    experienceCounts: experienceCounts.map((entry) => ({
      experienceLevel: entry.experienceLevel,
      count: entry._count._all,
    })),
  };
}

function summarizeRuns(
  summaries: Array<{
    fetchedCount: number;
    acceptedCount: number;
    canonicalCreatedCount: number;
    canonicalUpdatedCount: number;
    dedupedCount: number;
    rejectedCount: number;
  }>
) {
  return summaries.reduce(
    (accumulator, summary) => ({
      fetchedCount: accumulator.fetchedCount + summary.fetchedCount,
      acceptedCount: accumulator.acceptedCount + summary.acceptedCount,
      canonicalCreatedCount:
        accumulator.canonicalCreatedCount + summary.canonicalCreatedCount,
      canonicalUpdatedCount:
        accumulator.canonicalUpdatedCount + summary.canonicalUpdatedCount,
      dedupedCount: accumulator.dedupedCount + summary.dedupedCount,
      rejectedCount: accumulator.rejectedCount + summary.rejectedCount,
    }),
    {
      fetchedCount: 0,
      acceptedCount: 0,
      canonicalCreatedCount: 0,
      canonicalUpdatedCount: 0,
      dedupedCount: 0,
      rejectedCount: 0,
    }
  );
}

main()
  .catch((error) => {
    console.error("Expansion ingest failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
