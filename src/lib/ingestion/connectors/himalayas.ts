/**
 * Himalayas remote job feed connector.
 *
 * Himalayas provides a free, no-auth JSON API for remote job listings.
 * API: https://himalayas.app/jobs/api?limit=20&offset=0
 * Search: https://himalayas.app/jobs/api/search (POST with filters)
 *
 * Volume: 100K+ remote jobs.
 * Canada: Yes (locationRestrictions filter).
 * Attribution: Must link back to Himalayas.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const HIMALAYAS_API_BASE = "https://himalayas.app/jobs/api";
const HIMALAYAS_PAGE_SIZE = 20; // API max per request
const HIMALAYAS_MAX_PAGES = 80; // 80 * 20 = 1,600 jobs max per run
const HIMALAYAS_RATE_DELAY_MS = 1200; // Be respectful, avoid 429

type HimalayasJob = {
  id?: string;
  title?: string;
  companyName?: string;
  companyLogo?: string;
  categories?: string[];
  employmentType?: string;
  description?: string;
  applicationLink?: string;
  pubDate?: string;
  expiryDate?: string;
  minSalary?: number;
  maxSalary?: number;
  seniority?: string;
  locationRestrictions?: string[];
  guid?: string;
};

type HimalayasResponse = {
  jobs?: HimalayasJob[];
  offset?: number;
  limit?: number;
  totalCount?: number;
};

export function createHimalayasConnector(): SourceConnector {
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "himalayas:feed",
    sourceName: "Himalayas:feed",
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(options.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchHimalayasJobs(options.now, options.limit);
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchHimalayasJobs(
  now: Date,
  limit?: number
): Promise<SourceConnectorFetchResult> {
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let totalFetched = 0;
  let pagesFetched = 0;

  for (let page = 0; page < HIMALAYAS_MAX_PAGES; page++) {
    if (typeof limit === "number" && allJobs.length >= limit) break;

    try {
      const url = `${HIMALAYAS_API_BASE}?limit=${HIMALAYAS_PAGE_SIZE}&offset=${offset}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (compatible; autoapplication-himalayas/1.0)",
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limited — wait and retry once
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        break;
      }

      const payload = (await response.json()) as HimalayasResponse;
      const entries = payload.jobs ?? [];

      if (entries.length === 0) break; // No more jobs

      for (const entry of entries) {
        if (!entry.title) continue;
        const sourceId = `himalayas:${entry.guid ?? entry.id ?? entry.title}`;
        if (seenIds.has(sourceId)) continue;
        seenIds.add(sourceId);
        allJobs.push(mapHimalayasJob(entry, now));
      }

      totalFetched += entries.length;
      offset += HIMALAYAS_PAGE_SIZE;
      pagesFetched++;

      // Stop if we got fewer than a full page
      if (entries.length < HIMALAYAS_PAGE_SIZE) break;
    } catch {
      // Skip failed pages
      break;
    }

    // Rate delay between pages
    await new Promise((resolve) => setTimeout(resolve, HIMALAYAS_RATE_DELAY_MS));
  }

  const finalJobs =
    typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;

  return {
    jobs: finalJobs,
    metadata: {
      apiUrl: HIMALAYAS_API_BASE,
      fetchedAt: now.toISOString(),
      totalFetched,
      pagesFetched,
      uniqueJobs: finalJobs.length,
    } as Prisma.InputJsonValue,
  };
}

function mapHimalayasJob(entry: HimalayasJob, now: Date): SourceConnectorJob {
  const id = entry.guid ?? entry.id ?? "";
  const title = (entry.title ?? "").trim();
  const company = (entry.companyName ?? "").trim();
  const description = stripHtml(entry.description ?? "");
  const location = normalizeLocationRestrictions(entry.locationRestrictions);
  const applyUrl = entry.applicationLink ?? "";

  return {
    sourceId: `himalayas:${id}`,
    sourceUrl: applyUrl,
    title: title || "Untitled Position",
    company: company || "Unknown Company",
    location,
    description,
    applyUrl,
    postedAt: entry.pubDate ? new Date(entry.pubDate) : null,
    deadline: entry.expiryDate ? new Date(entry.expiryDate) : null,
    employmentType: inferEmploymentType(entry.employmentType),
    workMode: "REMOTE" as WorkMode,
    salaryMin: entry.minSalary && entry.minSalary > 0 ? entry.minSalary : null,
    salaryMax: entry.maxSalary && entry.maxSalary > 0 ? entry.maxSalary : null,
    salaryCurrency:
      entry.minSalary || entry.maxSalary ? "USD" : null,
    metadata: {
      source: "himalayas",
      categories: entry.categories ?? [],
      seniority: entry.seniority ?? null,
      locationRestrictions: entry.locationRestrictions ?? [],
    } as Prisma.InputJsonValue,
  };
}

function normalizeLocationRestrictions(
  restrictions: string[] | undefined
): string {
  if (!restrictions || restrictions.length === 0) return "Remote";

  const joined = restrictions.join(", ");

  // Check for worldwide/anywhere
  if (
    restrictions.some(
      (r) => /anywhere/i.test(r) || /worldwide/i.test(r) || /global/i.test(r)
    )
  ) {
    return "Remote (Worldwide)";
  }

  // If only one or two specific countries
  const countries = restrictions.filter(
    (r) => r.length > 1 && !/anywhere|worldwide|global/i.test(r)
  );
  if (countries.length > 0 && countries.length <= 5) {
    return `Remote (${countries.join(", ")})`;
  }

  return `Remote (${joined})`;
}

function inferEmploymentType(type: string | undefined): EmploymentType | null {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower.includes("contract")) return "CONTRACT";
  if (lower.includes("part-time") || lower.includes("part_time"))
    return "PART_TIME";
  if (lower.includes("internship")) return "INTERNSHIP";
  if (lower.includes("full-time") || lower.includes("full_time"))
    return "FULL_TIME";
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
