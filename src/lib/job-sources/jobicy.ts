import axios from "axios";
import type { JobSourceAdapter, JobSearchParams, NormalizedJob } from "./types";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  matchesJobSearch,
  summarizeText,
} from "./utils";

const JOBICY_API_BASE = "https://jobicy.com/api/v2/remote-jobs";
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 100;

interface JobicyJob {
  id: number;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  companyLogo?: string;
  jobIndustry?: string;
  jobType?: string;
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
}

function getMaxResults(): number {
  const raw = Number.parseInt(process.env.JOBICY_MAX_RESULTS ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(raw, HARD_MAX_RESULTS);
}

function resolveGeo(location: string | undefined): string | undefined {
  const normalized = location?.toLowerCase() ?? "";
  if (normalized.includes("canada")) return "canada";
  if (
    normalized.includes("united states") ||
    normalized.includes("usa") ||
    normalized.includes("us")
  ) {
    return "usa";
  }
  return undefined;
}

function resolveIndustry(query: string): string | undefined {
  const normalized = query.toLowerCase();

  if (/(quant|actuarial|finance|risk)/.test(normalized)) {
    return "accounting-finance";
  }

  if (/(data scientist|data analyst|analytics|ml|machine learning|ai)/.test(normalized)) {
    return "data-science";
  }

  if (/(devops|site reliability|sre|platform|cloud|security|engineer|developer|software|frontend|backend|full stack)/.test(normalized)) {
    return "engineering";
  }

  return undefined;
}

function isNorthAmericaFriendly(jobGeo: string | undefined, requestedLocation: string | undefined): boolean {
  if (!jobGeo) return true;

  const normalizedGeo = jobGeo.toLowerCase();
  const normalizedRequest = requestedLocation?.toLowerCase() ?? "";

  if (!normalizedRequest) {
    return /usa|canada|anywhere|worldwide|americas/.test(normalizedGeo);
  }

  if (normalizedRequest.includes("canada")) {
    return /canada|anywhere|worldwide|americas/.test(normalizedGeo);
  }

  if (normalizedRequest.includes("united states") || normalizedRequest.includes("usa") || normalizedRequest.includes("us")) {
    return /usa|united states|anywhere|worldwide|americas/.test(normalizedGeo);
  }

  return normalizedGeo.includes(normalizedRequest);
}

function normalizeJobicyLocation(jobGeo: string | undefined): string | undefined {
  if (!jobGeo) return jobGeo;

  return jobGeo
    .replace(/\bUSA\b/g, "United States")
    .replace(/\bUK\b/g, "United Kingdom");
}

export const jobicyAdapter: JobSourceAdapter = {
  source: "JOBICY",

  async search(params: JobSearchParams): Promise<NormalizedJob[]> {
    const response = await axios.get<JobicyResponse>(JOBICY_API_BASE, {
      params: {
        count: getMaxResults(),
        geo: resolveGeo(params.location),
        industry: resolveIndustry(params.query),
      },
      timeout: getRequestTimeoutMs(),
      headers: {
        Accept: "application/json",
        "User-Agent": "AutoApplicationBot/1.0",
      },
    });

    return (response.data.jobs ?? [])
      .filter((job) => isNorthAmericaFriendly(job.jobGeo, params.location))
      .map((job): NormalizedJob => {
        const description = htmlToPlainText(job.jobDescription ?? "");

        return {
          externalId: String(job.id),
          source: "JOBICY",
          title: job.jobTitle ?? "",
          company: job.companyName ?? "Unknown Company",
          companyLogo: job.companyLogo ?? undefined,
          location: normalizeJobicyLocation(job.jobGeo) ?? "Remote",
          workMode: "REMOTE",
          salaryMin: job.salaryMin ?? undefined,
          salaryMax: job.salaryMax ?? undefined,
          salaryCurrency: job.salaryCurrency ?? undefined,
          description,
          summary: summarizeText(job.jobExcerpt ?? description),
          url: job.url ?? "",
          applyUrl: job.url ?? undefined,
          postedAt: job.pubDate ? new Date(job.pubDate) : undefined,
          skills: extractSkills(description),
          jobType: [job.jobType, job.jobLevel, job.jobIndustry].filter(Boolean).join(" | ") || undefined,
        };
      })
      .filter((job) => matchesJobSearch(job, params));
  },
};
