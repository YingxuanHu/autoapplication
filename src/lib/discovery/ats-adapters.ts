import axios from "axios";
import type { CompanySource } from "@/generated/prisma";
import type { NormalizedJob } from "@/types/index";
import {
  extractSkills,
  getRequestTimeoutMs,
  htmlToPlainText,
  inferWorkMode,
  summarizeText,
} from "@/lib/job-sources/utils";
import { crawlCustomCareerPage } from "./custom-crawler";
import { parseJobPostings } from "./structured-data-parser";
import { normalizeJob } from "./normalizer";
import { fetchWorkableJobs } from "./connectors/workable";
import { fetchWorkdayJobs } from "./connectors/workday";
import { fetchTeamtailorJobs } from "./connectors/teamtailor";
import { fetchRecruiteeJobs } from "./connectors/recruitee";

const GREENHOUSE_API_BASE = "https://boards-api.greenhouse.io/v1";
const REQUEST_TIMEOUT_MS = getRequestTimeoutMs();

interface GreenhouseJob {
  id: number;
  title?: string;
  updated_at?: string;
  location?: { name?: string };
  absolute_url?: string;
  content?: string;
}

interface LeverPosting {
  id: string;
  text?: string;
  categories?: { location?: string; commitment?: string };
  descriptionPlain?: string;
  openingPlain?: string;
  descriptionBodyPlain?: string;
  additionalPlain?: string;
  description?: string;
  hostedUrl?: string;
  applyUrl?: string;
  workplaceType?: "unspecified" | "on-site" | "remote" | "hybrid";
  salaryRange?: { currency?: string; min?: number; max?: number };
}

interface AshbyJob {
  title?: string;
  location?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  employmentType?: string;
  workplaceType?: "OnSite" | "Remote" | "Hybrid";
  jobUrl?: string;
  applyUrl?: string;
  isListed?: boolean;
  compensation?: {
    summaryComponents?: Array<{
      compensationType?: string;
      minValue?: number | null;
      maxValue?: number | null;
      currencyCode?: string | null;
    }>;
  };
}

interface SmartRecruitersPostingSummary {
  id: string;
  name?: string;
  company?: { name?: string };
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  typeOfEmployment?: { label?: string };
}

interface SmartRecruitersPostingDetail extends SmartRecruitersPostingSummary {
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

/**
 * Fetch jobs from a CompanySource based on its atsType.
 * Routes to the correct adapter for known ATS types, or uses
 * custom crawler / structured data parser for others.
 */
export async function fetchJobsFromSource(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  if (shouldFallbackToCustomCrawler(source)) {
    return fetchCustomCrawlerJobs(source, companyName);
  }

  switch (source.atsType) {
    case "GREENHOUSE":
      return fetchGreenhouseJobs(source, companyName);
    case "LEVER":
      return fetchLeverJobs(source, companyName);
    case "ASHBY":
      return fetchAshbyJobs(source, companyName);
    case "SMARTRECRUITERS":
      return fetchSmartRecruitersJobs(source, companyName);
    case "WORKABLE":
      return fetchWorkableJobs(source, companyName);
    case "WORKDAY":
      return fetchWorkdayJobs(source, companyName);
    case "TEAMTAILOR":
      return fetchTeamtailorJobs(source, companyName);
    case "RECRUITEE":
      return fetchRecruiteeJobs(source, companyName);
    case "CUSTOM_SITE":
    case "UNKNOWN":
    case null:
      if (source.sourceType === "STRUCTURED_DATA") {
        return fetchStructuredDataJobs(source, companyName);
      }
      return fetchCustomCrawlerJobs(source, companyName);
    default:
      return fetchCustomCrawlerJobs(source, companyName);
  }
}

function shouldFallbackToCustomCrawler(source: CompanySource): boolean {
  if (!source.atsType || source.atsType === "CUSTOM_SITE" || source.atsType === "UNKNOWN") {
    return false;
  }

  if (source.atsType === "WORKABLE" && source.sourceUrl.includes("/api/jobs")) {
    return false;
  }

  if (source.boardToken) {
    return false;
  }

  const hostname = getHostname(source.sourceUrl);
  if (!hostname) {
    return true;
  }

  switch (source.atsType) {
    case "GREENHOUSE":
      return !hostname.endsWith("greenhouse.io");
    case "LEVER":
      return !hostname.endsWith("lever.co");
    case "ASHBY":
      return !hostname.endsWith("ashbyhq.com");
    case "SMARTRECRUITERS":
      return !hostname.endsWith("smartrecruiters.com");
    case "WORKABLE":
      return !hostname.endsWith("workable.com");
    case "WORKDAY":
      return !hostname.includes("myworkdayjobs.com");
    case "TEAMTAILOR":
      return !hostname.endsWith("teamtailor.com");
    case "RECRUITEE":
      return !hostname.endsWith("recruitee.com");
    default:
      return true;
  }
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function fetchGreenhouseJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const token = source.boardToken;
  if (!token) return [];

  const response = await axios.get<{ jobs?: GreenhouseJob[] }>(
    `${GREENHOUSE_API_BASE}/boards/${token}/jobs`,
    { params: { content: true }, timeout: REQUEST_TIMEOUT_MS },
  );

  const jobs = response.data.jobs ?? [];

  return jobs.map((job): NormalizedJob => {
    const descriptionHtml = job.content ?? "";
    const description = htmlToPlainText(descriptionHtml);
    const location = job.location?.name ?? undefined;

    return {
      externalId: `${token}:${job.id}`,
      source: "GREENHOUSE",
      title: job.title ?? "",
      company: companyName,
      location,
      workMode: inferWorkMode(location, description),
      description,
      summary: summarizeText(descriptionHtml),
      url: job.absolute_url ?? "",
      applyUrl: job.absolute_url ?? undefined,
      postedAt: job.updated_at ? new Date(job.updated_at) : undefined,
      skills: extractSkills(description),
    };
  });
}

async function fetchLeverJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const token = source.boardToken;
  if (!token) return [];

