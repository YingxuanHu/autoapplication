import "dotenv/config";
import { prisma } from "../src/lib/db";
import {
  runOperationalQueues,
  scheduleOperationalQueues,
} from "../src/lib/ingestion/network-orchestrator";

/**
 * Manually schedule and run the operational queues (discovery, validation, source poll, rediscovery).
 *
 * Usage:
 *   npx tsx scripts/network-ops.ts
 *   npx tsx scripts/network-ops.ts --schedule-only
 *   npx tsx scripts/network-ops.ts --run-only
 *   npx tsx scripts/network-ops.ts --discovery-limit=600 --validation-limit=700 --source-poll-limit=700 --rediscovery-limit=120
 */
function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)(?:=(.+))?$/);
    if (m) args[m[1]] = m[2] ?? "true";
  }
  return args;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  const shouldSchedule = !("run-only" in args);
  const shouldRun = !("schedule-only" in args);

  const discoveryLimit = args["discovery-limit"] ? parseInt(args["discovery-limit"], 10) : undefined;
  const validationLimit = args["validation-limit"] ? parseInt(args["validation-limit"], 10) : undefined;
  const sourcePollLimit = args["source-poll-limit"] ? parseInt(args["source-poll-limit"], 10) : undefined;
  const rediscoveryLimit = args["rediscovery-limit"] ? parseInt(args["rediscovery-limit"], 10) : undefined;

  const now = new Date();
  const limits = { now, discoveryLimit, validationLimit, sourcePollLimit, rediscoveryLimit };

  if (discoveryLimit !== undefined || validationLimit !== undefined || sourcePollLimit !== undefined) {
    console.log(
      `[network-ops] Limits — discovery: ${discoveryLimit ?? "default"}, validation: ${validationLimit ?? "default"}, source poll: ${sourcePollLimit ?? "default"}, rediscovery: ${rediscoveryLimit ?? "default"}`
    );
  }

  const scheduled = shouldSchedule ? await scheduleOperationalQueues(limits) : null;
  const executed = shouldRun ? await runOperationalQueues(limits) : null;

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
