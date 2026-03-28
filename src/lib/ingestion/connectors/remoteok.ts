/**
 * RemoteOK job feed connector.
 *
 * RemoteOK provides a free, no-auth JSON API at https://remoteok.com/api
 * that returns all active remote job listings. Simple flat array of job objects.
 *
 * Volume: ~2K-5K active remote jobs at any time.
 * Net-new value: HIGH for remote roles. Most are not on ATS boards.
 * Canada relevance: All jobs are remote, many open to Canada.
 *
 * Attribution requirement: Must link back to RemoteOK and mention as source.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const REMOTEOK_API_URL = "https://remoteok.com/api";

type RemoteOkJob = {
  slug?: string;
  id?: string;
  epoch?: number;
  date?: string;
  company?: string;
  company_logo?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
};

export function createRemoteOkConnector(): SourceConnector {
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "remoteok:feed",
    sourceName: "RemoteOK:feed",
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(options.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchRemoteOkJobs(options.now, options.limit);
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchRemoteOkJobs(
  now: Date,
  limit?: number
): Promise<SourceConnectorFetchResult> {
  const response = await fetch(REMOTEOK_API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; autoapplication-remoteok/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `RemoteOK API fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const raw = (await response.json()) as RemoteOkJob[];

  // First element is the legal notice, skip it
  const entries = raw.filter(
    (entry) => entry.position && entry.id && entry.company
  );

  const toProcess =
    typeof limit === "number" ? entries.slice(0, limit) : entries;

  const jobs: SourceConnectorJob[] = toProcess.map((entry) =>
    mapToSourceJob(entry, now)
  );

  return {
    jobs,
    metadata: {
      apiUrl: REMOTEOK_API_URL,
      totalFromApi: entries.length,
      fetchedAt: now.toISOString(),
      totalFetched: jobs.length,
    } as Prisma.InputJsonValue,
  };
}

function mapToSourceJob(entry: RemoteOkJob, now: Date): SourceConnectorJob {
  const id = entry.id ?? entry.slug ?? "";
  const title = (entry.position ?? "").trim();
  const company = (entry.company ?? "").trim();
  const location = normalizeLocation(entry.location);
  const description = stripHtml(entry.description ?? "");
  const sourceUrl = entry.url
    ? entry.url
    : `https://remoteok.com/remote-jobs/${entry.slug ?? id}`;
  const applyUrl = entry.apply_url ?? sourceUrl;

  return {
    sourceId: `remoteok:${id}`,
    sourceUrl,
    title: title || "Untitled Position",
    company: company || "Unknown Company",
    location,
    description,
    applyUrl,
    postedAt: entry.date ? new Date(entry.date) : entry.epoch ? new Date(entry.epoch * 1000) : null,
    deadline: null,
    employmentType: inferEmploymentType(title, description),
    workMode: "REMOTE" as WorkMode,
    salaryMin: entry.salary_min && entry.salary_min > 0 ? entry.salary_min : null,
    salaryMax: entry.salary_max && entry.salary_max > 0 ? entry.salary_max : null,
    salaryCurrency: entry.salary_min || entry.salary_max ? "USD" : null,
    metadata: {
      source: "remoteok",
      tags: entry.tags ?? [],
      slug: entry.slug ?? null,
    } as Prisma.InputJsonValue,
  };
}

function normalizeLocation(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "Remote";
  const trimmed = raw.trim();
  // RemoteOK often uses "Worldwide" or specific regions
  if (/worldwide/i.test(trimmed)) return "Remote (Worldwide)";
  if (/north\s*america/i.test(trimmed)) return "Remote (North America)";
  if (/usa?\s*only/i.test(trimmed)) return "Remote (US Only)";
  if (/canada/i.test(trimmed)) return "Remote (Canada)";
  return trimmed.startsWith("Remote") ? trimmed : `Remote (${trimmed})`;
}

function inferEmploymentType(
  title: string,
  description: string
): EmploymentType | null {
  const text = (title + " " + description.slice(0, 500)).toLowerCase();
  if (/\bcontract\b/.test(text)) return "CONTRACT";
  if (/\bpart[- ]?time\b/.test(text)) return "PART_TIME";
  if (/\bintern(ship)?\b/.test(text)) return "INTERNSHIP";
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