  // Determine if EU or global based on source URL
  const isEU = source.sourceUrl.includes(".eu.lever.co") || source.sourceUrl.includes("eu.lever");
  const baseUrl = isEU ? "https://api.eu.lever.co" : "https://api.lever.co";

  const response = await axios.get<LeverPosting[]>(
    `${baseUrl}/v0/postings/${token}`,
    { params: { mode: "json" }, timeout: REQUEST_TIMEOUT_MS },
  );

  const postings = Array.isArray(response.data) ? response.data : [];

  return postings.map((posting): NormalizedJob => {
    const description = htmlToPlainText(
      posting.descriptionPlain ||
        [posting.openingPlain, posting.descriptionBodyPlain, posting.additionalPlain]
          .filter(Boolean)
          .join("\n\n") ||
        posting.description ||
        "",
    );
    const location = posting.categories?.location ?? undefined;

    let workMode: NormalizedJob["workMode"];
    switch (posting.workplaceType) {
      case "remote": workMode = "REMOTE"; break;
      case "hybrid": workMode = "HYBRID"; break;
      case "on-site": workMode = "ONSITE"; break;
      default: workMode = inferWorkMode(location, description);
    }

    return {
      externalId: `${token}:${posting.id}`,
      source: "LEVER",
      title: posting.text ?? "",
      company: companyName,
      location,
      workMode,
      salaryMin: posting.salaryRange?.min,
      salaryMax: posting.salaryRange?.max,
      salaryCurrency: posting.salaryRange?.currency,
      description,
      summary: summarizeText(description),
      url: posting.hostedUrl ?? posting.applyUrl ?? "",
      applyUrl: posting.applyUrl ?? undefined,
      skills: extractSkills(description),
      jobType: posting.categories?.commitment ?? undefined,
    };
  });
}

async function fetchAshbyJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const token = source.boardToken;
  if (!token) return [];

  const response = await axios.get<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    { params: { includeCompensation: true }, timeout: REQUEST_TIMEOUT_MS },
  );

  const jobs = (response.data.jobs ?? []).filter((j) => j.isListed !== false);

  return jobs.map((job): NormalizedJob => {
    const description = htmlToPlainText(job.descriptionPlain || job.descriptionHtml || "");

    const salary = job.compensation?.summaryComponents?.find(
      (c) => c.compensationType === "Salary",
    );

    let workMode: NormalizedJob["workMode"];
    switch (job.workplaceType) {
      case "Remote": workMode = "REMOTE"; break;
      case "Hybrid": workMode = "HYBRID"; break;
      case "OnSite": workMode = "ONSITE"; break;
      default: workMode = undefined;
    }

    return {
      externalId: `${token}:${job.jobUrl ?? job.applyUrl ?? job.title ?? ""}`,
      source: "ASHBY",
      title: job.title ?? "",
      company: companyName,
      location: job.location ?? undefined,
      workMode,
      salaryMin: salary?.minValue ?? undefined,
      salaryMax: salary?.maxValue ?? undefined,
      salaryCurrency: salary?.currencyCode ?? undefined,
      description,
      summary: summarizeText(job.descriptionPlain || job.descriptionHtml || ""),
      url: job.jobUrl ?? job.applyUrl ?? "",
      applyUrl: job.applyUrl ?? undefined,
      postedAt: job.publishedAt ? new Date(job.publishedAt) : undefined,
      skills: extractSkills(description),
      jobType: job.employmentType ?? undefined,
    };
  });
}

