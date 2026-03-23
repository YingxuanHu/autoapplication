import axios from "axios";
import type { CompanySource } from "@/generated/prisma";
import type { NormalizedJob } from "@/types/index";
import {
  extractSkills,
  htmlToPlainText,
  inferWorkMode,
  summarizeText,
} from "@/lib/job-sources/utils";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 15_000;

interface WorkableJob {
  id?: string;
  shortcode?: string;
  title?: string;
  department?: string;
  url?: string;
  application_url?: string;
  shortlink?: string;
  location?: {
    location_str?: string;
    city?: string;
    region?: string;
    country?: string;
    telecommuting?: boolean;
  };
  employment_type?: string;
  description?: string;
  created_at?: string;
}

interface WorkableWidgetResponse {
  jobs?: WorkableJob[];
}

type WorkableApiResponse = WorkableWidgetResponse | WorkableJob[];

/**
 * Fetch jobs from a Workable career page.
 *
 * Tries the public widget API first:
 *   GET https://apply.workable.com/api/v1/widget/accounts/{company_id}
 *
 * Falls back to scraping the career page at:
 *   https://{company}.workable.com/
 */
export async function fetchWorkableJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  if (source.sourceUrl.includes("/api/jobs")) {
    try {
      return await fetchViaCustomApiEndpoint(source.sourceUrl, companyName);
    } catch {
      // Fall through to token-based handling below.
    }
  }

  const token = source.boardToken;
  if (!token) return [];

  try {
    return await fetchViaWidgetAPI(token, companyName);
  } catch {
    // Widget API failed, try the career page jobs endpoint
    try {
      return await fetchViaCareerPage(token, companyName);
    } catch {
      return [];
    }
  }
}

async function fetchViaCustomApiEndpoint(
  sourceUrl: string,
  companyName: string,
): Promise<NormalizedJob[]> {
  const response = await axios.get<WorkableApiResponse>(sourceUrl, {
    timeout: REQUEST_TIMEOUT,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  const data = response.data;
  const jobs = Array.isArray(data) ? data : (data.jobs ?? []);

  return jobs.map((job) =>
    mapWorkableJob(job, companyName.toLowerCase().replace(/\s+/g, "-"), companyName),
  );
}

async function fetchViaWidgetAPI(
  companyId: string,
  companyName: string,
): Promise<NormalizedJob[]> {
  const response = await axios.get<WorkableWidgetResponse>(
    `https://apply.workable.com/api/v1/widget/accounts/${companyId}`,
    {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
    },
  );

  const jobs = response.data.jobs ?? [];
  return jobs.map((job) => mapWorkableJob(job, companyId, companyName));
}

async function fetchViaCareerPage(
  companyId: string,
  companyName: string,
): Promise<NormalizedJob[]> {
  const response = await axios.get<WorkableWidgetResponse>(
    `https://apply.workable.com/api/v3/accounts/${companyId}/jobs`,
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    },
  );

  const jobs = response.data.jobs ?? [];
  return jobs.map((job) => mapWorkableJob(job, companyId, companyName));
}

function mapWorkableJob(
  job: WorkableJob,
  companyId: string,
  companyName: string,
): NormalizedJob {
  const descriptionHtml = job.description ?? "";
  const description = htmlToPlainText(descriptionHtml);

  const locationParts = [
    job.location?.city,
    job.location?.region,
    job.location?.country,
  ].filter(Boolean);
  const location =
    job.location?.location_str ||
    (locationParts.length > 0
      ? locationParts.join(", ")
      : job.location?.telecommuting
        ? "Remote"
        : undefined);

  const workMode = job.location?.telecommuting
    ? "REMOTE" as const
    : inferWorkMode(location, description);

  const jobId = job.shortcode || job.id || job.title || "";
  const applyUrl =
    job.application_url ||
    job.shortlink ||
    job.url ||
    `https://apply.workable.com/${companyId}/j/${jobId}/`;

  return {
    externalId: `${companyId}:${jobId}`,
    source: "WORKABLE",
    title: job.title ?? "",
    company: companyName,
    location,
    workMode,
    description,
    summary: summarizeText(descriptionHtml),
    url: job.url || applyUrl,
    applyUrl,
    postedAt: job.created_at ? new Date(job.created_at) : undefined,
    skills: extractSkills(description),
    jobType: job.employment_type ?? undefined,
  };
}
