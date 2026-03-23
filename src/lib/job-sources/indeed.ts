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

const INDEED_API_HOST = "indeed12.p.rapidapi.com";
const DEFAULT_MAX_PAGES = 15;
const HARD_MAX_PAGES = 30;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

interface IndeedJob {
  id?: string;
  job_id?: string;
  title?: string;
  company_name?: string;
  company?: string;
  company_logo?: string;
  location?: string;
  locality?: string;
  description?: string;
  salary?: string;
  salary_min?: number;
  salary_max?: number;
  salary_type?: string;
  job_type?: string;
  employment_type?: string;
  date_posted?: string;
  formatted_relative_time?: string;
  link?: string;
  url?: string;
  apply_link?: string;
  remote?: boolean;
  is_remote?: boolean;
}

interface IndeedSearchResponse {
  hits?: IndeedJob[];
  results?: IndeedJob[];
  jobs?: IndeedJob[];
  data?: IndeedJob[];
  total?: number;
  totalResults?: number;
  hasMore?: boolean;
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.INDEED_MAX_PAGES ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(raw, HARD_MAX_PAGES);
}

function getApiHost(): string {
  return process.env.INDEED_RAPIDAPI_HOST?.trim() || INDEED_API_HOST;
}

function resolveJobId(job: IndeedJob): string {
  return job.id ?? job.job_id ?? "";
}

function resolveJobUrl(job: IndeedJob): string {
  const id = resolveJobId(job);
  return (
    job.link ??
    job.url ??
    job.apply_link ??
    (id ? `https://www.indeed.com/viewjob?jk=${id}` : "")
  );
}

function resolveSalary(job: IndeedJob): {
  min?: number;
  max?: number;
  currency?: string;
} {
  if (job.salary_min || job.salary_max) {
    return {
      min: job.salary_min,
      max: job.salary_max,
      currency: "USD",
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
  job: IndeedJob,
  description: string,
): "REMOTE" | "HYBRID" | "ONSITE" | undefined {
  if (job.remote || job.is_remote) return "REMOTE";
  return inferWorkMode(job.location, description, job.job_type, job.employment_type);
}

async function fetchPage(
  apiKey: string,
  query: string,
  location: string,
  page: number,
): Promise<IndeedJob[]> {
  const host = getApiHost();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<IndeedSearchResponse>(
        `https://${host}/jobs/search`,
        {
          headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": host,
          },
          params: {
            query,
            location,
            page: String(page),
            num_pages: "1",
            date_posted: "month",
            remote_jobs_only: "false",
            employment_types: undefined,
            country: "us",
          },
          timeout: getRequestTimeoutMs(15_000),
        },
      );

      const data = response.data;
      return data.hits ?? data.results ?? data.jobs ?? data.data ?? [];
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[Indeed] Page ${page} attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`,
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

export const indeedAdapter: JobSourceAdapter = {
  source: "INDEED",

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
          const rawDescription = htmlToPlainText(job.description ?? "");
          const salary = resolveSalary(job);

          return {
            externalId: `indeed-${resolveJobId(job) || String(page * 100 + Math.random())}`,
            source: "INDEED",
            title: job.title ?? "",
            company: job.company_name ?? job.company ?? "Unknown Company",
            companyLogo: job.company_logo ?? undefined,
            location: job.location ?? job.locality ?? location,
            workMode: resolveWorkMode(job, rawDescription),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            description: rawDescription,
            summary: summarizeText(rawDescription),
            url: resolveJobUrl(job),
            applyUrl: job.apply_link ?? resolveJobUrl(job),
            postedAt: job.date_posted ? new Date(job.date_posted) : undefined,
            skills: extractSkills(rawDescription),
            jobType: job.job_type ?? job.employment_type ?? undefined,
          };
        });

        allJobs.push(...normalized.filter((j) => j.externalId && j.title));
      }

      return allJobs.filter((job) => matchesJobSearch(job, params));
    } catch (error) {
      console.error(
        "[Indeed] RapidAPI error:",
        error instanceof Error ? error.message : error,
      );
      return allJobs.filter((job) => matchesJobSearch(job, params));
    }
  },
};