async function fetchSmartRecruitersJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const token = source.boardToken;
  if (!token) return [];

  const listResponse = await axios.get<{ content?: SmartRecruitersPostingSummary[] }>(
    `https://api.smartrecruiters.com/v1/companies/${token}/postings`,
    { params: { limit: 100, offset: 0 }, timeout: REQUEST_TIMEOUT_MS },
  );

  const summaries = listResponse.data.content ?? [];
  const jobs: NormalizedJob[] = [];

  const detailResults = await Promise.allSettled(
    summaries.map((posting) =>
      axios.get<SmartRecruitersPostingDetail>(
        `https://api.smartrecruiters.com/v1/companies/${token}/postings/${posting.id}`,
        { timeout: REQUEST_TIMEOUT_MS },
      ),
    ),
  );

  for (let i = 0; i < detailResults.length; i++) {
    const detailResult = detailResults[i];
    if (!detailResult || detailResult.status !== "fulfilled") continue;

    const detail = detailResult.value.data;
    const summary = summaries[i];

    const locationParts = [
      detail.location?.city,
      detail.location?.region,
      detail.location?.country,
    ].filter(Boolean);
    const location = locationParts.length > 0
      ? locationParts.join(", ")
      : detail.location?.remote ? "Remote" : undefined;

    const sections = detail.jobAd?.sections;
    const description = sections
      ? htmlToPlainText(
          Object.values(sections)
            .map((s) => s.text ?? "")
            .filter(Boolean)
            .join("\n\n"),
        )
      : "";

    jobs.push({
      externalId: `${token}:${detail.id}`,
      source: "SMARTRECRUITERS",
      title: detail.name ?? summary?.name ?? "",
      company: detail.company?.name || summary?.company?.name || companyName,
      location,
      workMode: detail.location?.remote === true
        ? "REMOTE"
        : inferWorkMode(location, description),
      description,
      summary: summarizeText(description),
      url: detail.applyUrl ?? "",
      applyUrl: detail.applyUrl ?? undefined,
      postedAt: detail.releasedDate
        ? new Date(detail.releasedDate)
        : summary?.releasedDate
          ? new Date(summary.releasedDate)
          : undefined,
      skills: extractSkills(description),
      jobType: detail.typeOfEmployment?.label ?? summary?.typeOfEmployment?.label ?? undefined,
    });
  }

  return jobs;
}

async function fetchCustomCrawlerJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const crawled = await crawlCustomCareerPage(source.sourceUrl);

  return crawled.map((job) =>
    normalizeJob(
      {
        title: job.title,
        company: companyName,
        location: job.location ?? undefined,
        description: job.description,
        url: job.url,
        applyUrl: job.applyUrl ?? undefined,
        skills: extractSkills(job.description),
      },
      "COMPANY_SITE",
      "CAREER_PAGE",
    ),
  );
}

async function fetchStructuredDataJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const postings = await parseJobPostings(source.sourceUrl);

  return postings.map((posting) =>
    normalizeJob(
      {
        title: posting.title,
        company: posting.company || companyName,
        location: posting.location,
        description: posting.description,
        url: posting.applyUrl,
        applyUrl: posting.applyUrl,
        salaryMin: posting.salaryMin ?? undefined,
        salaryMax: posting.salaryMax ?? undefined,
        salaryCurrency: posting.salaryCurrency ?? undefined,
        jobType: posting.employmentType ?? undefined,
        postedAt: posting.datePosted ?? undefined,
        skills: extractSkills(posting.description),
      },
      "STRUCTURED_DATA",
      "STRUCTURED_DATA",
    ),
  );
}
