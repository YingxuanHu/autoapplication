import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  inferWorkMode,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const ARBEITNOW_API_BASE = "https://www.arbeitnow.com/api/job-board-api";
const DEFAULT_MAX_PAGES = 20;
const HARD_MAX_PAGES = 50;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number; // Unix timestamp
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
  links?: {
    next?: string;
  };
  meta?: {
    current_page?: number;
    last_page?: number;
  };
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.ARBEITNOW_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function isNorthAmericaLocation(location: string | undefined, isRemote: boolean): boolean {
  if (isRemote) return true;
  if (!location) return true;
  const lower = location.toLowerCase();
  return (
    /united states|usa|u\.s\.|canada|north america|americas|remote/i.test(lower) ||
    // Common US/CA cities and states
    /new york|san francisco|los angeles|chicago|seattle|austin|boston|denver|toronto|vancouver|montreal/i.test(lower)
  );
}

async function fetchPage(page: number): Promise<ArbeitnowResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<ArbeitnowResponse>(ARBEITNOW_API_BASE, {
        params: { page },
        timeout: getRequestTimeoutMs(10_000),
        headers: {
          Accept: "application/json",
          "User-Agent": "AutoApplicationBot/1.0",
        },
      });
      return response.data;
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[Arbeitnow] Page ${page} attempt ${attempt + 1} failed, retrying...`,
          error instanceof Error ? error.message : error,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }
  return {};
}

export const arbeitnowAdapter: JobSourceAdapter = {
  source: "ARBEITNOW",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const maxPages = getMaxPages();
    const allJobs: NormalizedJob[] = [];

    try {
      for (let page = 1; page <= maxPages; page++) {
        const response = await fetchPage(page);
        const jobs = response.data ?? [];

        if (jobs.length === 0) break;

        const normalized = jobs
          .filter((job) => isNorthAmericaLocation(job.location, job.remote ?? false))
          .map((job): NormalizedJob => {
            const description = htmlToPlainText(job.description ?? "");
            const tags = job.tags ?? [];

            return {
              externalId: `arbeitnow-${job.slug ?? ""}`,
              source: "ARBEITNOW",
              title: job.title ?? "",
              company: job.company_name ?? "Unknown Company",
              location: job.location || (job.remote ? "Remote" : undefined),
              workMode: job.remote ? "REMOTE" : inferWorkMode(job.location, description),
              description,
              summary: summarizeText(description),
              url: job.url ?? `https://www.arbeitnow.com/view/${job.slug ?? ""}`,
              applyUrl: job.url ?? undefined,
              postedAt: job.created_at
                ? new Date(job.created_at * 1000)
                : undefined,
              skills: [
                ...new Set([
                  ...tags.map((t) => t.toLowerCase()),
                  ...extractSkills(description),
                ]),
              ],
              jobType: job.job_types?.join(", ") || undefined,
            };
          })
          .filter((job) => job.externalId && job.title);

        allJobs.push(...normalized);

        // Stop if we've reached the last page
        const lastPage = response.meta?.last_page ?? 1;
        if (page >= lastPage) break;
      }

      return allJobs.filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "[Arbeitnow] API error:",
        error instanceof Error ? error.message : error,
      );
      return allJobs.filter((job) => matchesJobSearch(job, params));
    }
  },
};
