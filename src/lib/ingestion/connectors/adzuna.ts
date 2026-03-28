/**
 * Adzuna job search API connector.
 *
 * Adzuna aggregates jobs from thousands of sources across 12+ countries.
 * Free API tier: 25 req/min, 250 req/day, with app_id + app_key.
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

const ADZUNA_API_BASE = "https://api.adzuna.com/v1/api/jobs";
const ADZUNA_PAGE_SIZE = 50; // max allowed by API
const ADZUNA_MAX_PAGES = 20; // safety limit per category
const ADZUNA_RATE_DELAY_MS = 2500; // ~25 req/min safe

type AdzunaConnectorOptions = {
  country?: string;
  categories?: string[];
  appId?: string;
  appKey?: string;
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

// Tech/finance-focused categories for the Adzuna API
const DEFAULT_CATEGORIES = [
  "it-jobs",
  "engineering-jobs",
  "scientific-qa-jobs",
  "consultancy-jobs",
  "accounting-finance-jobs",
  "admin-jobs",
  "graduate-jobs",
  "hr-jobs",
  "legal-jobs",
  "logistics-warehouse-jobs",
  "manufacturing-jobs",
  "other-general-jobs",
  "pr-advertising-marketing-jobs",
  "sales-jobs",
];

export function createAdzunaConnector(
  options: AdzunaConnectorOptions = {}
): SourceConnector {
  const country = (options.country ?? "ca").trim().toLowerCase();
  const appId = options.appId ?? process.env.ADZUNA_APP_ID ?? "";
  const appKey = options.appKey ?? process.env.ADZUNA_APP_KEY ?? "";

  if (!appId || !appKey) {
    throw new Error(
      "Adzuna connector requires ADZUNA_APP_ID and ADZUNA_APP_KEY environment variables."
    );
  }

  const categories = options.categories ?? DEFAULT_CATEGORIES;
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `adzuna:${country}`,
    sourceName: `Adzuna:${country}`,
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(fetchOptions.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchAdzunaJobs({
        country,
        categories,
        appId,
        appKey,
        now: fetchOptions.now,
        limit: fetchOptions.limit,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchAdzunaJobs({
  country,
  categories,
  appId,
  appKey,
  now,
  limit,
}: {
  country: string;
  categories: string[];
  appId: string;
  appKey: string;
  now: Date;
  limit?: number;
}): Promise<SourceConnectorFetchResult> {
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let totalApiCount = 0;

  for (const category of categories) {
    if (typeof limit === "number" && allJobs.length >= limit) break;

    const categoryJobs = await fetchCategoryJobs({
      country,
      category,
      appId,
      appKey,
      now,
      maxJobs: typeof limit === "number" ? limit - allJobs.length : undefined,
    });

    for (const job of categoryJobs.jobs) {
      if (!seenIds.has(job.sourceId)) {
        seenIds.add(job.sourceId);
        allJobs.push(job);
      }
    }
    totalApiCount += categoryJobs.apiCount;

    if (typeof limit === "number" && allJobs.length >= limit) break;
  }

  const finalJobs =
    typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;

  return {
    jobs: finalJobs,
    metadata: {
      country,
      categories,
      apiBaseUrl: ADZUNA_API_BASE,
      totalApiResults: totalApiCount,
      fetchedAt: now.toISOString(),
      totalFetched: finalJobs.length,
    } as Prisma.InputJsonValue,
  };
}

async function fetchCategoryJobs({
  country,
  category,
  appId,
  appKey,
  now,
  maxJobs,
}: {
  country: string;
  category: string;
  appId: string;
  appKey: string;
  now: Date;
  maxJobs?: number;
}): Promise<{ jobs: SourceConnectorJob[]; apiCount: number }> {
  const jobs: SourceConnectorJob[] = [];
  let page = 1;
  let apiCount = 0;

  while (page <= ADZUNA_MAX_PAGES) {
    if (typeof maxJobs === "number" && jobs.length >= maxJobs) break;

    const url = buildSearchUrl(country, category, appId, appKey, page);

    // Rate limiting
    if (page > 1) {
      await sleep(ADZUNA_RATE_DELAY_MS);
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; autoapplication-adzuna/1.0)",
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.log(`[adzuna:${country}] Rate limited on ${category} page ${page}, stopping category`);
        break;
      }
      console.log(`[adzuna:${country}] API error ${response.status} on ${category} page ${page}`);
      break;
    }

    const payload = (await response.json()) as AdzunaSearchResponse;
    if (payload.__CLASS__?.includes("Exception")) {
      console.log(`[adzuna:${country}] API exception on ${category}: ${JSON.stringify(payload)}`);
      break;
    }

    const results = payload.results ?? [];
    apiCount = payload.count ?? apiCount;

    if (results.length === 0) break;

    for (const entry of results) {
      if (entry.id && entry.title) {
        jobs.push(mapAdzunaJob(entry, country, now));
      }
    }

    if (results.length < ADZUNA_PAGE_SIZE) break;
    page++;
  }

  return {
    jobs: typeof maxJobs === "number" ? jobs.slice(0, maxJobs) : jobs,
    apiCount,
  };
}

function buildSearchUrl(
  country: string,
  category: string,
  appId: string,
  appKey: string,
  page: number
): string {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: String(ADZUNA_PAGE_SIZE),
    "content-type": "application/json",
    sort_by: "date",
    max_days_old: "14", // Only recent jobs
    category,
  });
  return `${ADZUNA_API_BASE}/${country}/search/${page}?${params.toString()}`;
}

function mapAdzunaJob(
  entry: AdzunaJob,
  country: string,
  now: Date
): SourceConnectorJob {
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
  if (entry.location?.display_name) {
    const display = entry.location.display_name.trim();
    // Adzuna display_name often includes area hierarchy: "Toronto, Ontario"
    return display;
  }
  if (entry.location?.area && entry.location.area.length > 0) {
    return entry.location.area.filter(Boolean).reverse().join(", ");
  }
  return country === "ca" ? "Canada" : country === "us" ? "United States" : country.toUpperCase();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
