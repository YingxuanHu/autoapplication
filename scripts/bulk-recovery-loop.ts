import "dotenv/config";

import process from "node:process";
import { prisma } from "@/lib/db";
import { ingestConnector } from "@/lib/ingestion/pipeline";
import {
  createAdzunaConnector,
  createHimalayasConnector,
  createJobBankConnector,
  createJobicyConnector,
  createMuseConnector,
  createRemoteOkConnector,
  createRemotiveConnector,
  createUsaJobsConnector,
  createWeWorkRemotelyConnector,
} from "@/lib/ingestion/connectors";
import type { SourceConnector } from "@/lib/ingestion/types";

type Entry = {
  key: string;
  cadenceKey?: string;
  connector: SourceConnector;
  cadenceMinutes: number;
  maxRuntimeMs: number;
  limit?: number;
};

type ParsedArgs = {
  intervalMinutes: number;
  catchupSeconds: number;
  keyFilters: string[];
  once: boolean;
};

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): ParsedArgs {
  let intervalMinutes = parsePositiveInteger(
    process.env.BULK_RECOVERY_LOOP_INTERVAL_MINUTES,
    10
  );
  let catchupSeconds = parsePositiveInteger(
    process.env.BULK_RECOVERY_LOOP_CATCHUP_SECONDS,
    60
  );
  let keyFilters = (process.env.BULK_RECOVERY_LOOP_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let once = false;

  for (const arg of argv) {
    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg.startsWith("--interval=")) {
      intervalMinutes = parsePositiveInteger(arg.split("=")[1], intervalMinutes);
    }

    if (arg.startsWith("--catchup-seconds=")) {
      catchupSeconds = parsePositiveInteger(arg.split("=")[1], catchupSeconds);
    }

    if (arg.startsWith("--keys=")) {
      keyFilters = arg
        .slice("--keys=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }

  return { intervalMinutes, catchupSeconds, keyFilters, once };
}

function getBulkRecoveryEntries(): Entry[] {
  const adzunaRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_MAX_RUNTIME_MS,
    4 * 60 * 1000
  );
  const adzunaLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_LIMIT,
    1_500
  );
  const usaJobsRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_USAJOBS_MAX_RUNTIME_MS,
    2 * 60 * 1000
  );
  const jobBankRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOBBANK_MAX_RUNTIME_MS,
    8 * 60 * 1000
  );
  const adzunaPrimaryCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_PRIMARY_CADENCE_MINUTES,
    30
  );
  const adzunaSecondaryCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_SECONDARY_CADENCE_MINUTES,
    45
  );
  const adzunaBroadCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_BROAD_CADENCE_MINUTES,
    90
  );
  const adzunaSecondaryRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_SECONDARY_MAX_RUNTIME_MS,
    3 * 60 * 1000
  );
  const adzunaBroadRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_BROAD_MAX_RUNTIME_MS,
    4 * 60 * 1000
  );
  const adzunaSecondaryLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_SECONDARY_LIMIT,
    1_200
  );
  const adzunaBroadLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_BROAD_LIMIT,
    2_500
  );
  const usaJobsCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_USAJOBS_CADENCE_MINUTES,
    90
  );
  const jobBankCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOBBANK_CADENCE_MINUTES,
    720
  );
  const museCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_MUSE_CADENCE_MINUTES,
    60
  );
  const museRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_MUSE_MAX_RUNTIME_MS,
    2 * 60 * 1000
  );
  const remotiveCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_REMOTIVE_CADENCE_MINUTES,
    60
  );
  const remotiveRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_REMOTIVE_MAX_RUNTIME_MS,
    90 * 1000
  );
  const remoteOkCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_REMOTEOK_CADENCE_MINUTES,
    60
  );
  const remoteOkRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_REMOTEOK_MAX_RUNTIME_MS,
    90 * 1000
  );
  const wwrCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_WWR_CADENCE_MINUTES,
    60
  );
  const wwrRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_WWR_MAX_RUNTIME_MS,
    90 * 1000
  );
  const himalayasCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_HIMALAYAS_CADENCE_MINUTES,
    45
  );
  const himalayasRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_HIMALAYAS_MAX_RUNTIME_MS,
    3 * 60 * 1000
  );
  const himalayasLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_HIMALAYAS_LIMIT,
    2_000
  );
  const jobicyCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOBICY_CADENCE_MINUTES,
    120
  );
  const jobicyRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOBICY_MAX_RUNTIME_MS,
    90 * 1000
  );

  const usaJobsKeywords = (
    process.env.BULK_RECOVERY_USAJOBS_KEYWORDS ??
    "Information Technology,Software Engineer,Data Scientist,Cybersecurity,Financial Analyst,Accountant"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const hasUsaJobsCredentials = Boolean(
    process.env.USAJOBS_API_KEY?.trim() && process.env.USAJOBS_EMAIL?.trim()
  );

  const entries: Entry[] = [
    {
      key: "adzuna:us:focused",
      connector: createAdzunaConnector({ country: "us", profile: "focused" }),
      cadenceMinutes: adzunaPrimaryCadence,
      maxRuntimeMs: adzunaRuntimeMs,
      limit: adzunaLimit,
    },
    {
      key: "adzuna:ca:focused",
      connector: createAdzunaConnector({ country: "ca", profile: "focused" }),
      cadenceMinutes: adzunaPrimaryCadence,
      maxRuntimeMs: adzunaRuntimeMs,
      limit: adzunaLimit,
    },
    {
      key: "adzuna:us:techcore",
      connector: createAdzunaConnector({ country: "us", profile: "techcore" }),
      cadenceMinutes: adzunaSecondaryCadence,
      maxRuntimeMs: adzunaSecondaryRuntimeMs,
      limit: adzunaSecondaryLimit,
    },
    {
      key: "adzuna:ca:techcore",
      connector: createAdzunaConnector({ country: "ca", profile: "techcore" }),
      cadenceMinutes: adzunaSecondaryCadence,
      maxRuntimeMs: adzunaSecondaryRuntimeMs,
      limit: adzunaSecondaryLimit,
    },
    {
      key: "adzuna:us:specialist",
      connector: createAdzunaConnector({ country: "us", profile: "specialist" }),
      cadenceMinutes: adzunaSecondaryCadence,
      maxRuntimeMs: adzunaSecondaryRuntimeMs,
      limit: adzunaSecondaryLimit,
    },
    {
      key: "adzuna:ca:specialist",
      connector: createAdzunaConnector({ country: "ca", profile: "specialist" }),
      cadenceMinutes: adzunaSecondaryCadence,
      maxRuntimeMs: adzunaSecondaryRuntimeMs,
      limit: adzunaSecondaryLimit,
    },
    {
      key: "adzuna:us:broad",
      connector: createAdzunaConnector({ country: "us", profile: "broad" }),
      cadenceMinutes: adzunaBroadCadence,
      maxRuntimeMs: adzunaBroadRuntimeMs,
      limit: adzunaBroadLimit,
    },
    {
      key: "adzuna:ca:broad",
      connector: createAdzunaConnector({ country: "ca", profile: "broad" }),
      cadenceMinutes: adzunaBroadCadence,
      maxRuntimeMs: adzunaBroadRuntimeMs,
      limit: adzunaBroadLimit,
    },
    {
      key: "himalayas:na_scale",
      connector: createHimalayasConnector({ profile: "na_scale" }),
      cadenceMinutes: himalayasCadence,
      maxRuntimeMs: himalayasRuntimeMs,
      limit: himalayasLimit,
    },
    {
      key: "themuse:feed",
      connector: createMuseConnector(),
      cadenceMinutes: museCadence,
      maxRuntimeMs: museRuntimeMs,
    },
    {
      key: "jobicy:feed",
      connector: createJobicyConnector(),
      cadenceMinutes: jobicyCadence,
      maxRuntimeMs: jobicyRuntimeMs,
    },
    {
      key: "remotive:feed",
      connector: createRemotiveConnector(),
      cadenceMinutes: remotiveCadence,
      maxRuntimeMs: remotiveRuntimeMs,
    },
    {
      key: "remoteok:feed",
      connector: createRemoteOkConnector(),
      cadenceMinutes: remoteOkCadence,
      maxRuntimeMs: remoteOkRuntimeMs,
    },
    {
      key: "weworkremotely:feed",
      connector: createWeWorkRemotelyConnector(),
      cadenceMinutes: wwrCadence,
      maxRuntimeMs: wwrRuntimeMs,
    },
    {
      key: "jobbank:latest",
      connector: createJobBankConnector(),
      cadenceMinutes: jobBankCadence,
      maxRuntimeMs: jobBankRuntimeMs,
    },
  ];

  if (hasUsaJobsCredentials) {
    entries.splice(
      entries.length - 1,
      0,
      {
        key: "usajobs:all",
        connector: createUsaJobsConnector(),
        cadenceMinutes: usaJobsCadence,
        maxRuntimeMs: usaJobsRuntimeMs,
      },
      ...usaJobsKeywords.map((keyword) => ({
        key: `usajobs:${keyword}`,
        connector: createUsaJobsConnector({ keyword }),
        cadenceMinutes: usaJobsCadence,
        maxRuntimeMs: usaJobsRuntimeMs,
      }))
    );
  }

  return entries;
}

