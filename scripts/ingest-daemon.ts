/**
 * Ingestion daemon — continuously runs scheduled connectors on cadence.
 *
 * Usage:
 *   npm run ingest:daemon
 *   npm run ingest:daemon -- --interval=10   (minutes between cycles, default 10)
 *   npm run ingest:daemon -- --force          (ignore cadence on first cycle)
 *
 * What it does each cycle:
 *   1. Runs all scheduled connectors that are due (respects cadence)
 *   2. Schedules and runs discovery, rediscovery, company-source polling, and URL health queues
 *   3. Reconciles canonical job lifecycle (LIVE → AGING → STALE → EXPIRED → REMOVED)
 *   3. Sleeps until the next cycle
 *
 * Leave it running in a terminal. Ctrl+C to stop gracefully.
 */
import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runOperationalQueues,
  scheduleOperationalQueues,
} from "../src/lib/ingestion/network-orchestrator";
import { runScheduledIngestion } from "../src/lib/ingestion/scheduler";
import { prisma } from "../src/lib/db";

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 360;
const DAEMON_RUNTIME_DIR = path.join(process.cwd(), ".runtime");
const DAEMON_LOCK_PATH = path.join(DAEMON_RUNTIME_DIR, "ingest-daemon.lock.json");

type DaemonLock = {
  pid: number;
  startedAt: string;
  argv: string[];
};

async function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireDaemonLock() {
  await mkdir(DAEMON_RUNTIME_DIR, { recursive: true });

  try {
    const existingRaw = await readFile(DAEMON_LOCK_PATH, "utf8");
    const existing = JSON.parse(existingRaw) as Partial<DaemonLock>;
    const existingPid = typeof existing.pid === "number" ? existing.pid : null;

    if (existingPid && existingPid !== process.pid && (await processExists(existingPid))) {
      console.error(
        `[daemon] Another ingest daemon is already running (pid ${existingPid}). Refusing to start a second instance.`
      );
      return false;
    }
  } catch {
    // no existing lock or unreadable stale file; overwrite below
  }

  const lock: DaemonLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
  };
  await writeFile(DAEMON_LOCK_PATH, JSON.stringify(lock, null, 2), "utf8");
  return true;
}

async function releaseDaemonLock() {
  try {
    const existingRaw = await readFile(DAEMON_LOCK_PATH, "utf8");
    const existing = JSON.parse(existingRaw) as Partial<DaemonLock>;
    if (existing.pid === process.pid) {
      await rm(DAEMON_LOCK_PATH, { force: true });
    }
  } catch {
    // already gone or unreadable
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lockAcquired = await acquireDaemonLock();
  if (!lockAcquired) {
    return;
  }

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
  let running = true;
  let shutdownRequested = false;
  let forceExitRequested = false;

  // Graceful shutdown
  const shutdown = () => {
    if (forceExitRequested) {
      return;
    }

    if (shutdownRequested) {
      forceExitRequested = true;
      console.log("\n[daemon] Force shutdown requested. Exiting now.");
      process.exit(130);
    }

    shutdownRequested = true;
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
      const scheduledQueues = await scheduleOperationalQueues({
        now: cycleStart,
        validationLimit: 180,
        sourcePollLimit: 260,
      });
      const queueResult = await runOperationalQueues({
        now: cycleStart,
        validationLimit: 180,
        sourcePollLimit: 260,
      });

      const executedCount = result.executedRuns.length;
      const skippedCount = result.skippedConnectors.length;
      totalExecuted += executedCount;

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
        const notDueCount = result.skippedConnectors.filter(
          (entry) => entry.reason === "not_due"
        ).length;
        const managedCount = result.skippedConnectors.filter(
          (entry) => entry.reason === "managed_by_company_source"
        ).length;
        console.log(
          `[daemon] Skipped ${skippedCount} connector(s): ${notDueCount} not due, ${managedCount} routed to CompanySource`
        );
      }

      console.log(
        `[daemon] Queues scheduled: discovery ${scheduledQueues.discovery.enqueuedCount}, validation ${scheduledQueues.validation.enqueuedCount}, source poll ${scheduledQueues.sourcePoll.enqueuedCount}, rediscovery ${scheduledQueues.rediscovery.enqueuedCount}, health ${scheduledQueues.urlHealth.enqueuedCount}`
      );
      console.log(
        `[daemon] Queues processed: discovery ${queueResult.discovery.successCount}/${queueResult.discovery.processedCount}, validation ${queueResult.validation.successCount}/${queueResult.validation.processedCount}, source poll ${queueResult.sourcePoll.successCount}/${queueResult.sourcePoll.processedCount}, rediscovery ${queueResult.rediscovery.successCount}/${queueResult.rediscovery.processedCount}, health ${queueResult.urlHealth.checkedJobCount}/${queueResult.urlHealth.processedCount}`
      );

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
    await releaseDaemonLock();
    await prisma.$disconnect();
  });
