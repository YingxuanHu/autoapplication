/**
 * Adzuna job search API connector.
 *
 * Adzuna aggregates jobs from thousands of sources across 12+ countries.
 * API access uses app_id + app_key.
 *
 * Volume: 100K-500K+ North America jobs at any time.
 * Canada: Full Canada support (country code: "ca").
 * US: Full US support (country code: "us").
 *
 * Source token format: `{country}` — e.g. "ca", "us"
 * Environment: ADZUNA_APP_ID, ADZUNA_APP_KEY
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import { sleepWithAbort, throwIfAborted } from "@/lib/ingestion/runtime-control";

const ADZUNA_API_BASE = "https://api.adzuna.com/v1/api/jobs";
const ADZUNA_PAGE_SIZE = 50; // max allowed by API
// Adzuna uses checkpointing (see AdzunaCheckpoint) — each run advances pages until
// this cap is hit, then starts over on the next refresh. Raising the cap lets us
// pull deeper into the result set across multiple cycles. 200 pages × 50 = 10,000
// jobs per category; with 5 categories per profile and multiple profiles this gives
// meaningful headroom without changing the per-run runtime budget.
const ADZUNA_MAX_PAGES = 200; // safety limit per category (200 pages × 50 = 10,000 per category)
const ADZUNA_RATE_DELAY_MS = 3500; // keep request rate conservative
const ADZUNA_RATE_LIMIT_MAX_ATTEMPTS = 2;
const ADZUNA_RATE_LIMIT_BACKOFF_MS = 20_000;

type AdzunaConnectorOptions = {
  country?: string;
  categories?: string[];
  appId?: string;
  appKey?: string;
  profile?: string;
  maxPages?: number;
  maxDaysOld?: number;
  categoryStrategy?: "SEQUENTIAL" | "ROUND_ROBIN";
};

type AdzunaJob = {
  id?: string;
  title?: string;
  description?: string;
  company?: { display_name?: string };
  location?: {
    display_name?: string;
    area?: string[];
  };
  redirect_url?: string;
  created?: string;
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
  contract_time?: string;
  contract_type?: string;
  category?: { tag?: string; label?: string };
  latitude?: number;
  longitude?: number;
};

type AdzunaSearchResponse = {
  results?: AdzunaJob[];
  count?: number;
  mean?: number;
  __CLASS__?: string;
};

type AdzunaCheckpoint = {
  categoryStates: Array<{
    category: string;
    page: number;
    exhausted: boolean;
  }>;
};

const FOCUSED_CATEGORIES = [
  "it-jobs",
  "engineering-jobs",
  "scientific-qa-jobs",
  "consultancy-jobs",
  "accounting-finance-jobs",
];

const BROAD_CATEGORIES = [
  ...FOCUSED_CATEGORIES,
  "graduate-jobs",
  "admin-jobs",
  "pr-advertising-marketing-jobs",
  "sales-jobs",
  "legal-jobs",
  "customer-services-jobs",
  "logistics-warehouse-jobs",
  "hr-jobs",
  "creative-design-jobs",
  "energy-oil-gas-jobs",
  "manufacturing-jobs",
];

const TECHCORE_CATEGORIES = [
  "it-jobs",
  "engineering-jobs",
];

const SPECIALIST_CATEGORIES = [
  "scientific-qa-jobs",
  "consultancy-jobs",
  "accounting-finance-jobs",
];

const DISCOVERY_CATEGORIES = [
  "graduate-jobs",
  "admin-jobs",
  "pr-advertising-marketing-jobs",
  "sales-jobs",
];

type AdzunaProfile = {
  name: string;
  categories: string[];
  maxPages: number;
  maxDaysOld: number;
  categoryStrategy: "SEQUENTIAL" | "ROUND_ROBIN";
};

const ADZUNA_ALLOWED_COUNTRIES = new Set(["us", "ca"]);

const ADZUNA_PROFILES: Record<string, AdzunaProfile> = {
  baseline: {
    name: "baseline",
    categories: FOCUSED_CATEGORIES,
    maxPages: ADZUNA_MAX_PAGES,
    maxDaysOld: 14,
    categoryStrategy: "SEQUENTIAL",
  },
  focused: {
    name: "focused",
    categories: FOCUSED_CATEGORIES,
    maxPages: ADZUNA_MAX_PAGES,
    maxDaysOld: 14,
    categoryStrategy: "ROUND_ROBIN",
  },
  broad: {
    name: "broad",
    categories: BROAD_CATEGORIES,
    maxPages: ADZUNA_MAX_PAGES,
    maxDaysOld: 45,
    categoryStrategy: "ROUND_ROBIN",
  },
  techcore: {
    name: "techcore",
    categories: TECHCORE_CATEGORIES,
    maxPages: ADZUNA_MAX_PAGES,
    maxDaysOld: 14,
    categoryStrategy: "ROUND_ROBIN",
  },
  specialist: {
    name: "specialist",
    categories: SPECIALIST_CATEGORIES,
    maxPages: ADZUNA_MAX_PAGES,
    maxDaysOld: 14,
    categoryStrategy: "ROUND_ROBIN",
  },
  discovery: {
    name: "discovery",
    categories: DISCOVERY_CATEGORIES,
    maxPages: ADZUNA_MAX_PAGES,
    maxDaysOld: 14,
    categoryStrategy: "ROUND_ROBIN",
  },
};

const DEFAULT_PROFILE = ADZUNA_PROFILES.broad;

const STAFFING_COMPANY_RE =
  /\b(targeted talent|teksystems|allegis group|c\/o allegis group)\b/i;

export function createAdzunaConnector(
  options: AdzunaConnectorOptions = {}
): SourceConnector {
  const country = (options.country ?? "ca").trim().toLowerCase();
  const allowNonNa =
    (process.env.ADZUNA_ALLOW_NON_NA ?? "").trim().toLowerCase() === "true";
  if (!allowNonNa && !ADZUNA_ALLOWED_COUNTRIES.has(country)) {
    throw new Error(
      `Adzuna connector country '${country}' is out of scope for this North America-only product.`
    );
  }
  const appId = options.appId ?? process.env.ADZUNA_APP_ID ?? "";
  const appKey = options.appKey ?? process.env.ADZUNA_APP_KEY ?? "";
  const selectedProfile: AdzunaProfile =
    typeof options.profile === "string" && options.profile in ADZUNA_PROFILES
      ? ADZUNA_PROFILES[options.profile]
      : DEFAULT_PROFILE;

  if (!appId || !appKey) {
    throw new Error(
      "Adzuna connector requires ADZUNA_APP_ID and ADZUNA_APP_KEY environment variables."
    );
  }

  const categories = options.categories ?? selectedProfile.categories;
  const maxPages = options.maxPages ?? selectedProfile.maxPages;
  const maxDaysOld = options.maxDaysOld ?? selectedProfile.maxDaysOld;
  const categoryStrategy =
    options.categoryStrategy ?? selectedProfile.categoryStrategy;
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();
  const profileName =
    typeof options.profile === "string" && options.profile in ADZUNA_PROFILES
      ? options.profile
      : selectedProfile.name;
  const tokenSuffix =
    profileName === DEFAULT_PROFILE.name ? "" : `:${profileName}`;

  return {
    key: `adzuna:${country}${tokenSuffix}`,
    sourceName: `Adzuna:${country}${tokenSuffix}`,
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = JSON.stringify({
        limit: fetchOptions.limit ?? "all",
        checkpoint: fetchOptions.checkpoint ?? null,
      });
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchAdzunaJobs({
        country,
        categories,
        maxPages,
        maxDaysOld,
        categoryStrategy,
        profileName,
        appId,
        appKey,
        now: fetchOptions.now,
        limit: fetchOptions.limit,
        signal: fetchOptions.signal,
        checkpoint: parseAdzunaCheckpoint(fetchOptions.checkpoint, categories),
        onCheckpoint: fetchOptions.onCheckpoint,
        log: fetchOptions.log,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchAdzunaJobs({
  country,
  categories,
  maxPages,
  maxDaysOld,
  categoryStrategy,
  profileName,
  appId,
  appKey,
  now,
  limit,
  signal,
  checkpoint,
  onCheckpoint,
  log = console.log,
}: {
  country: string;
  categories: string[];
  maxPages: number;
  maxDaysOld: number;
  categoryStrategy: "SEQUENTIAL" | "ROUND_ROBIN";
  profileName: string;
  appId: string;
  appKey: string;
  now: Date;
  limit?: number;
  signal?: AbortSignal;
  checkpoint?: AdzunaCheckpoint | null;
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
  log?: (message: string) => void;
}): Promise<SourceConnectorFetchResult> {
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let totalApiCount = 0;
  const rawFetchedByCategory: Record<string, number> = {};
  const mappedByCategory: Record<string, number> = {};
  const staffingFilteredByCategory: Record<string, number> = {};
  const pagesFetchedByCategory: Record<string, number> = {};
  let requestCount = 0;
  let rateLimited = false;

  const categoryStates = checkpoint?.categoryStates.map((state) => ({ ...state })) ??
    categories.map((category) => ({
      category,
      page: 1,
      exhausted: false,
    }));

  outer: while (categoryStates.some((state) => !state.exhausted)) {
    throwIfAborted(signal);
    let advanced = false;
    const activeStates =
      categoryStrategy === "SEQUENTIAL"
        ? categoryStates.filter((state) => !state.exhausted).slice(0, 1)
        : categoryStates.filter((state) => !state.exhausted);

    for (const state of activeStates) {
      if (typeof limit === "number" && allJobs.length >= limit) break;

      if (requestCount > 0) {
        await sleepWithAbort(ADZUNA_RATE_DELAY_MS, signal);
      }

      const categoryJobs = await fetchCategoryPage({
        country,
        category: state.category,
        page: state.page,
        maxDaysOld,
        appId,
        appKey,
        signal,
        log,
      });
      requestCount += 1;

      advanced = true;
      totalApiCount += categoryJobs.apiCount;
      rawFetchedByCategory[state.category] =
        (rawFetchedByCategory[state.category] ?? 0) + categoryJobs.rawCount;
      mappedByCategory[state.category] =
        (mappedByCategory[state.category] ?? 0) + categoryJobs.jobs.length;
      staffingFilteredByCategory[state.category] =
        (staffingFilteredByCategory[state.category] ?? 0) +
        categoryJobs.staffingFilteredCount;
      pagesFetchedByCategory[state.category] =
        (pagesFetchedByCategory[state.category] ?? 0) + 1;

      if (categoryJobs.rateLimited) {
        rateLimited = true;
        await onCheckpoint?.(buildAdzunaCheckpoint(categoryStates));
        break outer;
      }

      for (const job of categoryJobs.jobs) {
        if (!seenIds.has(job.sourceId)) {
          seenIds.add(job.sourceId);
          allJobs.push(job);
        }
        if (typeof limit === "number" && allJobs.length >= limit) break;
      }

      if (categoryJobs.rawCount < ADZUNA_PAGE_SIZE || state.page >= maxPages) {
        state.exhausted = true;
      } else {
        state.page++;
      }

      await onCheckpoint?.(buildAdzunaCheckpoint(categoryStates));
    }

    if (!advanced || typeof limit === "number" && allJobs.length >= limit) {
      break;
    }
  }

  const finalJobs =
    typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;
  const exhausted = !rateLimited && categoryStates.every((state) => state.exhausted);

  return {
    jobs: finalJobs,
    checkpoint: exhausted ? null : buildAdzunaCheckpoint(categoryStates),
    exhausted,
    metadata: {
      country,
      profile: profileName,
      categories,
      categoryStrategy,
      maxDaysOld,
      maxPages,
      apiBaseUrl: ADZUNA_API_BASE,
      totalApiResults: totalApiCount,
      fetchedAt: now.toISOString(),
      totalFetched: finalJobs.length,
      resumedFromCheckpoint: checkpoint ?? null,
      rawFetchedByCategory,
      mappedByCategory,
      staffingFilteredByCategory,
      pagesFetchedByCategory,
      rateLimited,
    } as Prisma.InputJsonValue,
  };
}

function buildAdzunaCheckpoint(
  categoryStates: Array<{
    category: string;
    page: number;
    exhausted: boolean;
  }>
) {
  return {
    categoryStates: categoryStates.map((state) => ({
      category: state.category,
      page: state.page,
      exhausted: state.exhausted,
    })),
  } as Prisma.InputJsonValue;
}

function parseAdzunaCheckpoint(
  value: Prisma.InputJsonValue | null | undefined,
  categories: string[]
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawStates = Array.isArray(record.categoryStates)
    ? record.categoryStates
    : null;
  if (!rawStates) return null;

  const normalizedStates = rawStates
    .filter(
      (
        state
      ): state is { category: unknown; page: unknown; exhausted: unknown } =>
        Boolean(state) && typeof state === "object" && !Array.isArray(state)
    )
    .map((state) => ({
      category:
        typeof state.category === "string" && categories.includes(state.category)
          ? state.category
          : null,
      page:
        typeof state.page === "number" && Number.isFinite(state.page) && state.page >= 1
          ? state.page
          : 1,
      exhausted: state.exhausted === true,
    }))
    .filter(
      (state): state is { category: string; page: number; exhausted: boolean } =>
        Boolean(state.category)
    );

  if (normalizedStates.length !== categories.length) return null;

  return {
    categoryStates: categories.map(
      (category) =>
        normalizedStates.find((state) => state.category === category) ?? {
          category,
          page: 1,
          exhausted: false,
        }
    ),
  } satisfies AdzunaCheckpoint;
}

async function fetchCategoryPage({
  country,
  category,
  page,
  maxDaysOld,
  appId,
  appKey,
  signal,
  log = console.log,
}: {
  country: string;
  category: string;
  page: number;
  maxDaysOld: number;
  appId: string;
  appKey: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<{
  jobs: SourceConnectorJob[];
  apiCount: number;
  rawCount: number;
  staffingFilteredCount: number;
  rateLimited: boolean;
}> {
  const url = buildSearchUrl(country, category, appId, appKey, page, maxDaysOld);

  for (let attempt = 1; attempt <= ADZUNA_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; autoapplication-adzuna/1.0)",
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        if (attempt < ADZUNA_RATE_LIMIT_MAX_ATTEMPTS) {
          log(
            `[adzuna:${country}] Rate limited on ${category} page ${page}; backing off (${attempt}/${ADZUNA_RATE_LIMIT_MAX_ATTEMPTS})`
          );
          await sleepWithAbort(ADZUNA_RATE_LIMIT_BACKOFF_MS * attempt, signal);
          continue;
        }

        log(
          `[adzuna:${country}] Rate limited on ${category} page ${page}, stopping connector fetch`
        );
        return {
          jobs: [],
          apiCount: 0,
          rawCount: 0,
          staffingFilteredCount: 0,
          rateLimited: true,
        };
      }
      log(`[adzuna:${country}] API error ${response.status} on ${category} page ${page}`);
      return {
        jobs: [],
        apiCount: 0,
        rawCount: 0,
        staffingFilteredCount: 0,
        rateLimited: false,
      };
    }

    const payload = (await response.json()) as AdzunaSearchResponse;
    if (payload.__CLASS__?.includes("Exception")) {
      log(`[adzuna:${country}] API exception on ${category}: ${JSON.stringify(payload)}`);
      return {
        jobs: [],
        apiCount: payload.count ?? 0,
        rawCount: 0,
        staffingFilteredCount: 0,
        rateLimited: false,
      };
    }

    const results = payload.results ?? [];
    const jobs: SourceConnectorJob[] = [];
    let staffingFilteredCount = 0;

    for (const entry of results) {
      if (!entry.id || !entry.title) continue;
      if (isStaffingEntry(entry)) {
        staffingFilteredCount += 1;
        continue;
      }
      const mappedJob = mapAdzunaJob(entry, country);
      if (mappedJob) jobs.push(mappedJob);
    }

    return {
      jobs,
      apiCount: payload.count ?? 0,
      rawCount: results.length,
      staffingFilteredCount,
      rateLimited: false,
    };
  }

  return {
    jobs: [],
    apiCount: 0,
    rawCount: 0,
    staffingFilteredCount: 0,
    rateLimited: true,
  };
}

function buildSearchUrl(
  country: string,
  category: string,
  appId: string,
  appKey: string,
  page: number,
  maxDaysOld: number
): string {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: String(ADZUNA_PAGE_SIZE),
    "content-type": "application/json",
    sort_by: "date",
    max_days_old: String(maxDaysOld),
    category,
  });
  return `${ADZUNA_API_BASE}/${country}/search/${page}?${params.toString()}`;
}

function mapAdzunaJob(
  entry: AdzunaJob,
  country: string
): SourceConnectorJob | null {
  const id = String(entry.id ?? "");
  const title = (entry.title ?? "").trim();
  const company = entry.company?.display_name?.trim() ?? "Unknown Company";
  const location = buildLocation(entry, country);
  const description = stripHtml(entry.description ?? "");

  return {
    sourceId: `adzuna:${country}:${id}`,
    sourceUrl: entry.redirect_url ?? null,
    title: title || "Untitled Position",
    company,
    location,
    description,
    applyUrl: entry.redirect_url ?? "",
    postedAt: entry.created ? new Date(entry.created) : null,
    deadline: null,
    employmentType: inferEmploymentType(entry),
    workMode: inferWorkMode(title, description, location),
    salaryMin:
      entry.salary_min && entry.salary_min > 0 && entry.salary_is_predicted !== "1"
        ? entry.salary_min
        : null,
    salaryMax:
      entry.salary_max && entry.salary_max > 0 && entry.salary_is_predicted !== "1"
        ? entry.salary_max
        : null,
    salaryCurrency:
      entry.salary_min || entry.salary_max
        ? country === "ca"
          ? "CAD"
          : "USD"
        : null,
    metadata: {
      source: "adzuna",
      country,
      category: entry.category?.tag ?? null,
      categoryLabel: entry.category?.label ?? null,
      adzunaId: id,
    } as Prisma.InputJsonValue,
  };
}

function buildLocation(entry: AdzunaJob, country: string): string {
  const display = entry.location?.display_name?.trim() ?? "";
  const areaParts = formatAreaParts(entry.location?.area ?? [], country);

  if (display && areaParts.length > 0) {
    const displayParts = display
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const combinedParts = [...displayParts];
    for (const areaPart of areaParts) {
      if (
        combinedParts.some(
          (existingPart) =>
            existingPart.localeCompare(areaPart, undefined, {
              sensitivity: "accent",
            }) === 0
        )
      ) {
        continue;
      }
      combinedParts.push(areaPart);
    }
    return combinedParts.join(", ");
  }

  if (display) {
    return display;
  }

  if (areaParts.length > 0) {
    return areaParts.join(", ");
  }

  return country === "ca" ? "Canada" : country === "us" ? "United States" : country.toUpperCase();
}

function formatAreaParts(rawArea: string[], country: string) {
  return rawArea
    .filter(Boolean)
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse()
    .map((part) => {
      if (part === "US") return "United States";
      if (part === "CA" && country === "ca") return "Canada";
      return part;
    });
}

function isStaffingEntry(entry: AdzunaJob) {
  const company = entry.company?.display_name?.trim() ?? "";
  return STAFFING_COMPANY_RE.test(company);
}

function inferEmploymentType(entry: AdzunaJob): EmploymentType | null {
  if (entry.contract_type === "permanent") return null; // full-time is default
  if (entry.contract_type === "contract") return "CONTRACT";
  if (entry.contract_time === "part_time") return "PART_TIME";
  return null;
}

function inferWorkMode(
  title: string,
  description: string,
  location: string
): WorkMode | null {
  const text = (title + " " + location + " " + description.slice(0, 500)).toLowerCase();
  if (/\bhybrid\b/.test(text)) return "HYBRID";
  if (/\bfully\s+remote\b/.test(text) || /\b100%?\s*remote\b/.test(text)) return "REMOTE";
  if (/\bremote\b/.test(text)) return "REMOTE";
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
