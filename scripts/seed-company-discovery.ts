import "dotenv/config";
import { prisma } from "../src/lib/db";
import { seedCompanyDiscoveryUniverse } from "../src/lib/ingestion/company-discovery";
import { scheduleOperationalQueues } from "../src/lib/ingestion/network-orchestrator";

function parseArgs(rawArgs: string[]) {
  const parsed = {
    inventoryLimit: 10000,
    existingAtsLimit: 2500,
    catalogLimit: 1000,
    corpusLimit: 5000,
    schedule: true,
  };

  for (const rawArg of rawArgs) {
    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "inventory-limit" && value) {
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isNaN(parsedValue) && parsedValue > 0) {
        parsed.inventoryLimit = parsedValue;
      }
    }

    if (key === "existing-ats-limit" && value) {
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isNaN(parsedValue) && parsedValue > 0) {
        parsed.existingAtsLimit = parsedValue;
      }
    }

    if (key === "catalog-limit" && value) {
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isNaN(parsedValue) && parsedValue > 0) {
        parsed.catalogLimit = parsedValue;
      }
    }

    if (key === "corpus-limit" && value) {
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isNaN(parsedValue) && parsedValue > 0) {
        parsed.corpusLimit = parsedValue;
      }
    }

    if (key === "no-schedule") {
      parsed.schedule = false;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seeded = await seedCompanyDiscoveryUniverse({
    inventoryLimit: args.inventoryLimit,
    existingAtsLimit: args.existingAtsLimit,
    catalogLimit: args.catalogLimit,
    corpusLimit: args.corpusLimit,
  });

  const scheduled = args.schedule ? await scheduleOperationalQueues() : null;

  console.log(
    JSON.stringify(
      {
        seeded,
        scheduled,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error("Company discovery seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
