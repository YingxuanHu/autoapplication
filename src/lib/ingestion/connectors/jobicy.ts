/**
 * Jobicy remote job feed connector.
 *
 * Jobicy provides a free, no-auth JSON API for remote job listings.
 * API: https://jobicy.com/api/v2/remote-jobs?count=50&tag=...
 *
 * Volume: ~2K-5K active remote jobs.
 * Canada: Yes (remote, location-agnostic).
 * Attribution: Must link back to Jobicy.
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

const JOBICY_API_BASE = "https://jobicy.com/api/v2/remote-jobs";

type JobicyJob = {
  id?: number;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  companyLogo?: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  annualSalaryMin?: string;
  annualSalaryMax?: string;
  salaryCurrency?: string;
};

type JobicyResponse = {
  apiVersion?: string;
  documentationUrl?: string;
  friendlyNotice?: string;
  jobCount?: number;
  jobs?: JobicyJob[];
};

// Tech/finance relevant tags
const JOBICY_TAGS = [
  "software-development",
  "devops-sysadmin",
  "data",
  "cyber-security",
  "product",
  "finance-legal",
  "all-others",
];

export function createJobicyConnector(): SourceConnector {
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "jobicy:feed",
    sourceName: "Jobicy:feed",
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(options.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchJobicyJobs(options.now, options.limit, options.signal);
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchJobicyJobs(
  now: Date,
  limit?: number,
  signal?: AbortSignal
): Promise<SourceConnectorFetchResult> {
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();

  for (const tag of JOBICY_TAGS) {
    throwIfAborted(signal);
    if (typeof limit === "number" && allJobs.length >= limit) break;

    try {
      const url = `${JOBICY_API_BASE}?count=50&tag=${tag}`;
      const response = await fetch(url, {
        signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; autoapplication-jobicy/1.0)",
        },
      });

      if (!response.ok) continue;

      const payload = (await response.json()) as JobicyResponse;
      const entries = payload.jobs ?? [];

      for (const entry of entries) {
        if (!entry.id || !entry.jobTitle) continue;
        const sourceId = `jobicy:${entry.id}`;
        if (seenIds.has(sourceId)) continue;
        seenIds.add(sourceId);
        allJobs.push(mapJobicyJob(entry, now));
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    await sleepWithAbort(1000, signal);
  }

  const finalJobs = typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;

  return {
    jobs: finalJobs,
    metadata: {
      apiUrl: JOBICY_API_BASE,
      tags: JOBICY_TAGS,
      fetchedAt: now.toISOString(),
      totalFetched: finalJobs.length,
    } as Prisma.InputJsonValue,
  };
}

function mapJobicyJob(entry: JobicyJob, now: Date): SourceConnectorJob {
  const id = String(entry.id ?? "");
  const title = (entry.jobTitle ?? "").trim();
  const company = (entry.companyName ?? "").trim();
  const description = stripHtml(entry.jobDescription ?? entry.jobExcerpt ?? "");
  const location = normalizeGeo(entry.jobGeo);
  const applyUrl = entry.url ?? "";

  const salaryMin = entry.annualSalaryMin ? parseFloat(entry.annualSalaryMin) : null;
  const salaryMax = entry.annualSalaryMax ? parseFloat(entry.annualSalaryMax) : null;

  return {
    sourceId: `jobicy:${id}`,
    sourceUrl: applyUrl,
    title: title || "Untitled Position",
    company: company || "Unknown Company",
    location,
    description,
    applyUrl,
    postedAt: entry.pubDate ? new Date(entry.pubDate) : null,
    deadline: null,
    employmentType: inferEmploymentType(entry.jobType),
    workMode: "REMOTE" as WorkMode,
    salaryMin: salaryMin && salaryMin > 0 ? salaryMin : null,
    salaryMax: salaryMax && salaryMax > 0 ? salaryMax : null,
    salaryCurrency: entry.salaryCurrency || (salaryMin || salaryMax ? "USD" : null),
    metadata: {
      source: "jobicy",
      industry: entry.jobIndustry ?? [],
      jobType: entry.jobType ?? [],
      jobLevel: entry.jobLevel ?? null,
      jobGeo: entry.jobGeo ?? null,
    } as Prisma.InputJsonValue,
  };
}

function normalizeGeo(geo: string | undefined): string {
  if (!geo || !geo.trim()) return "Remote";
  const trimmed = geo.trim();
  if (/anywhere/i.test(trimmed) || /worldwide/i.test(trimmed)) return "Remote (Worldwide)";
  if (/north\s*america/i.test(trimmed)) return "Remote (North America)";
  if (/usa?\s*only/i.test(trimmed)) return "Remote (US Only)";
  if (/canada/i.test(trimmed)) return "Remote (Canada)";
  return `Remote (${trimmed})`;
}

function inferEmploymentType(
  types: string[] | undefined
): EmploymentType | null {
  if (!types) return null;
  const joined = types.join(" ").toLowerCase();
  if (joined.includes("contract")) return "CONTRACT";
  if (joined.includes("part-time") || joined.includes("part_time")) return "PART_TIME";
  if (joined.includes("internship")) return "INTERNSHIP";
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
