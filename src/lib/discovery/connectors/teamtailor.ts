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

interface TeamtailorJobLD {
  "@type"?: string;
  title?: string;
  name?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  jobLocation?: {
    "@type"?: string;
    address?: {
      addressLocality?: string;
      addressRegion?: string;
      addressCountry?: string;
    };
  };
  hiringOrganization?: {
    name?: string;
  };
  url?: string;
  directApply?: boolean;
  jobLocationType?: string;
}

interface TeamtailorAPIJob {
  id?: string;
  type?: string;
  links?: { "careersite-job-url"?: string };
  attributes?: {
    title?: string;
    body?: string;
    pitch?: string;
    "employment-type"?: string;
    "remote-status"?: string;
    "created-at"?: string;
  };
  relationships?: {
    department?: { data?: { id?: string } };
    locations?: { data?: Array<{ id?: string }> };
  };
}

interface TeamtailorAPIResponse {
  data?: TeamtailorAPIJob[];
  meta?: { "page-count"?: number; "record-count"?: number };
  links?: { next?: string };
}

/**
 * Fetch jobs from a Teamtailor career site.
 *
 * Strategy:
 *   1. Try the JSON API at {company}.teamtailor.com/jobs
 *   2. Fallback: scrape the career page for JSON-LD structured data (JobPosting schema)
 */
export async function fetchTeamtailorJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const token = source.boardToken;
  const sourceUrl = source.sourceUrl;

  // Strategy 1: Try the Teamtailor API
  if (token) {
    try {
      const jobs = await fetchViaAPI(token, companyName);
      if (jobs.length > 0) return jobs;
    } catch {
      // Fall through
    }
  }

  // Strategy 2: Parse JSON-LD from the career page
  const pageUrl =
    sourceUrl ||
    (token ? `https://${token}.teamtailor.com/jobs` : null);
  if (pageUrl) {
    try {
      return await fetchViaJsonLD(pageUrl, companyName);
    } catch {
      // Fall through
    }
  }

  return [];
}

async function fetchViaAPI(
  companySlug: string,
  companyName: string,
): Promise<NormalizedJob[]> {
  const response = await axios.get<TeamtailorAPIResponse>(
    `https://${companySlug}.teamtailor.com/api/jobs`,
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    },
  );

  const jobs = response.data.data ?? [];
  return jobs.map((job) => mapTeamtailorAPIJob(job, companySlug, companyName));
}

function mapTeamtailorAPIJob(
  job: TeamtailorAPIJob,
  companySlug: string,
  companyName: string,
): NormalizedJob {
  const attrs = job.attributes ?? {};
  const title = attrs.title ?? "";
  const bodyHtml = attrs.body ?? attrs.pitch ?? "";
  const description = htmlToPlainText(bodyHtml);

  let workMode: NormalizedJob["workMode"];
  switch (attrs["remote-status"]) {
    case "fully":
      workMode = "REMOTE";
      break;
    case "hybrid":
      workMode = "HYBRID";
      break;
    case "none":
      workMode = "ONSITE";
      break;
    default:
      workMode = inferWorkMode(undefined, description);
  }

  const jobUrl =
    job.links?.["careersite-job-url"] ||
    `https://${companySlug}.teamtailor.com/jobs/${job.id || ""}`;

  return {
    externalId: `${companySlug}:${job.id || title}`,
    source: "TEAMTAILOR",
    title,
    company: companyName,
    workMode,
    description,
    summary: summarizeText(bodyHtml),
    url: jobUrl,
    applyUrl: jobUrl,
    postedAt: attrs["created-at"] ? new Date(attrs["created-at"]) : undefined,
    skills: extractSkills(description),
    jobType: attrs["employment-type"] ?? undefined,
  };
}

async function fetchViaJsonLD(
  pageUrl: string,
  companyName: string,
): Promise<NormalizedJob[]> {
  const response = await axios.get<string>(pageUrl, {
    timeout: REQUEST_TIMEOUT,
    headers: { "User-Agent": USER_AGENT },
    responseType: "text",
    maxRedirects: 5,
  });

  const html = typeof response.data === "string" ? response.data : "";
  const jsonLdBlocks = extractJsonLD(html);
  const jobs: NormalizedJob[] = [];

  for (const block of jsonLdBlocks) {
    const postings = extractJobPostings(block);
    for (const posting of postings) {
      jobs.push(mapJsonLDJob(posting, pageUrl, companyName));
    }
  }

  return jobs;
}

function extractJsonLD(html: string): unknown[] {
  const regex =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: unknown[] = [];
  let match;

  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1] || "");
      blocks.push(parsed);
    } catch {
      // Skip invalid JSON-LD
    }
  }

  return blocks;
}

function extractJobPostings(data: unknown): TeamtailorJobLD[] {
  if (!data || typeof data !== "object") return [];

  if (Array.isArray(data)) {
    return data.flatMap((item) => extractJobPostings(item));
  }

  const obj = data as Record<string, unknown>;

  if (obj["@type"] === "JobPosting") {
    return [obj as unknown as TeamtailorJobLD];
  }

  // Check @graph
  if (Array.isArray(obj["@graph"])) {
    return (obj["@graph"] as unknown[]).flatMap((item) =>
      extractJobPostings(item),
    );
  }

  return [];
}

function mapJsonLDJob(
  posting: TeamtailorJobLD,
  pageUrl: string,
  companyName: string,
): NormalizedJob {
  const title = posting.title || posting.name || "";
  const descriptionHtml = posting.description ?? "";
  const description = htmlToPlainText(descriptionHtml);

  const locationParts = [
    posting.jobLocation?.address?.addressLocality,
    posting.jobLocation?.address?.addressRegion,
    posting.jobLocation?.address?.addressCountry,
  ].filter(Boolean);
  const location = locationParts.length > 0 ? locationParts.join(", ") : undefined;

  let workMode: NormalizedJob["workMode"];
  if (posting.jobLocationType === "TELECOMMUTE") {
    workMode = "REMOTE";
  } else {
    workMode = inferWorkMode(location, description);
  }

  const company = posting.hiringOrganization?.name || companyName;
  const url = posting.url || pageUrl;

  return {
    externalId: `teamtailor:${url || title}`,
    source: "TEAMTAILOR",
    title,
    company,
    location,
    workMode,
    description,
    summary: summarizeText(descriptionHtml),
    url,
    applyUrl: url,
    postedAt: posting.datePosted ? new Date(posting.datePosted) : undefined,
    skills: extractSkills(description),
    jobType: posting.employmentType ?? undefined,
  };
}
