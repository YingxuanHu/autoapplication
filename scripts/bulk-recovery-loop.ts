import "dotenv/config";

import process from "node:process";
import { prisma } from "@/lib/db";
import { ingestConnector } from "@/lib/ingestion/pipeline";
import {
  getBulkRecoveryNextEligibleAt,
  getBulkRecoverySleepMs,
  type BulkRecoveryAttempt,
  type BulkRecoveryCycleResult,
} from "@/lib/ingestion/bulk-recovery-schedule";
import { installProcessDiagnostics } from "./_process-diagnostics";

const bulkRecoveryProcessName = (() => {
  const keys = process.env.BULK_RECOVERY_LOOP_KEYS?.trim();
  if (!keys) return "bulk-recovery-loop";
  const slug = keys.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  return `bulk-recovery-loop-${slug}`;
})();
installProcessDiagnostics({ processName: bulkRecoveryProcessName });
import {
  createAdzunaConnector,
  createBreezyHrConnector,
  createBuiltInConnector,
  createHireologyConnector,
  createHiringCafeConnector,
  createHimalayasConnector,
  createHrSmartConnector,
  createJobBankConnector,
  createJobBankLiveConnector,
  createJobicyConnector,
  createJoobleConnector,
  createJSearchConnector,
  createMuseConnector,
  createOracleCloudConnector,
  createParadoxConnector,
  createRemoteOkConnector,
  createRemotiveConnector,
  createUsaJobsConnector,
  createWeWorkRemotelyConnector,
  createWorkAtAStartupConnector,
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

function parseCsv(value: string | undefined, fallback: string[]) {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function normalizeKeySegment(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "feed";
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
  const adzunaGeneralCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_GENERAL_CADENCE_MINUTES,
    180
  );
  const adzunaGeneralRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_GENERAL_MAX_RUNTIME_MS,
    180_000
  );
  const adzunaGeneralLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_ADZUNA_GENERAL_LIMIT,
    120
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
  // BuiltIn: HTML-scrape + per-job JSON-LD parse. 8 listing pages × ~17 jobs ×
  // ~0.6s per fetch (with rate delay) ≈ 90s, plus per-job description fetches
  // run sequentially. Default 6-minute budget gives headroom; 60-min cadence
  // gives ~8 cycles/day per lane.
  const builtinCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_BUILTIN_CADENCE_MINUTES,
    60
  );
  const builtinRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_BUILTIN_MAX_RUNTIME_MS,
    6 * 60 * 1000
  );
  const builtinLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_BUILTIN_LIMIT,
    140
  );
  // Hiring.cafe: single fetch returns ~145 structured hits via __NEXT_DATA__.
  // Fast (one request, parsed JSON, no per-job page fetches) — 30-min cadence
  // gives 8x daily refresh. 90s budget is generous for the single request.
  const hiringCafeCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_HIRINGCAFE_CADENCE_MINUTES,
    30
  );
  const hiringCafeRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_HIRINGCAFE_MAX_RUNTIME_MS,
    90 * 1000
  );
  const joobleCadence = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOOBLE_CADENCE_MINUTES,
    60
  );
  const joobleRuntimeMs = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOOBLE_MAX_RUNTIME_MS,
    6 * 60 * 1000
  );
  const joobleLimit = parsePositiveInteger(
    process.env.BULK_RECOVERY_JOOBLE_LIMIT,
    1_000
  );
  const joobleProfiles = parseCsv(
    process.env.BULK_RECOVERY_JOOBLE_PROFILES,
    ["feed"]
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
    // General white-collar profiles intentionally exclude the focused
    // technical/finance categories, so they expand coverage rather than
    // competing with the higher-frequency focused lane.
    ...["us", "ca"].flatMap((country) => [
      {
        key: `adzuna:${country}:general-people`,
        connector: createAdzunaConnector({
          country,
          profile: "general-people",
        }),
        cadenceMinutes: adzunaGeneralCadence,
        maxRuntimeMs: adzunaGeneralRuntimeMs,
        limit: adzunaGeneralLimit,
      },
      {
        key: `adzuna:${country}:general-commercial`,
        connector: createAdzunaConnector({
          country,
          profile: "general-commercial",
        }),
        cadenceMinutes: adzunaGeneralCadence,
        maxRuntimeMs: adzunaGeneralRuntimeMs,
        limit: adzunaGeneralLimit,
      },
    ]),
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
      key: "builtin:feed",
      connector: createBuiltInConnector(),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    // BuiltIn city subsites — each paginates its own job set, so adding
    // these effectively 5-9× the connector's per-cycle throughput vs.
    // running just the national board. They use the same cadence /
    // runtime budget so they share the adaptive scheduler treatment.
    {
      key: "builtin:nyc",
      connector: createBuiltInConnector({ profile: "nyc" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:la",
      connector: createBuiltInConnector({ profile: "la" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:boston",
      connector: createBuiltInConnector({ profile: "boston" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:chicago",
      connector: createBuiltInConnector({ profile: "chicago" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:austin",
      connector: createBuiltInConnector({ profile: "austin" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:seattle",
      connector: createBuiltInConnector({ profile: "seattle" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:colorado",
      connector: createBuiltInConnector({ profile: "colorado" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "builtin:sf",
      connector: createBuiltInConnector({ profile: "sf" }),
      cadenceMinutes: builtinCadence,
      maxRuntimeMs: builtinRuntimeMs,
      limit: builtinLimit,
    },
    {
      key: "hiringcafe:feed",
      connector: createHiringCafeConnector(),
      cadenceMinutes: hiringCafeCadence,
      maxRuntimeMs: hiringCafeRuntimeMs,
    },
    ...((process.env.JOOBLE_API_KEY ?? "").trim()
      ? joobleProfiles.map((profile) => ({
          key: `jooble:${normalizeKeySegment(profile)}`,
          connector: createJoobleConnector({ profile }),
          cadenceMinutes: joobleCadence,
          maxRuntimeMs: joobleRuntimeMs,
          limit: joobleLimit,
        }))
      : []),
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

  // ── JobBank Live (fresher than monthly CSV; rotates queries via checkpoint) ─
  entries.push({
    key: "jobbank-live:feed",
    connector: createJobBankLiveConnector(),
    cadenceMinutes: parsePositiveInteger(
      process.env.JOBBANK_LIVE_SCHEDULE_MINUTES,
      60
    ),
    maxRuntimeMs: parsePositiveInteger(
      process.env.JOBBANK_LIVE_MAX_RUNTIME_MS,
      240_000
    ),
  });

  // ── Y Combinator "Work at a Startup" (no auth, single endpoint) ─────────
  entries.push({
    key: "workatastartup:feed",
    connector: createWorkAtAStartupConnector(),
    cadenceMinutes: parsePositiveInteger(
      process.env.WORKATASTARTUP_SCHEDULE_MINUTES,
      720
    ),
    maxRuntimeMs: parsePositiveInteger(
      process.env.WORKATASTARTUP_MAX_RUNTIME_MS,
      300_000
    ),
  });

  // ── JSearch — RapidAPI free tier (200 reqs/month). Daily cadence + 1
  //    req/run keeps us comfortably under the cap.
  if ((process.env.JSEARCH_API_KEY ?? "").trim()) {
    entries.push({
      key: "jsearch:feed",
      connector: createJSearchConnector(),
      cadenceMinutes: parsePositiveInteger(
        process.env.JSEARCH_SCHEDULE_MINUTES,
        1440
      ),
      maxRuntimeMs: parsePositiveInteger(
        process.env.JSEARCH_MAX_RUNTIME_MS,
        180_000
      ),
    });
  }

  // ── Oracle Cloud HCM — multiple tenants via ORACLECLOUD_TENANTS env ─────
  const oracleTenantsRaw =
    process.env.ORACLECLOUD_TENANTS?.trim() ??
    // Defaults seeded from hiringcafe production data
    "ejov.fa.ca2.oraclecloud.com|CX,emgi.fa.ca3.oraclecloud.com|CX,hcrw.fa.us2.oraclecloud.com|CX,hcpd.fa.ca2.oraclecloud.com|CX,iaemup.fa.ocs.oraclecloud.com|CX,fa-exhh-saasfaprod1.fa.ocs.oraclecloud.com|CX,fa-evcg-saasfaprod1.fa.ocs.oraclecloud.com|CX,fa-evlf-saasfaprod1.fa.ocs.oraclecloud.com|CX";
  for (const token of oracleTenantsRaw.split(",").map((t) => t.trim()).filter(Boolean)) {
    const [tenant, site] = token.split("|");
    if (!tenant || !/\.oraclecloud\.com$/i.test(tenant)) continue;
    try {
      const connector = createOracleCloudConnector({
        tenant,
        site: site?.trim() || "CX",
      });
      entries.push({
        key: connector.key,
        connector,
        cadenceMinutes: parsePositiveInteger(
          process.env.ORACLECLOUD_SCHEDULE_MINUTES,
          720
        ),
        maxRuntimeMs: parsePositiveInteger(
          process.env.ORACLECLOUD_MAX_RUNTIME_MS,
          240_000
        ),
      });
    } catch {
      // Invalid tenant — skip silently
    }
  }

  // ── BreezyHR — per-company JSON feeds ───────────────────────────────────
  const breezyCompaniesRaw = process.env.BREEZYHR_COMPANIES?.trim();
  if (breezyCompaniesRaw) {
    for (const company of breezyCompaniesRaw.split(",").map((t) => t.trim()).filter(Boolean)) {
      try {
        const connector = createBreezyHrConnector({ company });
        entries.push({
          key: connector.key,
          connector,
          cadenceMinutes: parsePositiveInteger(
            process.env.BREEZYHR_SCHEDULE_MINUTES,
            720
          ),
          maxRuntimeMs: parsePositiveInteger(
            process.env.BREEZYHR_MAX_RUNTIME_MS,
            120_000
          ),
        });
      } catch {
        // skip invalid
      }
    }
  }

  // ── Hireology — per-tenant career pages with JSON-LD ────────────────────
  const hireologySlugsRaw = process.env.HIREOLOGY_SLUGS?.trim();
  if (hireologySlugsRaw) {
    for (const slug of hireologySlugsRaw.split(",").map((t) => t.trim()).filter(Boolean)) {
      try {
        const connector = createHireologyConnector({ slug });
        entries.push({
          key: connector.key,
          connector,
          cadenceMinutes: parsePositiveInteger(
            process.env.HIREOLOGY_SCHEDULE_MINUTES,
            720
          ),
          maxRuntimeMs: parsePositiveInteger(
            process.env.HIREOLOGY_MAX_RUNTIME_MS,
            120_000
          ),
        });
      } catch {
        // skip invalid
      }
    }
  }

  // ── Paradox / HRSmart — tenant|boardUrl pairs ───────────────────────────
  function parseTenantBoardUrlPairs(raw: string) {
    return raw
      .split(",")
      .map((entry) => {
        const [tenant, boardUrl] = entry.split("|");
        if (!tenant || !boardUrl) return null;
        return { tenant: tenant.trim(), boardUrl: boardUrl.trim() };
      })
      .filter(
        (value): value is { tenant: string; boardUrl: string } =>
          value !== null &&
          value.tenant.length > 0 &&
          /^https?:\/\//.test(value.boardUrl)
      );
  }
  const paradoxRaw = process.env.PARADOX_TENANTS?.trim();
  if (paradoxRaw) {
    for (const { tenant, boardUrl } of parseTenantBoardUrlPairs(paradoxRaw)) {
      try {
        const connector = createParadoxConnector({ tenant, boardUrl });
        entries.push({
          key: connector.key,
          connector,
          cadenceMinutes: parsePositiveInteger(
            process.env.PARADOX_SCHEDULE_MINUTES,
            720
          ),
          maxRuntimeMs: parsePositiveInteger(
            process.env.PARADOX_MAX_RUNTIME_MS,
            120_000
          ),
        });
      } catch {
        // skip invalid
      }
    }
  }
  const hrsmartRaw = process.env.HRSMART_TENANTS?.trim();
  if (hrsmartRaw) {
    for (const { tenant, boardUrl } of parseTenantBoardUrlPairs(hrsmartRaw)) {
      try {
        const connector = createHrSmartConnector({ tenant, boardUrl });
        entries.push({
          key: connector.key,
          connector,
          cadenceMinutes: parsePositiveInteger(
            process.env.HRSMART_SCHEDULE_MINUTES,
            720
          ),
          maxRuntimeMs: parsePositiveInteger(
            process.env.HRSMART_MAX_RUNTIME_MS,
            120_000
          ),
        });
      } catch {
        // skip invalid
      }
    }
  }

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

async function getRecentAttempts(connectorKey: string) {
  const attempts = await prisma.ingestionRun.findMany({
    where: {
      connectorKey,
      status: { in: ["SUCCESS", "FAILED"] },
    },
    orderBy: {
      startedAt: "desc",
    },
    take: 8,
    select: {
      startedAt: true,
      status: true,
    },
  });
  return attempts.map(
    (attempt): BulkRecoveryAttempt => ({
      startedAt: attempt.startedAt,
      status: attempt.status === "SUCCESS" ? "SUCCESS" : "FAILED",
    })
  );
}

async function runCycle(entries: Entry[]) {
  const now = new Date();
  const results: Array<BulkRecoveryCycleResult & {
    key: string;
    status?: string;
    live?: number;
    accepted?: number;
    durationSec?: number;
    error?: string;
  }> = [];

  for (const entry of entries) {
    const cadenceKey = entry.cadenceKey ?? entry.connector.key;
    const recentAttempts = await getRecentAttempts(cadenceKey);
    const nextEligibleAt = getBulkRecoveryNextEligibleAt({
      now,
      cadenceMinutes: entry.cadenceMinutes,
      recentAttempts,
    });
    if (nextEligibleAt && now < nextEligibleAt) {
      const latestAttempt = recentAttempts[0]!;
      const failureStreak = recentAttempts.findIndex(
        (attempt) => attempt.status === "SUCCESS"
      );
      const isFailureBackoff = latestAttempt.status === "FAILED";
      results.push({
        key: entry.key,
        skipped: isFailureBackoff
          ? `failure backoff (streak=${failureStreak === -1 ? recentAttempts.length : failureStreak})`
          : "not due",
        nextDueInMs: Math.max(0, nextEligibleAt.getTime() - now.getTime()),
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

    await sleep(
      getBulkRecoverySleepMs({
        results: cycle?.results,
        catchupSeconds: args.catchupSeconds,
        fallbackIntervalMinutes: args.intervalMinutes,
      })
    );
  }

  await prisma.$disconnect().catch(() => undefined);
}

void main();