async function getLastSuccessAgeMinutes(connectorKey: string, now: Date) {
  const lastRun = await prisma.ingestionRun.findFirst({
    where: {
      connectorKey,
      status: "SUCCESS",
    },
    orderBy: {
      startedAt: "desc",
    },
    select: {
      startedAt: true,
    },
  });

  if (!lastRun) return Number.POSITIVE_INFINITY;
  return (now.getTime() - lastRun.startedAt.getTime()) / 60_000;
}

async function runCycle(entries: Entry[]) {
  const now = new Date();
  const results: Array<{
    key: string;
    skipped?: string;
    status?: string;
    live?: number;
    accepted?: number;
    durationSec?: number;
    error?: string;
  }> = [];

  for (const entry of entries) {
    const cadenceKey = entry.cadenceKey ?? entry.connector.key;
    const ageMinutes = await getLastSuccessAgeMinutes(cadenceKey, now);
    if (ageMinutes < entry.cadenceMinutes) {
      results.push({
        key: entry.key,
        skipped: `not due (age=${ageMinutes.toFixed(0)}m < cadence=${entry.cadenceMinutes}m)`,
      });
      continue;
    }

    const startedAt = Date.now();
    try {
      const summary = await ingestConnector(entry.connector, {
        now: new Date(),
        triggerLabel: "bulk-recovery-loop",
        maxRuntimeMs: entry.maxRuntimeMs,
        limit: entry.limit,
        allowOverlappingRuns: false,
        runMode: "SCHEDULED",
      });
      results.push({
        key: entry.key,
        status: summary.status,
        live: summary.liveCount ?? 0,
        accepted: summary.acceptedCount ?? 0,
        durationSec: (Date.now() - startedAt) / 1000,
      });
    } catch (error) {
      results.push({
        key: entry.key,
        durationSec: (Date.now() - startedAt) / 1000,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    startedAt: now.toISOString(),
    results,
  };
}

function formatCycleSummary(
  cycleNumber: number,
  cycle: Awaited<ReturnType<typeof runCycle>>
) {
  const lines = [
    `[bulk-recovery] ─── Cycle #${cycleNumber} at ${cycle.startedAt} ───`,
  ];

  let liveTotal = 0;
  let acceptedTotal = 0;
  let failed = 0;
  let skipped = 0;

  for (const result of cycle.results) {
    if (result.skipped) {
      skipped += 1;
      lines.push(`  ⏭  ${result.key.padEnd(28)} ${result.skipped}`);
      continue;
    }

    if (result.error) {
      failed += 1;
      lines.push(
        `  ✗  ${result.key.padEnd(28)} FAILED in ${result.durationSec?.toFixed(1)}s — ${result.error}`
      );
      continue;
    }

    liveTotal += result.live ?? 0;
    acceptedTotal += result.accepted ?? 0;
    lines.push(
      `  ✓  ${result.key.padEnd(28)} ${result.status} in ${result.durationSec?.toFixed(1)}s — accepted=${result.accepted} live=${result.live}`
    );
  }

  lines.push(
    `[bulk-recovery] Cycle summary: live=${liveTotal}, accepted=${acceptedTotal}, failed=${failed}, skipped=${skipped}`
  );

  return lines.join("\n");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = getBulkRecoveryEntries().filter((entry) =>
    args.keyFilters.length === 0 ? true : args.keyFilters.includes(entry.key)
  );
  let running = true;
  let cycleNumber = 0;

  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  console.log(
    `[bulk-recovery] Starting. interval=${args.intervalMinutes}m catchup=${args.catchupSeconds}s once=${args.once} entries=${entries.length} filters=${
      args.keyFilters.length > 0 ? args.keyFilters.join(",") : "all"
    }`
  );

  while (running) {
    cycleNumber += 1;
    let cycle: Awaited<ReturnType<typeof runCycle>> | null = null;
    try {
      cycle = await runCycle(entries);
      console.log(formatCycleSummary(cycleNumber, cycle));
    } catch (error) {
      console.error(
        `[bulk-recovery] cycle=${cycleNumber} failed:`,
        error instanceof Error ? error.message : error
      );
    }

    if (args.once || !running) break;

    const hadActiveWork = cycle?.results.some(
      (result) => !result.skipped
    ) ?? false;

    await sleep(
      hadActiveWork ? args.catchupSeconds * 1_000 : args.intervalMinutes * 60_000
    );
  }

  await prisma.$disconnect().catch(() => undefined);
}

void main();
