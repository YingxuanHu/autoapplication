import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const HIMALAYAS_API_BASE = "https://himalayas.app/jobs/api";
const DEFAULT_MAX_PAGES = 20;
const HARD_MAX_PAGES = 50;
const DEFAULT_ITEMS_PER_PAGE = 50;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

interface HimalayasJob {
  id?: string | number;
  title?: string;
  companyName?: string;
  companyLogo?: string;
  description?: string;
  applicationLink?: string;
  externalUrl?: string;
  pubDate?: string;
  publishedDate?: string;
  location?: string;
  locationRestrictions?: string[];
  categories?: string[];
  tags?: string[];
  seniority?: string;
  salary?: string;
  minSalary?: number;
  maxSalary?: number;
  salaryCurrency?: string;
  slug?: string;
}

interface HimalayasResponse {
  jobs?: HimalayasJob[];
  totalCount?: number;
  offset?: number;
  limit?: number;
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.HIMALAYAS_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function getItemsPerPage(): number {
  const raw = Number.parseInt(process.env.HIMALAYAS_ITEMS_PER_PAGE ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_ITEMS_PER_PAGE;
  return raw;
}

function isNorthAmericaFriendly(
  location: string | undefined,
  restrictions: string[] | undefined,
): boolean {
  // No restrictions means worldwide
  if (!restrictions || restrictions.length === 0) return true;

  const allValues = [...restrictions, location ?? ""].join(" ").toLowerCase();
  return /united states|usa|u\.s\.|canada|north america|americas|worldwide|anywhere|global|remote/i.test(
    allValues,
  );
}

async function fetchPage(offset: number, limit: number): Promise<HimalayasResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<HimalayasResponse>(HIMALAYAS_API_BASE, {
        params: { offset, limit },
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
          `[Himalayas] Offset ${offset} attempt ${attempt + 1} failed, retrying...`,
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

export const himalayasAdapter: JobSourceAdapter = {
  source: "HIMALAYAS",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const maxPages = getMaxPages();
    const itemsPerPage = getItemsPerPage();
    const allJobs: NormalizedJob[] = [];

    try {
      for (let page = 0; page < maxPages; page++) {
        const offset = page * itemsPerPage;
        const response = await fetchPage(offset, itemsPerPage);
        const jobs = response.jobs ?? [];

        if (jobs.length === 0) break;

        const normalized = jobs
          .filter((job) =>
            isNorthAmericaFriendly(job.location, job.locationRestrictions),
          )
          .map((job): NormalizedJob => {
            const rawDescription = htmlToPlainText(job.description ?? "");
            const tags = job.tags ?? [];
            const categories = job.categories ?? [];

            return {
              externalId: `himalayas-${String(job.id ?? job.slug ?? "")}`,
              source: "HIMALAYAS",
              title: job.title ?? "",
              company: job.companyName ?? "Unknown Company",
              companyLogo: job.companyLogo ?? undefined,
              location: job.location || "Remote",
              workMode: "REMOTE",
              salaryMin: job.minSalary ?? undefined,
              salaryMax: job.maxSalary ?? undefined,
              salaryCurrency: job.salaryCurrency ?? (job.minSalary || job.maxSalary ? "USD" : undefined),
              description: rawDescription,
              summary: summarizeText(rawDescription),
              url:
                job.externalUrl ??
                job.applicationLink ??
                `https://himalayas.app/jobs/${job.slug ?? job.id ?? ""}`,
              applyUrl: job.applicationLink ?? job.externalUrl ?? undefined,
              postedAt: (job.pubDate ?? job.publishedDate)
                ? new Date(job.pubDate ?? job.publishedDate ?? "")
                : undefined,
              skills: [
                ...new Set([
                  ...tags.map((t) => t.toLowerCase()),
                  ...categories.map((c) => c.toLowerCase()),
                  ...extractSkills(rawDescription),
                ]),
              ],
              jobType: job.seniority || categories.join(", ") || undefined,
            };
          })
          .filter((job) => job.externalId && job.title);

        allJobs.push(...normalized);

        // Stop if we got fewer items than requested (last page)
        if (jobs.length < itemsPerPage) break;

        // Stop if we've fetched all available jobs
        const totalCount = response.totalCount ?? 0;
        if (totalCount > 0 && offset + jobs.length >= totalCount) break;
      }

      return allJobs.filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "[Himalayas] API error:",
        error instanceof Error ? error.message : error,
      );
      return allJobs.filter((job) => matchesJobSearch(job, params));
    }
  },
};
