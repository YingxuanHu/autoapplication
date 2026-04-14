import "dotenv/config";
import { syncProductiveAtsTenantsToDiscoveryStore } from "../src/lib/ingestion/ats-tenant-store";
import { prisma } from "../src/lib/db";

type CliArgs = {
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await syncProductiveAtsTenantsToDiscoveryStore({
    dryRun: args.dryRun,
  });

  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        candidateCount: result.candidateCount,
        promotedCount: result.promotedCount,
        demotedCount: result.demotedCount,
        connectorCounts: result.connectorCounts,
        discoveryStorePath: result.discoveryStorePath,
        inventoryPath: result.inventoryPath,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      "[source:sync-ats-tenants] failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
