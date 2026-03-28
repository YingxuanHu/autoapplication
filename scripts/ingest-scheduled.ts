import "dotenv/config";
import { runScheduledIngestion } from "../src/lib/ingestion/scheduler";
import { prisma } from "../src/lib/db";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runScheduledIngestion({
    force: args.force,
    connectorKeys: args.connectors,
    triggerLabel: "script.ingest.schedule",
  });

  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs: {
    force: boolean;
    connectors?: string[];
  } = {
    force: false,
  };

  for (const rawArg of rawArgs) {
    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "force") {
      parsedArgs.force = value
        ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
        : true;
    }

    if (key === "connectors" && value) {
      parsedArgs.connectors = value
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
    }
  }

  return parsedArgs;
}

main()
  .catch((error) => {
    console.error("Scheduled ingestion failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
