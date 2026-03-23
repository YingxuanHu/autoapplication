import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const REMOTIVE_API_BASE = "https://remotive.com/api/remote-jobs";
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 100;
const STEM_CATEGORY_MAP: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /(machine learning|ml|ai|artificial intelligence)/i, category: "ai-ml" },
  { pattern: /(data scientist|data analyst|analytics|quant|actuarial|operations research)/i, category: "data" },
  { pattern: /(devops|site reliability|sre|platform|cloud|security|qa)/i, category: "devops" },
  { pattern: /(finance|risk)/i, category: "finance" },
  { pattern: /(engineer|developer|software|frontend|backend|full stack)/i, category: "software-development" },
];

interface RemotiveJob {
  id: number;
  url?: string;
  title?: string;
  company_name?: string;
  company_logo?: string;
  category?: string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

function getMaxResults(): number {
  const raw = Number.parseInt(process.env.REMOTIVE_MAX_RESULTS ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(raw, HARD_MAX_RESULTS);
}

function isNorthAmericaFriendly(location: string | undefined, requestedLocation: string | undefined): boolean {
  if (!location) return true;

  const normalizedLocation = location.toLowerCase();
  const normalizedRequest = requestedLocation?.toLowerCase() ?? "";

  if (!normalizedRequest) {
    return true;
  }

  if (normalizedRequest.includes("canada")) {
    return /canada|north america|americas|worldwide|anywhere/.test(normalizedLocation);
  }

  if (normalizedRequest.includes("united states") || normalizedRequest.includes("usa") || normalizedRequest.includes("us")) {
    return /united states|u\.s\.|usa|us timezones|north america|americas|worldwide|anywhere/.test(normalizedLocation);
  }

  return normalizedLocation.includes(normalizedRequest);
}

function resolveCategory(query: string): string | undefined {
  return STEM_CATEGORY_MAP.find((entry) => entry.pattern.test(query))?.category;
}

function normalizeRemoteLocation(location: string | undefined): string | undefined {
  if (!location) return location;

  return location
    .replace(/\bUSA\b/gi, "United States")
    .replace(/\bUS\b/gi, "United States")
    .replace(/\bU\.S\.\b/gi, "United States")
    .replace(/\bUK\b/gi, "United Kingdom");
}

function parseSalaryRange(salary: string | undefined): Pick<NormalizedJob, "salaryMin" | "salaryMax" | "salaryCurrency"> {
  if (!salary) return {};

  const matches = [...salary.matchAll(/(\d[\d,]*)/g)]
    .map((match) => Number.parseInt(match[1].replace(/,/g, ""), 10))
    .filter((value) => Number.isFinite(value));

  const currency = salary.includes("€")
    ? "EUR"
    : salary.includes("£")
      ? "GBP"
      : salary.includes("$")
        ? "USD"
        : undefined;

  return {
    salaryMin: matches[0],
    salaryMax: matches[1],
    salaryCurrency: currency,
  };
}

export const remotiveAdapter: JobSourceAdapter = {
  source: "REMOTIVE",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const response = await axios.get<RemotiveResponse>(REMOTIVE_API_BASE, {
      params: {
        limit: getMaxResults(),
        category: resolveCategory(params.query),
      },
      timeout: getRequestTimeoutMs(),
      headers: {
        Accept: "application/json",
        "User-Agent": "AutoApplicationBot/1.0",
      },
    });

    return (response.data.jobs ?? [])
      .filter((job) =>
        isNorthAmericaFriendly(job.candidate_required_location, params.location),
      )
      .map((job): NormalizedJob => {
        const description = htmlToPlainText(job.description ?? "");
        const salary = parseSalaryRange(job.salary);

        return {
          externalId: String(job.id),
          source: "REMOTIVE",
          title: job.title ?? "",
          company: job.company_name ?? "Unknown Company",
          companyLogo: job.company_logo ?? undefined,
          location: normalizeRemoteLocation(job.candidate_required_location) ?? "Remote",
          workMode: "REMOTE",
          salaryMin: salary.salaryMin,
          salaryMax: salary.salaryMax,
          salaryCurrency: salary.salaryCurrency,
          description,
          summary: summarizeText(job.description ?? description),
          url: job.url ?? "",
          applyUrl: job.url ?? undefined,
          postedAt: job.publication_date ? new Date(job.publication_date) : undefined,
          skills: extractSkills(description),
          jobType: job.job_type || job.category || undefined,
        };
      })
      .filter((job) => matchesJobSearch(job, params));
  },
};
