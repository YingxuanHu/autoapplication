/**
 * Himalayas remote job feed connector.
 *
 * Himalayas provides a free, no-auth JSON API for remote job listings.
 * API: https://himalayas.app/jobs/api?limit=20&offset=0
 * Search: https://himalayas.app/jobs/api/search
 *
 * Volume: 100K+ remote jobs.
 * Canada: Yes (locationRestrictions filter).
 * Attribution: Must link back to Himalayas.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
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

const HIMALAYAS_API_BASE = "https://himalayas.app/jobs/api";
const HIMALAYAS_SEARCH_API_BASE = "https://himalayas.app/jobs/api/search";
const HIMALAYAS_PAGE_SIZE = 20; // API max per request
const HIMALAYAS_MAX_PAGES = 600; // 600 * 20 = 12,000 jobs max per run
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

type HimalayasCheckpoint = {
  segmentIndex: number;
  cursor: number;
};

type HimalayasProfile =
  | "global"
  | "canada_friendly"
  | "canada_strict"
  | "na_scale"
  | "us_strict";

type HimalayasConnectorOptions = {
  profile?: string;
};

type HimalayasFetchMode = "browse" | "search";
type HimalayasFilterMode = "global" | "canada_friendly" | "canada_strict";

type HimalayasFetchSegment = {
  label: string;
  mode: HimalayasFetchMode;
  filterMode: HimalayasFilterMode;
  params?: Record<string, string>;
};

type HimalayasProfileConfig = {
  labelSuffix: string;
  segments: HimalayasFetchSegment[];
};

const HIMALAYAS_PROFILE_CONFIGS: Record<HimalayasProfile, HimalayasProfileConfig> = {
  global: {
    labelSuffix: "feed",
    segments: [{ label: "browse", mode: "browse", filterMode: "global" }],
  },
  canada_friendly: {
    labelSuffix: "canada_friendly",
    segments: [
      {
        label: "country_ca",
        mode: "search",
        filterMode: "global",
        params: { country: "CA" },
      },
    ],
  },
  canada_strict: {
    labelSuffix: "canada_strict",
    segments: [
      {
        label: "country_ca_strict",
        mode: "search",
        filterMode: "global",
        params: { country: "CA", exclude_worldwide: "true" },
      },
    ],
  },
  us_strict: {
    labelSuffix: "us_strict",
    segments: [
      {
        label: "country_us_strict",
        mode: "search",
        filterMode: "global",
        params: { country: "US", exclude_worldwide: "true" },
      },
    ],
  },
  na_scale: {
    labelSuffix: "na_scale",
    segments: [
      {
        label: "country_ca",
        mode: "search",
        filterMode: "global",
        params: { country: "CA" },
      },
      {
        label: "country_us_strict",
        mode: "search",
        filterMode: "global",
        params: { country: "US", exclude_worldwide: "true" },
      },
    ],
  },
};

const CA_RESTRICTION_MARKERS = [
  "canada",
  "toronto",
  "vancouver",
  "montreal",
  "calgary",
  "ottawa",
  "waterloo",
  "edmonton",
  "winnipeg",
  "halifax",
  "surrey",
  "burnaby",
  "mississauga",
  "ontario",
  "british columbia",
  "quebec",
  "alberta",
  "manitoba",
  "saskatchewan",
  "nova scotia",
  "new brunswick",
  "newfoundland",
  "prince edward island",
];

const CA_FRIENDLY_RESTRICTION_MARKERS = [
  ...CA_RESTRICTION_MARKERS,
  "north america",
  "americas",
  "worldwide",
  "global",
  "anywhere",
];

const NON_NA_RESTRICTION_MARKERS = [
  "europe",
  "emea",
  "apac",
  "asia",
  "australia",
  "india",
  "latam",
  "germany",
  "france",
  "united kingdom",
  "uk",
  "singapore",
  "japan",
  "poland",
  "netherlands",
  "sweden",
  "middle east",
  "africa",
];

export function createHimalayasConnector(
  options: HimalayasConnectorOptions = {}
): SourceConnector {
  const profile = parseHimalayasProfile(options.profile);
  const profileConfig = HIMALAYAS_PROFILE_CONFIGS[profile];
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `himalayas:${profileConfig.labelSuffix}`,
    sourceName: `Himalayas:${profileConfig.labelSuffix}`,
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

      const request = fetchHimalayasJobs({
        now: options.now,
        limit: options.limit,
        signal: options.signal,
        profile,
        checkpoint: parseHimalayasCheckpoint(options.checkpoint),
        onCheckpoint: options.onCheckpoint,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchHimalayasJobs({
  now,
  limit,
  signal,
  profile,
  checkpoint,
  onCheckpoint,
}: {
  now: Date;
  limit?: number;
  signal?: AbortSignal;
  profile: HimalayasProfile;
  checkpoint?: HimalayasCheckpoint | null;
  onCheckpoint?: (checkpoint: Prisma.InputJsonValue | null) => Promise<void> | void;
}): Promise<SourceConnectorFetchResult> {
  const profileConfig = HIMALAYAS_PROFILE_CONFIGS[profile];
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let segmentIndex = checkpoint?.segmentIndex ?? 0;
  let cursor =
    checkpoint?.cursor ??
    getInitialCursor(profileConfig.segments[segmentIndex] ?? profileConfig.segments[0]);
  let totalFetched = 0;
  let pagesFetched = 0;
  let totalAvailable = 0;
  const visitedSegments = new Set<string>();
  const requestedPages =
    typeof limit === "number"
      ? Math.max(1, Math.ceil(limit / HIMALAYAS_PAGE_SIZE))
      : HIMALAYAS_MAX_PAGES;
  const maxPages = Math.min(HIMALAYAS_MAX_PAGES, requestedPages + 8);

  while (segmentIndex < profileConfig.segments.length && pagesFetched < maxPages) {
    throwIfAborted(signal);
    if (typeof limit === "number" && allJobs.length >= limit) break;

    const segment = profileConfig.segments[segmentIndex];
    visitedSegments.add(segment.label);

    try {
      const url = buildSegmentUrl(segment, cursor);
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (compatible; autoapplication-himalayas/1.0)",
        },
        signal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          await sleepWithAbort(5000, signal);
          continue;
        }
        break;
      }

      const payload = (await response.json()) as HimalayasResponse;
      const entries = payload.jobs ?? [];
      if (typeof payload.totalCount === "number") {
        totalAvailable += payload.totalCount;
      }

      if (entries.length === 0) {
        segmentIndex += 1;
        cursor = getInitialCursor(profileConfig.segments[segmentIndex] ?? null);
        await onCheckpoint?.(
          segmentIndex >= profileConfig.segments.length
            ? null
            : ({ segmentIndex, cursor } satisfies HimalayasCheckpoint)
        );
        continue;
      }

      for (const entry of entries) {
        if (!entry.title) continue;
        if (!matchesHimalayasFilter(entry, segment.filterMode)) continue;
        const sourceId = `himalayas:${entry.guid ?? entry.id ?? entry.title}`;
        if (seenIds.has(sourceId)) continue;
        seenIds.add(sourceId);
        allJobs.push(mapHimalayasJob(entry));
      }

      totalFetched += entries.length;
      pagesFetched++;
      cursor = getNextCursor(segment, cursor);

      const exhausted = didExhaustSegment(segment, payload, entries.length, cursor);

      await onCheckpoint?.(
        exhausted
          ? segmentIndex + 1 >= profileConfig.segments.length
            ? null
            : ({
                segmentIndex: segmentIndex + 1,
                cursor: getInitialCursor(profileConfig.segments[segmentIndex + 1] ?? null),
              } satisfies HimalayasCheckpoint)
          : ({ segmentIndex, cursor } satisfies HimalayasCheckpoint)
      );

      if (exhausted) {
        segmentIndex += 1;
        cursor = getInitialCursor(profileConfig.segments[segmentIndex] ?? null);
        continue;
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      break;
    }

    await sleepWithAbort(HIMALAYAS_RATE_DELAY_MS, signal);
  }

  const finalJobs =
    typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;
  const exhausted = segmentIndex >= profileConfig.segments.length;

  return {
    jobs: finalJobs,
    checkpoint:
      exhausted || typeof limit === "number" && finalJobs.length >= limit
        ? exhausted
          ? null
          : ({ segmentIndex, cursor } satisfies HimalayasCheckpoint)
        : ({ segmentIndex, cursor } satisfies HimalayasCheckpoint),
    exhausted,
    metadata: {
      apiUrl: HIMALAYAS_API_BASE,
      fetchedAt: now.toISOString(),
      totalFetched,
      pagesFetched,
      uniqueJobs: finalJobs.length,
      totalAvailable,
      profile,
      segments: [...visitedSegments],
      resumedFromCheckpoint: checkpoint ?? null,
    } as Prisma.InputJsonValue,
  };
}

function mapHimalayasJob(entry: HimalayasJob): SourceConnectorJob {
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
    salaryCurrency: entry.minSalary || entry.maxSalary ? "USD" : null,
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

  if (
    restrictions.some(
      (r) => /anywhere/i.test(r) || /worldwide/i.test(r) || /global/i.test(r)
    )
  ) {
    return "Remote (Worldwide)";
  }

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

function parseHimalayasCheckpoint(
  checkpoint: Prisma.InputJsonValue | null | undefined
): HimalayasCheckpoint | null {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return null;
  }

  const segmentIndex = (checkpoint as Record<string, unknown>).segmentIndex;
  const cursor = (checkpoint as Record<string, unknown>).cursor;
  if (
    typeof segmentIndex !== "number" ||
    !Number.isFinite(segmentIndex) ||
    segmentIndex < 0 ||
    typeof cursor !== "number" ||
    !Number.isFinite(cursor) ||
    cursor < 0
  ) {
    return null;
  }

  return { segmentIndex, cursor };
}

function parseHimalayasProfile(rawProfile: string | undefined): HimalayasProfile {
  if (
    rawProfile === "canada_friendly" ||
    rawProfile === "canada_strict" ||
    rawProfile === "na_scale" ||
    rawProfile === "us_strict"
  ) {
    return rawProfile;
  }
  return "global";
}

function matchesHimalayasFilter(
  entry: HimalayasJob,
  filterMode: HimalayasFilterMode
) {
  if (filterMode === "global") return true;

  const restrictions = (entry.locationRestrictions ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (restrictions.length === 0) {
    return false;
  }

  const text = restrictions.join(" | ");
  const explicitCanada = CA_RESTRICTION_MARKERS.some((marker) =>
    text.includes(marker)
  );

  if (filterMode === "canada_strict") {
    return explicitCanada;
  }

  const canadaFriendly = CA_FRIENDLY_RESTRICTION_MARKERS.some((marker) =>
    text.includes(marker)
  );
  const explicitNonNAOnly =
    NON_NA_RESTRICTION_MARKERS.some((marker) => text.includes(marker)) &&
    !canadaFriendly;
  const explicitUsOnly =
    (text.includes("united states") || text.includes("usa") || text.includes("us only")) &&
    !explicitCanada &&
    !text.includes("north america") &&
    !text.includes("americas");

  return canadaFriendly && !explicitNonNAOnly && !explicitUsOnly;
}

function getInitialCursor(segment: HimalayasFetchSegment | null) {
  if (!segment) return 0;
  return segment.mode === "browse" ? 0 : 1;
}

function getNextCursor(segment: HimalayasFetchSegment, cursor: number) {
  return segment.mode === "browse" ? cursor + HIMALAYAS_PAGE_SIZE : cursor + 1;
}

function cursorExhaustsSegment(
  segment: HimalayasFetchSegment,
  cursor: number,
  totalCount: number
) {
  if (segment.mode === "browse") {
    return cursor >= totalCount;
  }

  return (cursor - 1) * HIMALAYAS_PAGE_SIZE >= totalCount;
}

function didExhaustSegment(
  segment: HimalayasFetchSegment,
  payload: HimalayasResponse,
  entryCount: number,
  cursor: number
) {
  if (segment.mode === "browse") {
    return (
      entryCount < HIMALAYAS_PAGE_SIZE ||
      (typeof payload.totalCount === "number" &&
        cursorExhaustsSegment(segment, cursor, payload.totalCount))
    );
  }

  if (typeof payload.totalCount === "number") {
    const currentOffset =
      typeof payload.offset === "number"
        ? payload.offset
        : Math.max(0, (cursor - 2) * HIMALAYAS_PAGE_SIZE);
    return currentOffset + entryCount >= payload.totalCount;
  }

  return entryCount === 0;
}

function buildSegmentUrl(segment: HimalayasFetchSegment, cursor: number) {
  const params = new URLSearchParams();
  params.set("limit", String(HIMALAYAS_PAGE_SIZE));

  if (segment.mode === "browse") {
    params.set("offset", String(cursor));
    return `${HIMALAYAS_API_BASE}?${params.toString()}`;
  }

  params.set("page", String(cursor));
  for (const [key, value] of Object.entries(segment.params ?? {})) {
    params.set(key, value);
  }
  return `${HIMALAYAS_SEARCH_API_BASE}?${params.toString()}`;
}
