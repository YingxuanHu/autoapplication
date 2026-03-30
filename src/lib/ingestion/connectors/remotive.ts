/**
 * Remotive remote jobs connector.
 *
 * Official public API:
 *   GET https://remotive.com/api/remote-jobs
 *
 * Notes:
 * - No auth required
 * - Jobs are delayed by ~24 hours on the public API
 * - Rate guidance is light; Remotive recommends only a few requests per day
 *
 * The public API returns a Remotive job URL rather than a direct external apply
 * URL. That page is still a usable apply path and preserves attribution.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import { throwIfAborted } from "@/lib/ingestion/runtime-control";

const REMOTIVE_API_URL = "https://remotive.com/api/remote-jobs";

type RemotiveJob = {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  company_logo?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
};

type RemotiveResponse = {
  "job-count"?: number;
  "total-job-count"?: number;
  jobs?: RemotiveJob[];
};

export function createRemotiveConnector(): SourceConnector {
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "remotive:feed",
    sourceName: "Remotive:feed",
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(options.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchRemotiveJobs({
        now: options.now,
        limit: options.limit,
        signal: options.signal,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchRemotiveJobs({
  now,
  limit,
  signal,
}: {
  now: Date;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SourceConnectorFetchResult> {
  throwIfAborted(signal);

  const response = await fetch(REMOTIVE_API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-remotive/1.0)",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Remotive API fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as RemotiveResponse;
  const entries = payload.jobs ?? [];
  const toProcess =
    typeof limit === "number" ? entries.slice(0, limit) : entries;
  const jobs = toProcess
    .filter((entry) => entry.id && entry.title && entry.company_name && entry.url)
    .map((entry) => mapRemotiveJob(entry, now));

  return {
    jobs,
    metadata: {
      apiUrl: REMOTIVE_API_URL,
      fetchedAt: now.toISOString(),
      totalFetched: jobs.length,
      jobCount: payload["job-count"] ?? jobs.length,
      totalJobCount: payload["total-job-count"] ?? payload["job-count"] ?? jobs.length,
    } as Prisma.InputJsonValue,
  };
}

function mapRemotiveJob(entry: RemotiveJob, now: Date): SourceConnectorJob {
  const salary = parseSalaryRange(entry.salary);

  return {
    sourceId: `remotive:${entry.id}`,
    sourceUrl: entry.url ?? null,
    title: (entry.title ?? "").trim() || "Untitled Position",
    company: (entry.company_name ?? "").trim() || "Unknown Company",
    location: normalizeCandidateLocation(entry.candidate_required_location),
    description: stripHtml(entry.description ?? ""),
    applyUrl: entry.url ?? "",
    postedAt: entry.publication_date ? new Date(entry.publication_date) : now,
    deadline: null,
    employmentType: inferEmploymentType(entry.job_type),
    workMode: "REMOTE" as WorkMode,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    metadata: {
      source: "remotive",
      category: entry.category ?? null,
      tags: entry.tags ?? [],
      candidateRequiredLocation: entry.candidate_required_location ?? null,
      companyLogo: entry.company_logo ?? null,
    } as Prisma.InputJsonValue,
  };
}

function normalizeCandidateLocation(raw: string | undefined) {
  if (!raw || !raw.trim()) return "Remote";
  const value = raw.trim();
  if (/worldwide|anywhere/i.test(value)) return "Remote (Worldwide)";
  if (/canada/i.test(value)) return "Remote (Canada)";
  if (/north america|americas/i.test(value)) return "Remote (North America)";
  if (/^us$|^usa$|united states/i.test(value)) return "Remote (US Only)";
  return `Remote (${value})`;
}

function inferEmploymentType(raw: string | undefined): EmploymentType | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value.includes("contract") || value.includes("freelance")) return "CONTRACT";
  if (value.includes("part")) return "PART_TIME";
  if (value.includes("intern")) return "INTERNSHIP";
  if (value.includes("full")) return "FULL_TIME";
  return null;
}

function parseSalaryRange(raw: string | undefined): {
  min: number | null;
  max: number | null;
  currency: string | null;
} {
  if (!raw || !raw.trim()) {
    return { min: null, max: null, currency: null };
  }

  const currency = /\bEUR\b|€/i.test(raw) ? "EUR" : "USD";
  const values = [...raw.matchAll(/\$?€?\s*(\d+(?:\.\d+)?)\s*([kK])?/g)]
    .map((match) => {
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return null;
      return match[2] ? base * 1000 : base;
    })
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (values.length === 0) {
    return { min: null, max: null, currency: null };
  }

  return {
    min: values[0] ?? null,
    max: values[1] ?? values[0] ?? null,
    currency,
  };
}

function stripHtml(html: string) {
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
