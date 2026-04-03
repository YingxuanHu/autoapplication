/**
 * Ingestion daemon — continuously runs scheduled connectors on cadence.
 *
 * Usage:
 *   npm run ingest:daemon
 *   npm run ingest:daemon -- --interval=30   (minutes between cycles, default 30)
 *   npm run ingest:daemon -- --force          (ignore cadence on first cycle)
 *
 * What it does each cycle:
 *   1. Runs all scheduled connectors that are due (respects cadence)
 *   2. Reconciles canonical job lifecycle (LIVE → STALE → EXPIRED → REMOVED)
 *   3. Sleeps until the next cycle
 *
 * Leave it running in a terminal. Ctrl+C to stop gracefully.
 */
import "dotenv/config";
import { runScheduledIngestion } from "../src/lib/ingestion/scheduler";
import { prisma } from "../src/lib/db";

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 360;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const intervalMinutes = Math.max(
    MIN_INTERVAL_MINUTES,
    Math.min(MAX_INTERVAL_MINUTES, args.interval)
  );

  console.log(`\n┌──────────────────────────────────────────────┐`);
  console.log(`│  Ingestion Daemon                            │`);
  console.log(`│  Cycle interval: ${String(intervalMinutes).padStart(3)}min                       │`);
  console.log(`│  Force first cycle: ${args.force ? "yes" : "no "}                      │`);
  console.log(`│  Press Ctrl+C to stop                        │`);
  console.log(`└──────────────────────────────────────────────┘\n`);

  let cycleCount = 0;
  let totalExecuted = 0;
  let totalSkipped = 0;
  let running = true;

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[daemon] Shutting down after current cycle...");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    cycleCount++;
    const cycleStart = new Date();
    const isFirstCycle = cycleCount === 1;

    console.log(
      `\n[daemon] ─── Cycle #${cycleCount} starting at ${cycleStart.toISOString()} ───`
    );

    try {
      const result = await runScheduledIngestion({
        now: cycleStart,
        force: isFirstCycle && args.force,
        triggerLabel: "script.ingest.daemon",
      });

      const executedCount = result.executedRuns.length;
      const skippedCount = result.skippedConnectors.length;
      totalExecuted += executedCount;
      totalSkipped += skippedCount;

      // Summary of executed runs
      if (executedCount > 0) {
        console.log(`[daemon] Executed ${executedCount} connector(s):`);
        for (const run of result.executedRuns) {
          const created = run.canonicalCreatedCount ?? 0;
          const updated = run.canonicalUpdatedCount ?? 0;
          const accepted = run.acceptedCount ?? 0;
          const status = run.status ?? "?";
          console.log(
            `  ${status === "SUCCESS" ? "✓" : "✗"} ${run.connectorKey} — ${accepted} accepted, ${created} new, ${updated} updated`
          );
        }
      }

      if (skippedCount > 0) {
        console.log(`[daemon] Skipped ${skippedCount} connector(s) (not due yet)`);
      }

      // Lifecycle summary
      const lc = result.lifecycle;
      console.log(
        `[daemon] Lifecycle: ${lc.liveCount} live, ${lc.staleCount} stale, ${lc.expiredCount} expired, ${lc.removedCount} removed`
      );

      // Aggregate stats
      const totalNewThisCycle = result.executedRuns.reduce(
        (sum, r) => sum + (r.canonicalCreatedCount ?? 0),
        0
      );
      if (totalNewThisCycle > 0) {
        console.log(
          `[daemon] +${totalNewThisCycle} new jobs this cycle → ${lc.liveCount} total live`
        );
      }
    } catch (error) {
      console.error(
        `[daemon] Cycle #${cycleCount} failed:`,
        error instanceof Error ? error.message : error
      );
    }

    const cycleEnd = new Date();
    const cycleDurationMs = cycleEnd.getTime() - cycleStart.getTime();
    const cycleDurationMin = (cycleDurationMs / 60000).toFixed(1);
    console.log(`[daemon] Cycle #${cycleCount} took ${cycleDurationMin}min`);

    if (!running) break;

    // Sleep until next cycle
    const sleepMs = intervalMinutes * 60 * 1000 - cycleDurationMs;
    if (sleepMs > 0) {
      const nextCycleAt = new Date(Date.now() + sleepMs);
      console.log(
        `[daemon] Next cycle at ${nextCycleAt.toLocaleTimeString()} (sleeping ${(sleepMs / 60000).toFixed(0)}min)`
      );
      await interruptibleSleep(sleepMs, () => !running);
    }
  }

  console.log(
    `\n[daemon] Stopped. ${cycleCount} cycles, ${totalExecuted} total runs executed.`
  );
}

function interruptibleSleep(
  ms: number,
  shouldStop: () => boolean
): Promise<void> {
  return new Promise((resolve) => {
    const checkInterval = 5000; // Check every 5s for shutdown
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (elapsed >= ms || shouldStop()) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs = {
    force: false,
    interval: DEFAULT_INTERVAL_MINUTES,
  };

  for (const rawArg of rawArgs) {
    const [key, value] = rawArg.replace(/^--/, "").split("=");
    if (!key) continue;

    if (key === "force") {
      parsedArgs.force = value
        ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
        : true;
    }

    if (key === "interval" && value) {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && parsed > 0) {
        parsedArgs.interval = parsed;
      }
    }
  }

  return parsedArgs;
}

main()
  .catch((error) => {
    console.error("Daemon failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
