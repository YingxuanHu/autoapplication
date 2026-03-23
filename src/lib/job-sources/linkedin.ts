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

const LINKEDIN_API_HOST = "linkedin-data-api.p.rapidapi.com";
const DEFAULT_MAX_PAGES = 25;
const HARD_MAX_PAGES = 50;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

interface LinkedInJob {
  id?: string;
  title?: string;
  company?: string | { name?: string; logo?: string; url?: string };
  companyName?: string;
  companyLogo?: string;
  location?: string;
  type?: string;
  postDate?: string;
  postedAt?: string;
  publishedAt?: string;
  description?: string;
  url?: string;
  jobUrl?: string;
  applyUrl?: string;
  salary?: string;
  salaryRange?: { min?: number; max?: number; currency?: string };
  workRemoteAllowed?: boolean;
  formattedWorkType?: string;
  listedAt?: number;
}

interface LinkedInSearchResponse {
  data?: LinkedInJob[];
  jobs?: LinkedInJob[];
  results?: LinkedInJob[];
  success?: boolean;
  total?: number;
  count?: number;
  paging?: {
    total?: number;
    start?: number;
    count?: number;
  };
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.LINKEDIN_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function getApiHost(): string {
  return process.env.LINKEDIN_RAPIDAPI_HOST?.trim() || LINKEDIN_API_HOST;
}

function resolveCompanyName(job: LinkedInJob): string {
  if (job.companyName) return job.companyName;
  if (typeof job.company === "string") return job.company;
  if (typeof job.company === "object" && job.company?.name) return job.company.name;
  return "Unknown Company";
}

function resolveCompanyLogo(job: LinkedInJob): string | undefined {
  if (job.companyLogo) return job.companyLogo;
  if (typeof job.company === "object" && job.company?.logo) return job.company.logo;
  return undefined;
}

function resolveJobUrl(job: LinkedInJob): string {
  return (
    job.url ??
    job.jobUrl ??
    (job.id ? `https://www.linkedin.com/jobs/view/${job.id}` : "")
  );
}

function resolvePostedAt(job: LinkedInJob): Date | undefined {
  const raw = job.postDate ?? job.postedAt ?? job.publishedAt;
  if (raw) return new Date(raw);
  if (job.listedAt) return new Date(job.listedAt);
  return undefined;
}

function resolveSalary(job: LinkedInJob): {
  min?: number;
  max?: number;
  currency?: string;
} {
  if (job.salaryRange) {
    return {
      min: job.salaryRange.min,
      max: job.salaryRange.max,
      currency: job.salaryRange.currency,
    };
  }
  if (job.salary) {
    const matches = [...job.salary.matchAll(/(\d[\d,]*)/g)]
      .map((m) => Number.parseInt(m[1].replace(/,/g, ""), 10))
      .filter((v) => Number.isFinite(v));
    return {
      min: matches[0],
      max: matches[1],
      currency: job.salary.includes("$") ? "USD" : undefined,
    };
  }
  return {};
}

function resolveWorkMode(
  job: LinkedInJob,
  description: string,
): "REMOTE" | "HYBRID" | "ONSITE" | undefined {
  if (job.workRemoteAllowed) return "REMOTE";
  const formattedType = job.formattedWorkType?.toLowerCase() ?? "";
  if (formattedType.includes("remote")) return "REMOTE";
  if (formattedType.includes("hybrid")) return "HYBRID";
  if (formattedType.includes("on-site") || formattedType.includes("onsite")) return "ONSITE";
  return inferWorkMode(job.location, description, job.type);
}

async function fetchPage(
  apiKey: string,
  query: string,
  location: string,
  start: number,
): Promise<LinkedInJob[]> {
  const host = getApiHost();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<LinkedInSearchResponse>(
        `https://${host}/search-jobs-v2`,
        {
          headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": host,
          },
          params: {
            keywords: query,
            locationId: undefined,
            location,
            datePosted: "pastMonth",
            sort: "mostRelevant",
            start,
          },
          timeout: getRequestTimeoutMs(15_000),
        },
      );

      const data = response.data;
      return data.data ?? data.jobs ?? data.results ?? [];
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[LinkedIn] Page start=${start} attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`,
          error instanceof Error ? error.message : error,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }
  return [];
}

export const linkedinAdapter: JobSourceAdapter = {
  source: "LINKEDIN",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const apiKey = process.env.RAPIDAPI_KEY?.trim();
    if (!apiKey) return [];

    const maxPages = getMaxPages();
    const location = params.location?.trim() || "United States";
    const allJobs: NormalizedJob[] = [];
    const pageSize = 25; // LinkedIn pagination typically uses 25

    try {
      for (let page = 0; page < maxPages; page++) {
        const start = page * pageSize;
        const jobs = await fetchPage(apiKey, params.query, location, start);

        if (jobs.length === 0) break;

        const normalized = jobs.map((job): NormalizedJob => {
          const rawDescription = htmlToPlainText(job.description ?? "");
          const salary = resolveSalary(job);

          return {
            externalId: `linkedin-${job.id ?? String(start + Math.random())}`,
            source: "LINKEDIN",
            title: job.title ?? "",
            company: resolveCompanyName(job),
            companyLogo: resolveCompanyLogo(job),
            location: job.location ?? location,
            workMode: resolveWorkMode(job, rawDescription),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            description: rawDescription,
            summary: summarizeText(rawDescription),
            url: resolveJobUrl(job),
            applyUrl: job.applyUrl ?? resolveJobUrl(job),
            postedAt: resolvePostedAt(job),
            skills: extractSkills(rawDescription),
            jobType: job.type ?? job.formattedWorkType ?? undefined,
          };
        });

        allJobs.push(...normalized.filter((j) => j.externalId && j.title));

        // If we got fewer results than page size, we're at the end
        if (jobs.length < pageSize) break;
      }

      return allJobs.filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "[LinkedIn] RapidAPI error:",
        error instanceof Error ? error.message : error,
      );
      return allJobs.filter((job) => matchesJobSearch(job, params));
    }
  },
};
