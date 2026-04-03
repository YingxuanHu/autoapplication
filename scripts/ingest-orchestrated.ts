import "dotenv/config";
import { prisma } from "../src/lib/db";
import { runLaneOrchestration } from "../src/lib/ingestion/orchestrator";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runLaneOrchestration({
    force: args.force,
    totalRunSlots: args.totalRunSlots,
    maxConcurrentTasks: args.maxConcurrentTasks,
  });

  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs: {
    force?: boolean;
    totalRunSlots?: number;
    maxConcurrentTasks?: number;
  } = {};

  for (const rawArg of rawArgs) {
    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "force") {
      parsedArgs.force = value
        ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
        : true;
      continue;
    }

    if (key === "slots" && value) {
      parsedArgs.totalRunSlots = Number.parseInt(value, 10);
      continue;
    }

    if (key === "concurrency" && value) {
      parsedArgs.maxConcurrentTasks = Number.parseInt(value, 10);
    }
  }

  return parsedArgs;
}

main()
  .catch((error) => {
    console.error("Orchestrated ingestion failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
