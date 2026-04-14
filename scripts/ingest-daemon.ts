/**
 * Ingestion daemon — continuously runs scheduled connectors on cadence.
 *
 * Usage:
 *   npm run ingest:daemon
 *   npm run ingest:daemon -- --interval=10   (minutes between cycles, default 10)
 *   npm run ingest:daemon -- --force          (ignore cadence on first cycle)
 *
 * What it does each cycle:
 *   1. Schedules and runs discovery, rediscovery, company-source polling, and URL health queues
 *   2. Runs a bounded pass of legacy scheduled connectors that are due
 *   3. Reconciles canonical job lifecycle (LIVE → AGING → STALE → EXPIRED → REMOVED)
 *   4. Sleeps until the next cycle
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
import { syncProductiveAtsTenantsToDiscoveryStore } from "../src/lib/ingestion/ats-tenant-store";
import { runScheduledIngestion } from "../src/lib/ingestion/scheduler";
import { prisma } from "../src/lib/db";
import type { SourceTaskKind } from "../src/generated/prisma/client";

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 360;
const STEADY_DISCOVERY_LIMIT = 300;        // up from 200 — faster company pipeline
const STEADY_VALIDATION_LIMIT = 700;       // up from 500
const STEADY_SOURCE_POLL_LIMIT = 700;      // up from 500
const STEADY_REDISCOVERY_LIMIT = 120;      // up from 80
const STEADY_URL_HEALTH_LIMIT = 3_000;     // up from 2,000 — matches new concurrency
const BURST_DISCOVERY_LIMIT = 500;         // up from 300
const BURST_VALIDATION_LIMIT = 1_000;      // up from 700
const BURST_SOURCE_POLL_LIMIT = 1_000;     // up from 700
const BURST_REDISCOVERY_LIMIT = 200;       // up from 120
const BURST_URL_HEALTH_LIMIT = 5_000;      // up from 3,000 — clear the backlog faster
const STEADY_LEGACY_SCHEDULED_CONNECTOR_CYCLE_BUDGET_MS = 3 * 60 * 1000;
const STEADY_LEGACY_SCHEDULED_CONNECTOR_MAX_RUNS = 36;
const BURST_LEGACY_SCHEDULED_CONNECTOR_CYCLE_BUDGET_MS = 6 * 60 * 1000;
const BURST_LEGACY_SCHEDULED_CONNECTOR_MAX_RUNS = 72;
const DUE_BACKLOG_CATCH_UP_SLEEP_MS = 15 * 1000;
const DUE_BACKLOG_STALLED_RETRY_SLEEP_MS = 60 * 1000;
const DUE_BACKLOG_POLL_THRESHOLD = 100;
const DUE_BACKLOG_VALIDATION_THRESHOLD = 25;
const DUE_BACKLOG_DISCOVERY_THRESHOLD = 100;
const DUE_BACKLOG_REDISCOVERY_THRESHOLD = 50;
const DAEMON_RUNTIME_DIR = path.join(process.cwd(), ".runtime");
const DAEMON_LOCK_PATH = path.join(DAEMON_RUNTIME_DIR, "ingest-daemon.lock.json");

type DaemonLock = {
  pid: number;
  startedAt: string;
  argv: string[];
};

type CycleQueueProfile = {
  discoveryLimit: number;
  validationLimit: number;
  sourcePollLimit: number;
  rediscoveryLimit: number;
  urlHealthLimit: number;
  legacyBudgetMs: number;
  legacyMaxRuns: number;
  label: "burst" | "steady";
};

type DueOperationalBacklog = {
  companyDiscovery: number;
  sourceValidation: number;
  connectorPoll: number;
  rediscovery: number;
  total: number;
};

function getCycleQueueProfile(isFirstCycle: boolean): CycleQueueProfile {
  if (isFirstCycle) {
    return {
      discoveryLimit: BURST_DISCOVERY_LIMIT,
      validationLimit: BURST_VALIDATION_LIMIT,
      sourcePollLimit: BURST_SOURCE_POLL_LIMIT,
      rediscoveryLimit: BURST_REDISCOVERY_LIMIT,
      urlHealthLimit: BURST_URL_HEALTH_LIMIT,
      legacyBudgetMs: BURST_LEGACY_SCHEDULED_CONNECTOR_CYCLE_BUDGET_MS,
      legacyMaxRuns: BURST_LEGACY_SCHEDULED_CONNECTOR_MAX_RUNS,
      label: "burst",
    };
  }

  return {
    discoveryLimit: STEADY_DISCOVERY_LIMIT,
    validationLimit: STEADY_VALIDATION_LIMIT,
    sourcePollLimit: STEADY_SOURCE_POLL_LIMIT,
    rediscoveryLimit: STEADY_REDISCOVERY_LIMIT,
    urlHealthLimit: STEADY_URL_HEALTH_LIMIT,
    legacyBudgetMs: STEADY_LEGACY_SCHEDULED_CONNECTOR_CYCLE_BUDGET_MS,
    legacyMaxRuns: STEADY_LEGACY_SCHEDULED_CONNECTOR_MAX_RUNS,
    label: "steady",
  };
}

async function getDueOperationalBacklog(now: Date): Promise<DueOperationalBacklog> {
  const grouped = await prisma.sourceTask.groupBy({
    by: ["kind"],
    where: {
      status: "PENDING",
      notBeforeAt: { lte: now },
      kind: {
        in: [
          "COMPANY_DISCOVERY",
          "SOURCE_VALIDATION",
          "CONNECTOR_POLL",
          "REDISCOVERY",
        ] satisfies SourceTaskKind[],
      },
    },
    _count: { _all: true },
  });

  const counts = new Map(
    grouped.map((row) => [row.kind, row._count._all] as const)
  );

  const backlog = {
    companyDiscovery: counts.get("COMPANY_DISCOVERY") ?? 0,
    sourceValidation: counts.get("SOURCE_VALIDATION") ?? 0,
    connectorPoll: counts.get("CONNECTOR_POLL") ?? 0,
    rediscovery: counts.get("REDISCOVERY") ?? 0,
    total: 0,
  };

  backlog.total =
    backlog.companyDiscovery +
    backlog.sourceValidation +
    backlog.connectorPoll +
    backlog.rediscovery;

  return backlog;
}

function hasSignificantDueBacklog(backlog: DueOperationalBacklog) {
  return (
    backlog.connectorPoll >= DUE_BACKLOG_POLL_THRESHOLD ||
    backlog.sourceValidation >= DUE_BACKLOG_VALIDATION_THRESHOLD ||
    backlog.companyDiscovery >= DUE_BACKLOG_DISCOVERY_THRESHOLD ||
    backlog.rediscovery >= DUE_BACKLOG_REDISCOVERY_THRESHOLD
  );
}

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
  let immediateExitRequested = false;

  const exitImmediately = (signal: NodeJS.Signals, code: number) => {
    if (immediateExitRequested) {
      return;
    }

    immediateExitRequested = true;
    forceExitRequested = true;
    running = false;
    console.log(`\n[daemon] Immediate shutdown (${signal}).`);
    void releaseDaemonLock().finally(() => {
      process.exit(code);
    });
  };

  const requestGracefulShutdown = () => {
    if (forceExitRequested) {
      return;
    }

    if (shutdownRequested) {
      forceExitRequested = true;
      console.log("\n[daemon] Force shutdown requested. Exiting now.");
      exitImmediately("SIGINT", 130);
      return;
    }

    shutdownRequested = true;
    console.log("\n[daemon] Shutting down after current cycle...");
    running = false;
  };
  process.on("SIGINT", requestGracefulShutdown);
  process.on("SIGTERM", () => exitImmediately("SIGTERM", 143));

  while (running) {
    cycleCount++;
    const cycleStart = new Date();
    const isFirstCycle = cycleCount === 1;
    const profile = getCycleQueueProfile(isFirstCycle);

    // Kill any leftover Chromium zombie processes from previous headless renders.
    // These accumulate when Playwright tasks time out without cleaning up the
    // underlying browser process.
    try {
      const { execSync } = await import("node:child_process");
      execSync("pkill -9 -f 'chromium' 2>/dev/null || true", { stdio: "ignore" });
    } catch { /* not critical */ }

    console.log(
      `\n[daemon] ─── Cycle #${cycleCount} starting at ${cycleStart.toISOString()} ───`
    );
    console.log(
      `[daemon] Cycle profile: ${profile.label} (discovery ${profile.discoveryLimit}, validation ${profile.validationLimit}, source poll ${profile.sourcePollLimit}, rediscovery ${profile.rediscoveryLimit}, url health ${profile.urlHealthLimit}, legacy budget ${Math.round(profile.legacyBudgetMs / 60_000)}min/${profile.legacyMaxRuns} runs)`
    );

    try {
      const scheduledQueues = await scheduleOperationalQueues({
        now: cycleStart,
        discoveryLimit: profile.discoveryLimit,
        validationLimit: profile.validationLimit,
        sourcePollLimit: profile.sourcePollLimit,
        rediscoveryLimit: profile.rediscoveryLimit,
        urlHealthLimit: profile.urlHealthLimit,
      });
      const queueResult = await runOperationalQueues({
        now: cycleStart,
        discoveryLimit: profile.discoveryLimit,
        validationLimit: profile.validationLimit,
        sourcePollLimit: profile.sourcePollLimit,
        rediscoveryLimit: profile.rediscoveryLimit,
        urlHealthLimit: profile.urlHealthLimit,
      });
      const atsTenantSync = await syncProductiveAtsTenantsToDiscoveryStore({
        now: new Date(),
      });
      const result = await runScheduledIngestion({
        now: cycleStart,
        force: isFirstCycle && args.force,
        triggerLabel: "script.ingest.daemon",
        maxCycleDurationMs: profile.legacyBudgetMs,
        maxConnectorRuns: profile.legacyMaxRuns,
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
        const cycleBudgetCount = result.skippedConnectors.filter(
          (entry) => entry.reason === "cycle_budget_exhausted"
        ).length;
        console.log(
          `[daemon] Skipped ${skippedCount} connector(s): ${notDueCount} not due, ${managedCount} routed to CompanySource, ${cycleBudgetCount} deferred by cycle budget`
        );
      }

      console.log(
        `[daemon] Queues scheduled: discovery ${scheduledQueues.discovery.enqueuedCount}, validation ${scheduledQueues.validation.enqueuedCount}, source poll ${scheduledQueues.sourcePoll.enqueuedCount}, rediscovery ${scheduledQueues.rediscovery.enqueuedCount}, health ${scheduledQueues.urlHealth.enqueuedCount}`
      );
      console.log(
        `[daemon] Queues processed: discovery ${queueResult.discovery.successCount}/${queueResult.discovery.processedCount}, validation ${queueResult.validation.successCount}/${queueResult.validation.processedCount}, source poll ${queueResult.sourcePoll.successCount}/${queueResult.sourcePoll.processedCount}, rediscovery ${queueResult.rediscovery.successCount}/${queueResult.rediscovery.processedCount}, health ${queueResult.urlHealth.checkedJobCount}/${queueResult.urlHealth.processedCount}`
      );
      console.log(
        `[daemon] ATS tenant sync: ${atsTenantSync.candidateCount} candidates, ${atsTenantSync.promotedCount} promoted, ${atsTenantSync.demotedCount} demoted`
      );
      if ("executionPolicy" in queueResult) {
        const policy = queueResult.executionPolicy;
        console.log(
          `[daemon] Queue policy: pending poll ${policy.pendingPollCount}, pending validation ${policy.pendingValidationCount}, discovery ${policy.throttledDiscovery ? "throttled" : "full"} (${policy.discoveryLimit ?? 0}), rediscovery ${policy.rediscoveryLimit ?? 0}`
        );
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

      const dueBacklog = await getDueOperationalBacklog(new Date());
      const operationalProcessedCount =
        queueResult.discovery.processedCount +
        queueResult.validation.processedCount +
        queueResult.sourcePoll.processedCount +
        queueResult.rediscovery.processedCount;
      const madeProgress = operationalProcessedCount > 0 || executedCount > 0;

      if (running && hasSignificantDueBacklog(dueBacklog)) {
        const catchUpSleepMs = madeProgress
          ? DUE_BACKLOG_CATCH_UP_SLEEP_MS
          : DUE_BACKLOG_STALLED_RETRY_SLEEP_MS;
        console.log(
          `[daemon] Due backlog remains: discovery ${dueBacklog.companyDiscovery}, validation ${dueBacklog.sourceValidation}, source poll ${dueBacklog.connectorPoll}, rediscovery ${dueBacklog.rediscovery}`
        );
        console.log(
          `[daemon] Starting catch-up cycle in ${(catchUpSleepMs / 1000).toFixed(0)}s instead of sleeping ${intervalMinutes}min`
        );
        await interruptibleSleep(catchUpSleepMs, () => !running);
        continue;
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
