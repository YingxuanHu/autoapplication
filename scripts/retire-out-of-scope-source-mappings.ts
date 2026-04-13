import "dotenv/config";
import { prisma } from "../src/lib/db";
import { reconcileCanonicalLifecycleByIds } from "../src/lib/ingestion/pipeline";

type CliArgs = {
  apply: boolean;
};

const OUT_OF_SCOPE_SOURCE_PREFIXES = [
  "Adzuna:fr",
  "Adzuna:be",
] as const;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  const mappings = await prisma.jobSourceMapping.findMany({
    where: {
      removedAt: null,
      OR: OUT_OF_SCOPE_SOURCE_PREFIXES.map((prefix) => ({
        sourceName: { startsWith: prefix },
      })),
      canonicalJob: {
        status: { in: ["LIVE", "AGING"] },
      },
    },
    select: {
      id: true,
      sourceName: true,
      canonicalJobId: true,
    },
  });

  const canonicalIds = [...new Set(mappings.map((mapping) => mapping.canonicalJobId))];
  const countsBySource = mappings.reduce<Record<string, number>>((acc, mapping) => {
    acc[mapping.sourceName] = (acc[mapping.sourceName] ?? 0) + 1;
    return acc;
  }, {});

  if (!args.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          mappingCount: mappings.length,
          canonicalCount: canonicalIds.length,
          countsBySource,
        },
        null,
        2
      )
    );
    return;
  }

  await prisma.jobSourceMapping.updateMany({
    where: {
      id: { in: mappings.map((mapping) => mapping.id) },
    },
    data: {
      removedAt: now,
      isPrimary: false,
    },
  });

  const lifecycle = await reconcileCanonicalLifecycleByIds(canonicalIds, { now });

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        mappingCount: mappings.length,
        canonicalCount: canonicalIds.length,
        countsBySource,
        lifecycle,
      },
      null,
      2
    )
  );
}

function parseArgs(argv: string[]): CliArgs {
  return {
    apply: argv.includes("--apply"),
  };
}

main()
  .catch((error) => {
    console.error("Failed to retire out-of-scope source mappings:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
