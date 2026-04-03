/**
 * The Muse job board connector.
 *
 * The Muse provides a free public JSON API for job listings.
 * API: https://www.themuse.com/api/public/jobs?page=0&category=...&location=...
 *
 * Volume: Thousands of listings from enterprise employers.
 * Canada: Yes (location filter).
 * Rate limits: 500/hr unauthenticated, 3,600/hr with free key.
 * Attribution: Must link back to The Muse.
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

const MUSE_API_BASE = "https://www.themuse.com/api/public/jobs";
const MUSE_PAGE_SIZE = 20; // API returns 20 per page
const MUSE_MAX_PAGES = 50; // 50 * 20 = 1,000 jobs max per category
const MUSE_RATE_DELAY_MS = 800; // Stay under 500/hr limit

// Tech/finance-relevant categories on The Muse
const MUSE_CATEGORIES = [
  "Computer and IT",
  "Data and Analytics",
  "Data Science",
  "Design and UX",
  "IT",
  "Software Engineering",
  "Science and Engineering",
  "Business Operations",
  "Finance",
  "Project and Product Management",
];

// NA locations
const MUSE_LOCATIONS = [
  "Flexible / Remote",
  "New York, NY",
  "San Francisco, CA",
  "Chicago, IL",
  "Seattle, WA",
  "Boston, MA",
  "Austin, TX",
  "Los Angeles, CA",
  "Toronto, Canada",
  "Vancouver, Canada",
  "Denver, CO",
  "Atlanta, GA",
  "Washington, DC",
];

type MuseJob = {
  id?: number;
  name?: string;
  type?: string;
  publication_date?: string;
  short_name?: string;
  model_type?: string;
  contents?: string;
  refs?: {
    landing_page?: string;
  };
  company?: {
    id?: number;
    name?: string;
    short_name?: string;
  };
  categories?: Array<{ name?: string }>;
  levels?: Array<{ name?: string; short_name?: string }>;
  locations?: Array<{ name?: string }>;
};

type MuseResponse = {
  page?: number;
  page_count?: number;
  total?: number;
  results?: MuseJob[];
};

type MuseCheckpoint = {
  categoryIndex: number;
  page: number;
};

export function createMuseConnector(): SourceConnector {
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "themuse:feed",
    sourceName: "TheMuse:feed",
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
      if (existing) return existing;

      const request = fetchMuseJobs({
        now: options.now,
        limit: options.limit,
        signal: options.signal,
        checkpoint: parseMuseCheckpoint(options.checkpoint),
        onCheckpoint: options.onCheckpoint,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchMuseJobs(
  {
    now,
    limit,
    signal,
    checkpoint,
    onCheckpoint,
  }: {
    now: Date;
    limit?: number;
    signal?: AbortSignal;
    checkpoint?: MuseCheckpoint | null;
    onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
  }
): Promise<SourceConnectorFetchResult> {
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let totalApiCalls = 0;
  let nextCheckpoint: MuseCheckpoint | null = checkpoint ?? {
    categoryIndex: 0,
    page: 0,
  };

  for (
    let categoryIndex = checkpoint?.categoryIndex ?? 0;
    categoryIndex < MUSE_CATEGORIES.length;
    categoryIndex++
  ) {
    throwIfAborted(signal);
    if (typeof limit === "number" && allJobs.length >= limit) break;
    const category = MUSE_CATEGORIES[categoryIndex];

    for (
      let page = categoryIndex === (checkpoint?.categoryIndex ?? 0)
        ? (checkpoint?.page ?? 0)
        : 0;
      page < MUSE_MAX_PAGES;
      page++
    ) {
      if (typeof limit === "number" && allJobs.length >= limit) break;

      try {
        const params = new URLSearchParams({
          page: String(page),
          category,
        });

        // Add location filters
        for (const loc of MUSE_LOCATIONS) {
          params.append("location", loc);
        }

        const url = `${MUSE_API_BASE}?${params.toString()}`;
        const response = await fetch(url, {
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (compatible; autoapplication-themuse/1.0)",
          },
        });

        totalApiCalls++;

        if (!response.ok) {
          if (response.status === 429) {
            // Rate limited — wait and skip this category
            await sleepWithAbort(10000, signal);
            nextCheckpoint = {
              categoryIndex: categoryIndex + 1,
              page: 0,
            };
            await onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
            break;
          }
          break;
        }

        const payload = (await response.json()) as MuseResponse;
        const entries = payload.results ?? [];

        if (entries.length === 0) {
          nextCheckpoint = {
            categoryIndex: categoryIndex + 1,
            page: 0,
          };
          await onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
          break;
        }

        for (const entry of entries) {
          if (!entry.id || !entry.name) continue;
          const sourceId = `themuse:${entry.id}`;
          if (seenIds.has(sourceId)) continue;
          seenIds.add(sourceId);
          allJobs.push(mapMuseJob(entry));
        }

        // Stop if we're past the last page
        if (
          payload.page_count !== undefined &&
          page >= payload.page_count - 1
        ) {
          nextCheckpoint = {
            categoryIndex: categoryIndex + 1,
            page: 0,
          };
          await onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
          break;
        }

        // Stop if fewer than a full page
        if (entries.length < MUSE_PAGE_SIZE) {
          nextCheckpoint = {
            categoryIndex: categoryIndex + 1,
            page: 0,
          };
          await onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
          break;
        }

        nextCheckpoint = {
          categoryIndex,
          page: page + 1,
        };
        await onCheckpoint?.(nextCheckpoint as Prisma.InputJsonValue);
      } catch (error) {
        if (signal?.aborted) throw error;
        break;
      }

      await sleepWithAbort(MUSE_RATE_DELAY_MS, signal);
    }

    // Small delay between categories
    await sleepWithAbort(500, signal);
  }

  const finalJobs =
    typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;
  const exhausted =
    nextCheckpoint == null || nextCheckpoint.categoryIndex >= MUSE_CATEGORIES.length;

  return {
    jobs: finalJobs,
    checkpoint: exhausted ? null : (nextCheckpoint as Prisma.InputJsonValue),
    exhausted,
    metadata: {
      apiUrl: MUSE_API_BASE,
      categories: MUSE_CATEGORIES,
      fetchedAt: now.toISOString(),
      totalApiCalls,
      totalFetched: finalJobs.length,
      resumedFromCheckpoint: checkpoint ?? null,
    } as Prisma.InputJsonValue,
  };
}

function parseMuseCheckpoint(value: Prisma.InputJsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const categoryIndex =
    typeof record.categoryIndex === "number" ? record.categoryIndex : 0;
  const page = typeof record.page === "number" ? record.page : 0;
  if (categoryIndex < 0 || page < 0) return null;
  return { categoryIndex, page } satisfies MuseCheckpoint;
}

function mapMuseJob(entry: MuseJob): SourceConnectorJob {
  const id = String(entry.id ?? "");
  const title = (entry.name ?? "").trim();
  const company = (entry.company?.name ?? "").trim();
  const description = stripHtml(entry.contents ?? "");
  const locations = (entry.locations ?? [])
    .map((loc) => loc.name ?? "")
    .filter(Boolean);
  const location = normalizeMuseLocations(locations);
  const applyUrl = entry.refs?.landing_page ?? "";
  const categories = (entry.categories ?? [])
    .map((c) => c.name ?? "")
    .filter(Boolean);
  const levels = (entry.levels ?? [])
    .map((l) => l.name ?? "")
    .filter(Boolean);

  return {
    sourceId: `themuse:${id}`,
    sourceUrl: applyUrl,
    title: title || "Untitled Position",
    company: company || "Unknown Company",
    location,
    description,
    applyUrl,
    postedAt: entry.publication_date
      ? new Date(entry.publication_date)
      : null,
    deadline: null,
    employmentType: inferEmploymentType(entry.type),
    workMode: inferWorkMode(locations),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      source: "themuse",
      categories,
      levels,
      locations,
    } as Prisma.InputJsonValue,
  };
}

function normalizeMuseLocations(locations: string[]): string {
  if (locations.length === 0) return "Unknown";

  const hasRemote = locations.some(
    (loc) => /remote/i.test(loc) || /flexible/i.test(loc)
  );

  const physicalLocations = locations.filter(
    (loc) => !/remote/i.test(loc) && !/flexible/i.test(loc)
  );

  if (hasRemote && physicalLocations.length === 0) return "Remote";
  if (hasRemote && physicalLocations.length > 0) {
    return `Hybrid/Remote (${physicalLocations.slice(0, 3).join("; ")})`;
  }
  return physicalLocations.slice(0, 3).join("; ");
}

function inferWorkMode(locations: string[]): WorkMode {
  const hasRemote = locations.some(
    (loc) => /remote/i.test(loc) || /flexible/i.test(loc)
  );
  const hasPhysical = locations.some(
    (loc) => !/remote/i.test(loc) && !/flexible/i.test(loc) && loc.length > 0
  );

  if (hasRemote && hasPhysical) return "HYBRID" as WorkMode;
  if (hasRemote) return "REMOTE" as WorkMode;
  return "ONSITE" as WorkMode;
}

function inferEmploymentType(type: string | undefined): EmploymentType | null {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower.includes("intern")) return "INTERNSHIP";
  if (lower.includes("contract") || lower.includes("freelance"))
    return "CONTRACT";
  if (lower.includes("part")) return "PART_TIME";
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
