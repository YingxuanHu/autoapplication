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

const GLASSDOOR_API_HOST = "glassdoor-real-time.p.rapidapi.com";
const DEFAULT_MAX_PAGES = 15;
const HARD_MAX_PAGES = 30;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

interface GlassdoorJob {
  id?: string;
  job_id?: string;
  jobId?: string;
  title?: string;
  job_title?: string;
  employer?: string;
  company?: string;
  company_name?: string;
  employer_name?: string;
  company_logo?: string;
  employer_logo?: string;
  location?: string;
  job_location?: string;
  description?: string;
  job_description?: string;
  salary_min?: number;
  salary_max?: number;
  salary?: string;
  estimated_salary?: { min?: number; max?: number; currency?: string };
  job_type?: string;
  employment_type?: string;
  date_posted?: string;
  posted_date?: string;
  listing_age?: string;
  url?: string;
  job_url?: string;
  apply_url?: string;
  remote?: boolean;
  is_remote?: boolean;
  work_from_home?: boolean;
}

interface GlassdoorSearchResponse {
  data?: GlassdoorJob[];
  jobs?: GlassdoorJob[];
  results?: GlassdoorJob[];
  total?: number;
  totalJobCount?: number;
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.GLASSDOOR_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function getApiHost(): string {
  return process.env.GLASSDOOR_RAPIDAPI_HOST?.trim() || GLASSDOOR_API_HOST;
}

function resolveJobId(job: GlassdoorJob): string {
  return job.id ?? job.job_id ?? job.jobId ?? "";
}

function resolveTitle(job: GlassdoorJob): string {
  return job.title ?? job.job_title ?? "";
}

function resolveCompany(job: GlassdoorJob): string {
  return (
    job.employer ??
    job.company ??
    job.company_name ??
    job.employer_name ??
    "Unknown Company"
  );
}

function resolveCompanyLogo(job: GlassdoorJob): string | undefined {
  return job.company_logo ?? job.employer_logo ?? undefined;
}

function resolveLocation(job: GlassdoorJob): string | undefined {
  return job.location ?? job.job_location ?? undefined;
}

function resolveDescription(job: GlassdoorJob): string {
  return htmlToPlainText(job.description ?? job.job_description ?? "");
}

function resolveJobUrl(job: GlassdoorJob): string {
  const id = resolveJobId(job);
  return (
    job.url ??
    job.job_url ??
    job.apply_url ??
    (id ? `https://www.glassdoor.com/job-listing/j?jl=${id}` : "")
  );
}

function resolveSalary(job: GlassdoorJob): {
  min?: number;
  max?: number;
  currency?: string;
} {
  if (job.estimated_salary) {
    return {
      min: job.estimated_salary.min,
      max: job.estimated_salary.max,
      currency: job.estimated_salary.currency ?? "USD",
    };
  }
  if (job.salary_min || job.salary_max) {
    return { min: job.salary_min, max: job.salary_max, currency: "USD" };
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
  job: GlassdoorJob,
  description: string,
): "REMOTE" | "HYBRID" | "ONSITE" | undefined {
  if (job.remote || job.is_remote || job.work_from_home) return "REMOTE";
  return inferWorkMode(resolveLocation(job), description, job.job_type);
}

function resolvePostedAt(job: GlassdoorJob): Date | undefined {
  const raw = job.date_posted ?? job.posted_date;
  if (raw) return new Date(raw);
  return undefined;
}

async function fetchPage(
  apiKey: string,
  query: string,
  location: string,
  page: number,
): Promise<GlassdoorJob[]> {
  const host = getApiHost();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<GlassdoorSearchResponse>(
        `https://${host}/search-jobs`,
        {
          headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": host,
          },
          params: {
            query,
            location,
            page: String(page),
          },
          timeout: getRequestTimeoutMs(15_000),
        },
      );

      const data = response.data;
      return data.data ?? data.jobs ?? data.results ?? [];
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[Glassdoor] Page ${page} attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`,
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

export const glassdoorAdapter: JobSourceAdapter = {
  source: "GLASSDOOR",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const apiKey = process.env.RAPIDAPI_KEY?.trim();
    if (!apiKey) return [];

    const maxPages = getMaxPages();
    const location = params.location?.trim() || "United States";
    const allJobs: NormalizedJob[] = [];

    try {
      for (let page = 1; page <= maxPages; page++) {
        const jobs = await fetchPage(apiKey, params.query, location, page);

        if (jobs.length === 0) break;

        const normalized = jobs.map((job): NormalizedJob => {
          const description = resolveDescription(job);
          const salary = resolveSalary(job);

          return {
            externalId: `glassdoor-${resolveJobId(job) || String(page * 100 + Math.random())}`,
            source: "GLASSDOOR",
            title: resolveTitle(job),
            company: resolveCompany(job),
            companyLogo: resolveCompanyLogo(job),
            location: resolveLocation(job) ?? location,
            workMode: resolveWorkMode(job, description),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            description,
            summary: summarizeText(description),
            url: resolveJobUrl(job),
            applyUrl: job.apply_url ?? resolveJobUrl(job),
            postedAt: resolvePostedAt(job),
            skills: extractSkills(description),
            jobType: job.job_type ?? job.employment_type ?? undefined,
          };
        });

        allJobs.push(...normalized.filter((j) => j.externalId && j.title));
      }

      return allJobs.filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "[Glassdoor] RapidAPI error:",
        error instanceof Error ? error.message : error,
      );
      return allJobs.filter((job) => matchesJobSearch(job, params));
    }
  },
};
