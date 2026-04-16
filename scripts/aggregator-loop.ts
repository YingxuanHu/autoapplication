/**
 * Aggregator loop — keeps the six feed aggregators fresh on cadence.
 *
 * This is a safety net parallel to the main ingest daemon. The main daemon
 * runs aggregators AFTER the heavy SourceTask queue processing each cycle,
 * which means aggregators can starve when the queue backlog is large.
 *
 * This script only runs the lightweight aggregator connectors on a tight
 * cadence. It bypasses the scheduler and directly calls ingestConnector with
 * allowOverlappingRuns=false, so if the daemon is mid-run on a connector,
 * this loop skips it safely.
 *
 *   npx tsx scripts/aggregator-loop.ts                   # default cadences
 *   npx tsx scripts/aggregator-loop.ts --interval=30     # minutes between cycles
 *   npx tsx scripts/aggregator-loop.ts --once            # one pass and exit
 */
import "dotenv/config";
import { ingestConnector } from "@/lib/ingestion/pipeline";
import {
  createHimalayasConnector,
  createJobicyConnector,
  createMuseConnector,
  createRemoteOkConnector,
  createRemotiveConnector,
  createWeWorkRemotelyConnector,
} from "@/lib/ingestion/connectors";
import { prisma } from "@/lib/db";
import type { SourceConnector } from "@/lib/ingestion/types";

type Entry = {
  key: string;
  connector: SourceConnector;
  cadenceMinutes: number;
};

const ENTRIES: Entry[] = [
  { key: "himalayas:feed", connector: createHimalayasConnector({ profile: "global" }), cadenceMinutes: 360 },
  { key: "remotive:feed", connector: createRemotiveConnector(), cadenceMinutes: 360 },
  { key: "jobicy:feed", connector: createJobicyConnector(), cadenceMinutes: 360 },
  { key: "themuse:feed", connector: createMuseConnector(), cadenceMinutes: 360 },
  { key: "remoteok:feed", connector: createRemoteOkConnector(), cadenceMinutes: 360 },
  { key: "weworkremotely:feed", connector: createWeWorkRemotelyConnector(), cadenceMinutes: 180 },
];

type ParsedArgs = {
  interval: number;
  once: boolean;
  maxRuntimeMs: number;
};

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let interval = 30; // minutes between cycles
  let once = false;
  let maxRuntimeMs = 4 * 60 * 1000;
  for (const arg of argv) {
    if (arg === "--once") once = true;
    else if (arg.startsWith("--interval=")) {
      const v = Number(arg.split("=")[1]);
      if (v > 0) interval = v;
    } else if (arg.startsWith("--max-runtime-ms=")) {
      const v = Number(arg.split("=")[1]);
      if (v > 0) maxRuntimeMs = v;
    }
  }
  return { interval, once, maxRuntimeMs };
}

async function lastRunAgeMinutes(connectorKey: string, now: Date) {
  const last = await prisma.ingestionRun.findFirst({
    where: { connectorKey, status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  if (!last) return Number.POSITIVE_INFINITY;
  return (now.getTime() - last.startedAt.getTime()) / 60000;
}

async function runCycle(args: ParsedArgs) {
  const now = new Date();
  const results: Array<{
    key: string;
    skipped: boolean;
    reason?: string;
    status?: string;
    fetched?: number;
    accepted?: number;
    live?: number;
    durationSec?: number;
    error?: string;
  }> = [];
  for (const entry of ENTRIES) {
    const ageMin = await lastRunAgeMinutes(entry.key, now);
    if (ageMin < entry.cadenceMinutes) {
      results.push({
        key: entry.key,
        skipped: true,
        reason: `not due (age=${ageMin.toFixed(0)}min < cadence=${entry.cadenceMinutes}min)`,
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const result = await ingestConnector(entry.connector, {
        now: new Date(),
        triggerLabel: "aggregator-loop",
        maxRuntimeMs: args.maxRuntimeMs,
        allowOverlappingRuns: false,
        runMode: "SCHEDULED",
      });
      const durationSec = (Date.now() - t0) / 1000;
      results.push({
        key: entry.key,
        skipped: false,
        status: result.status ?? undefined,
        fetched: result.fetchedCount ?? 0,
        accepted: result.acceptedCount ?? 0,
        live: result.liveCount ?? 0,
        durationSec,
      });
    } catch (e: any) {
      const durationSec = (Date.now() - t0) / 1000;
      results.push({
        key: entry.key,
        skipped: false,
        durationSec,
        error: e?.message ?? String(e),
      });
    }
  }
  return results;
}

function formatResults(
  results: Awaited<ReturnType<typeof runCycle>>,
  cycleNum: number,
  cycleStart: Date
) {
  const lines: string[] = [];
  lines.push(
    `[agg-loop] ─── Cycle #${cycleNum} at ${cycleStart.toISOString()} ───`
  );
  let totalLive = 0;
  let ran = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.skipped) {
      skipped++;
      lines.push(`  ⏭  ${r.key.padEnd(24)} ${r.reason}`);
    } else if (r.error) {
      failed++;
      lines.push(`  ✗  ${r.key.padEnd(24)} FAILED in ${r.durationSec?.toFixed(1)}s — ${r.error}`);
    } else {
      ran++;
      totalLive += r.live ?? 0;
      lines.push(
        `  ${r.status === "SUCCESS" ? "✓" : "✗"}  ${r.key.padEnd(24)} ${r.status} in ${r.durationSec?.toFixed(1)}s — f=${r.fetched} a=${r.accepted} l=${r.live}`
      );
    }
  }
  lines.push(
    `[agg-loop] Cycle summary: ran=${ran}, skipped=${skipped}, failed=${failed}, total new LIVE=${totalLive}`
  );
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();
  console.log(
    `[agg-loop] Starting. interval=${args.interval}min, once=${args.once}, maxRuntimeMs=${args.maxRuntimeMs}`
  );
  let cycleNum = 0;
  let running = true;
  const stop = () => {
    console.log("\n[agg-loop] Shutdown requested, finishing current cycle...");
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    cycleNum++;
    const cycleStart = new Date();
    try {
      const results = await runCycle(args);
      console.log(formatResults(results, cycleNum, cycleStart));
    } catch (e: any) {
      console.error(`[agg-loop] Cycle #${cycleNum} failed:`, e?.message ?? e);
    }
    if (args.once || !running) break;
    const sleepMs = args.interval * 60 * 1000;
    const wakeAt = new Date(Date.now() + sleepMs);
    console.log(
      `[agg-loop] Next cycle at ${wakeAt.toISOString()} (sleeping ${args.interval}min)`
    );
    // Sleep with shutdown check every 10s
    const checkMs = 10_000;
    let slept = 0;
    while (slept < sleepMs && running) {
      await new Promise((r) => setTimeout(r, checkMs));
      slept += checkMs;
    }
  }

  console.log(`[agg-loop] Stopped after ${cycleNum} cycle(s).`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
