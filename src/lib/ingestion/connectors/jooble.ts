/**
 * Jooble public job search API connector.
 *
 * Official docs:
 *   POST https://jooble.org/api/{apiKey}
 *
 * The API is query-driven rather than a full market dump, so this connector
 * fans out across configurable keyword/location searches and checkpoints across
 * that frontier over multiple runs.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import {
  readCsvEnv,
  readPositiveIntEnv,
} from "@/lib/ingestion/source-family-config";
import {
  sleepWithAbort,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const JOOBLE_API_BASE = "https://jooble.org/api";
const JOOBLE_DEFAULT_RATE_DELAY_MS = 750;
const JOOBLE_DEFAULT_RESULTS_PER_PAGE = 75;
const JOOBLE_DEFAULT_MAX_PAGES = 4;
const JOOBLE_DEFAULT_SEARCHES_PER_RUN = 6;

const DEFAULT_JOOBLE_KEYWORDS = [
  "software engineer",
  "data engineer",
  "data scientist",
  "product manager",
  "business analyst",
  "financial analyst",
  "accountant",
  "cybersecurity",
  "devops",
  "operations manager",
];

const DEFAULT_JOOBLE_LOCATIONS = [
  "Remote",
  "United States",
  "Canada",
];

type JoobleJob = {
  id?: number | string;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
};

type JoobleResponse = {
  totalCount?: number;
  jobs?: JoobleJob[];
};

type JoobleCheckpoint = {
  searchIndex: number;
  page: number;
};

type JoobleSearchSpec = {
  keyword: string;
  location: string | null;
};

export function createJoobleConnector(): SourceConnector {
  const apiKey = process.env.JOOBLE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      "Jooble connector requires JOOBLE_API_KEY."
    );
  }

  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "jooble:feed",
    sourceName: "Jooble:feed",
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = JSON.stringify({
        limit: options.limit ?? "all",
        checkpoint: options.checkpoint ?? null,
      });
      const existing = fetchCache.get(cacheKey);
      if (existing) {
        return existing;
      }

      const request = fetchJoobleJobs({
        apiKey,
        now: options.now,
        limit: options.limit,
        signal: options.signal,
        log: options.log,
        checkpoint: parseCheckpoint(options.checkpoint),
        onCheckpoint: options.onCheckpoint,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchJoobleJobs(input: {
  apiKey: string;
  now: Date;
  limit?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  checkpoint?: JoobleCheckpoint | null;
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
}): Promise<SourceConnectorFetchResult> {
  const searches = buildSearchSpecs();
  const resultsPerPage = readPositiveIntEnv(
    "JOOBLE_RESULTS_PER_PAGE",
    JOOBLE_DEFAULT_RESULTS_PER_PAGE
  );
  const maxPages = readPositiveIntEnv(
    "JOOBLE_MAX_PAGES",
    JOOBLE_DEFAULT_MAX_PAGES
  );
  const searchesPerRun = readPositiveIntEnv(
    "JOOBLE_SEARCHES_PER_RUN",
    JOOBLE_DEFAULT_SEARCHES_PER_RUN
  );
  const rateDelayMs = readPositiveIntEnv(
    "JOOBLE_RATE_DELAY_MS",
    JOOBLE_DEFAULT_RATE_DELAY_MS
  );
  const seenIds = new Set<string>();
  const jobs: SourceConnectorJob[] = [];
  const searchSummaries: Array<Record<string, Prisma.InputJsonValue | null>> = [];
  const log = input.log ?? console.log;
  let nextCheckpoint: JoobleCheckpoint | null = input.checkpoint ?? {
    searchIndex: 0,
    page: 1,
  };
  let searchesProcessed = 0;

  for (
    let searchIndex = input.checkpoint?.searchIndex ?? 0;
    searchIndex < searches.length;
    searchIndex += 1
  ) {
    if (searchesPerRun > 0 && searchesProcessed >= searchesPerRun) {
      break;
    }

    const search = searches[searchIndex]!;
    const startPage =
      searchIndex === (input.checkpoint?.searchIndex ?? 0)
        ? input.checkpoint?.page ?? 1
        : 1;
    let pagesFetchedForSearch = 0;
    let fetchedForSearch = 0;

    for (
      let page = startPage;
      page <= maxPages && pagesFetchedForSearch < maxPages;
      page += 1
    ) {
      throwIfAborted(input.signal);
      if (typeof input.limit === "number" && jobs.length >= input.limit) {
        break;
      }

      const payload = await fetchJoobleSearchPage({
        apiKey: input.apiKey,
        keyword: search.keyword,
        location: search.location,
        page,
        resultsPerPage,
        signal: input.signal,
      });
      const entries = payload.jobs ?? [];

      if (entries.length === 0) {
        nextCheckpoint = {
          searchIndex: searchIndex + 1,
          page: 1,
        };
        await input.onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
        break;
      }

      for (const entry of entries) {
        const sourceId = buildSourceId(entry);
        if (!sourceId || seenIds.has(sourceId)) {
          continue;
        }
        seenIds.add(sourceId);
        jobs.push(mapJoobleJob(entry, input.now, search));
        fetchedForSearch += 1;
      }

      pagesFetchedForSearch += 1;
      nextCheckpoint = {
        searchIndex,
        page: page + 1,
      };
      await input.onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);

      if (entries.length < resultsPerPage) {
        nextCheckpoint = {
          searchIndex: searchIndex + 1,
          page: 1,
        };
        await input.onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
        break;
      }

      await sleepWithAbort(rateDelayMs, input.signal);
    }

    searchSummaries.push({
      keyword: search.keyword,
      location: search.location,
      fetchedCount: fetchedForSearch,
      pagesFetched: pagesFetchedForSearch,
    });
    searchesProcessed += 1;

    if (pagesFetchedForSearch === 0) {
      log(
        `[jooble] search "${search.keyword}" @ "${search.location ?? "any"}" yielded no jobs`
      );
    }

    if (typeof input.limit === "number" && jobs.length >= input.limit) {
      break;
    }
  }

  const finalJobs =
    typeof input.limit === "number" ? jobs.slice(0, input.limit) : jobs;

  return {
    jobs: finalJobs,
    checkpoint: nextCheckpoint as Prisma.InputJsonValue | null,
    exhausted:
      nextCheckpoint == null ||
      nextCheckpoint.searchIndex >= searches.length,
    metadata: {
      apiBaseUrl: JOOBLE_API_BASE,
      fetchedAt: input.now.toISOString(),
      searchCount: searches.length,
      searchesProcessed,
      searchesPerRun,
      resultsPerPage,
      maxPages,
      rateDelayMs,
      searchSummaries,
      attribution: {
        required: false,
        note: "Provider-specific attribution should still be preserved where Jooble terms require it.",
      },
    } as Prisma.InputJsonValue,
  };
}

async function fetchJoobleSearchPage(input: {
  apiKey: string;
  keyword: string;
  location: string | null;
  page: number;
  resultsPerPage: number;
  signal?: AbortSignal;
}) {
  const response = await fetch(`${JOOBLE_API_BASE}/${input.apiKey}`, {
    method: "POST",
    signal: input.signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-jooble/1.0)",
    },
    body: JSON.stringify({
      keywords: input.keyword,
      location: input.location ?? undefined,
      page: String(input.page),
      ResultOnPage: String(input.resultsPerPage),
      SearchMode: "0",
      companysearch: "false",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Jooble API fetch failed: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as JoobleResponse;
}

function parseCheckpoint(value: Prisma.InputJsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const checkpoint = value as Prisma.InputJsonObject;
  const rawSearchIndex = checkpoint.searchIndex;
  const rawPage = checkpoint.page;
  const searchIndex =
    typeof rawSearchIndex === "number" ? Math.max(0, Math.round(rawSearchIndex)) : 0;
  const page = typeof rawPage === "number" ? Math.max(1, Math.round(rawPage)) : 1;

  return {
    searchIndex,
    page,
  } satisfies JoobleCheckpoint;
}

function buildSearchSpecs() {
  const rawKeywords = readCsvEnv("JOOBLE_KEYWORDS", DEFAULT_JOOBLE_KEYWORDS);
  const rawLocations = readCsvEnv("JOOBLE_LOCATIONS", DEFAULT_JOOBLE_LOCATIONS);
  const keywords =
    rawKeywords.length === 1 && rawKeywords[0] === "ALL"
      ? [""]
      : rawKeywords;
  const locations =
    rawLocations.length === 1 && rawLocations[0] === "ALL"
      ? [null]
      : rawLocations.map((location) => location.trim()).filter(Boolean);

  const specs: JoobleSearchSpec[] = [];

  for (const location of locations.length > 0 ? locations : [null]) {
    for (const keyword of keywords.length > 0 ? keywords : [""]) {
      specs.push({
        keyword: keyword.trim(),
        location: location && location.trim().length > 0 ? location.trim() : null,
      });
    }
  }

  return specs.filter((spec) => spec.keyword.length > 0 || spec.location != null);
}

function buildSourceId(job: JoobleJob) {
  if (job.id != null) {
    return `jooble:${String(job.id).trim()}`;
  }

  const link = job.link?.trim();
  if (link && link.length > 0) {
    return `jooble:${link}`;
  }

  const fallbackParts = [
    job.title?.trim().toLowerCase() ?? "",
    job.company?.trim().toLowerCase() ?? "",
    job.location?.trim().toLowerCase() ?? "",
    job.updated?.trim() ?? "",
  ].filter(Boolean);
  return fallbackParts.length > 0
    ? `jooble:${fallbackParts.join("|")}`
    : null;
}

function mapJoobleJob(
  job: JoobleJob,
  now: Date,
  search: JoobleSearchSpec
): SourceConnectorJob {
  const salary = parseSalaryRange(job.salary);
  const link = job.link?.trim() ?? "";
  const location = normalizeLocation(job.location, search.location);
  const description = (job.snippet ?? "").trim();
  const workMode = inferWorkMode(job, location);

  return {
    sourceId:
      buildSourceId(job) ??
      `jooble:${search.keyword.trim().toLowerCase() || "any"}|${
        search.location?.trim().toLowerCase() || "anywhere"
      }`,
    sourceUrl: link || null,
    title: (job.title ?? "").trim() || "Untitled Position",
    company: (job.company ?? "").trim() || "Unknown Company",
    location,
    description,
    applyUrl: link,
    postedAt: parseDate(job.updated) ?? now,
    deadline: null,
    employmentType: inferEmploymentType(job.type),
    workMode,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    metadata: {
      source: "jooble",
      providerSource: job.source ?? null,
      providerType: job.type ?? null,
      searchKeyword: search.keyword,
      searchLocation: search.location,
      rawLocation: job.location ?? null,
      rawSalary: job.salary ?? null,
    } as Prisma.InputJsonValue,
  };
}

function normalizeLocation(
  rawLocation: string | undefined,
  fallbackLocation: string | null
) {
  const raw = rawLocation?.trim();
  if (raw && raw.length > 0) {
    if (/remote|work from home|anywhere/i.test(raw)) {
      if (/canada/i.test(raw)) return "Remote (Canada)";
      if (/united states|usa|u\.s\./i.test(raw)) return "Remote (US Only)";
      if (/north america/i.test(raw)) return "Remote (North America)";
      return "Remote";
    }

    return raw;
  }

  if (fallbackLocation) {
    if (/remote/i.test(fallbackLocation)) return "Remote";
    return fallbackLocation;
  }

  return "Unknown";
}

function inferWorkMode(job: JoobleJob, location: string): WorkMode | null {
  const joined = [job.title, job.snippet, job.location, location]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\bremote|work from home|anywhere\b/.test(joined)) return "REMOTE" as WorkMode;
  if (/\bhybrid\b/.test(joined)) return "HYBRID" as WorkMode;
  if (/\bon[- ]?site\b/.test(joined)) return "ONSITE" as WorkMode;
  return null;
}

function inferEmploymentType(rawType: string | undefined): EmploymentType | null {
  const value = rawType?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("contract") || value.includes("freelance")) return "CONTRACT";
  if (value.includes("part")) return "PART_TIME";
  if (value.includes("intern")) return "INTERNSHIP";
  if (value.includes("temp")) return "CONTRACT";
  if (value.includes("full")) return "FULL_TIME";
  return null;
}

function parseSalaryRange(rawValue: string | undefined) {
  if (!rawValue || !rawValue.trim()) {
    return {
      min: null,
      max: null,
      currency: null,
    };
  }

  const currency =
    /\bCAD\b|C\$/i.test(rawValue)
      ? "CAD"
      : /\bEUR\b|€/i.test(rawValue)
        ? "EUR"
        : "USD";
  const values = [...rawValue.matchAll(/\$?C?\$?€?\s*(\d+(?:\.\d+)?)\s*([kK])?/g)]
    .map((match) => {
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return null;
      return match[2] ? base * 1_000 : base;
    })
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (values.length === 0) {
    return {
      min: null,
      max: null,
      currency: null,
    };
  }

  return {
    min: values[0] ?? null,
    max: values[1] ?? values[0] ?? null,
    currency,
  };
}

function parseDate(value: string | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
