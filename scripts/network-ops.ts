import "dotenv/config";
import { prisma } from "../src/lib/db";
import {
  runOperationalQueues,
  scheduleOperationalQueues,
} from "../src/lib/ingestion/network-orchestrator";

async function main() {
  const args = new Set(process.argv.slice(2));
  const shouldSchedule = !args.has("--run-only");
  const shouldRun = !args.has("--schedule-only");

  const scheduled = shouldSchedule ? await scheduleOperationalQueues() : null;
  const executed = shouldRun ? await runOperationalQueues() : null;

  console.log(
    JSON.stringify(
      {
        scheduled,
        executed,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error("Network ops failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
