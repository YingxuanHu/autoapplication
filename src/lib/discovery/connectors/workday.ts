import axios from "axios";
import type { CompanySource } from "@/generated/prisma";
import type { NormalizedJob } from "@/types/index";
import {
  extractSkills,
  inferWorkMode,
  summarizeText,
} from "@/lib/job-sources/utils";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 20_000;
const PAGE_SIZE = 20;
const MAX_PAGES = 25; // Safety cap: 500 jobs max

interface WorkdayJobPosting {
  title?: string;
  bulletFields?: string[];
  locationsText?: string;
  postedOn?: string;
  externalPath?: string;
}

interface WorkdayJobsResponse {
  jobPostings?: WorkdayJobPosting[];
  total?: number;
}

/**
 * Fetch jobs from a Workday career site.
 *
 * Workday uses a JSON API at:
 *   POST https://{company}.wd{N}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs
 *
 * The company slug and site are extracted from the source URL or board token.
 * Supports offset-based pagination (20 per page by default).
 */
export async function fetchWorkdayJobs(
  source: CompanySource,
  companyName: string,
): Promise<NormalizedJob[]> {
  const parsed = parseWorkdaySource(source);
  if (!parsed) return [];

  const { baseUrl, company, site } = parsed;
  const allJobs: NormalizedJob[] = [];
  let offset = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await axios.post<WorkdayJobsResponse>(
        `${baseUrl}/wday/cxs/${company}/${site}/jobs`,
        {
          appliedFacets: {},
          limit: PAGE_SIZE,
          offset,
          searchText: "",
        },
        {
          timeout: REQUEST_TIMEOUT,
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
      );

      const postings = response.data.jobPostings ?? [];
      if (postings.length === 0) break;

      const total = response.data.total ?? 0;

      for (const posting of postings) {
        allJobs.push(mapWorkdayJob(posting, baseUrl, site, companyName));
      }

      offset += PAGE_SIZE;
      if (offset >= total) break;

      // Small delay between pages to be respectful
      await delay(300);
    }
  } catch {
    // Return whatever we've collected so far
  }

  return allJobs;
}

interface ParsedWorkdaySource {
  baseUrl: string;
  company: string;
  site: string;
}

/**
 * Parse the Workday company slug and site from the source URL or board token.
 *
 * Expected URL formats:
 *   https://{company}.wd{N}.myworkdayjobs.com/en-US/{site}
 *   https://{company}.wd5.myworkdayjobs.com/{site}
 *
 * Board token format: "{company}/{site}" or "{company}:wd{N}:{site}"
 */
function parseWorkdaySource(source: CompanySource): ParsedWorkdaySource | null {
  // Try parsing from source URL first
  try {
    const url = new URL(source.sourceUrl);
    const hostname = url.hostname;

    const hostMatch = hostname.match(
      /^([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com$/,
    );
    if (hostMatch) {
      const company = hostMatch[1]!;
      const wdInstance = hostMatch[2]!;
      const baseUrl = `https://${company}.${wdInstance}.myworkdayjobs.com`;

      // Extract site from pathname: /{locale}/{site} or /{site}
      const segments = url.pathname.split("/").filter(Boolean);
      // Skip locale segments like "en-US", "fr-FR"
      const site =
        segments.find((s) => !s.match(/^[a-z]{2}(-[A-Z]{2})?$/)) ||
        segments[segments.length - 1] ||
        "External";

      return { baseUrl, company, site };
    }
  } catch {
    // Fall through to token parsing
  }

  // Try parsing from board token
  const token = source.boardToken;
  if (!token) return null;

  // Format: "company/site"
  if (token.includes("/")) {
    const [company, site] = token.split("/");
    if (company && site) {
      // Default to wd5 if no instance specified
      return {
        baseUrl: `https://${company}.wd5.myworkdayjobs.com`,
        company,
        site,
      };
    }
  }

  // Format: "company:wdN:site"
  const colonParts = token.split(":");
  if (colonParts.length >= 3) {
    const company = colonParts[0]!;
    const wdInstance = colonParts[1]!;
    const site = colonParts[2]!;
    return {
      baseUrl: `https://${company}.${wdInstance}.myworkdayjobs.com`,
      company,
      site,
    };
  }

  return null;
}

function mapWorkdayJob(
  posting: WorkdayJobPosting,
  baseUrl: string,
  site: string,
  companyName: string,
): NormalizedJob {
  const title = posting.title ?? "";
  const location = posting.locationsText ?? undefined;

  // bulletFields often contain location, date, job ID, etc.
  const bulletText = (posting.bulletFields ?? []).join(" ");
  const combinedText = `${title} ${location ?? ""} ${bulletText}`;

  const jobPath = posting.externalPath ?? "";
  const jobUrl = jobPath ? `${baseUrl}${jobPath}` : `${baseUrl}/${site}`;

  return {
    externalId: `workday:${jobPath || title}`,
    source: "WORKDAY",
    title,
    company: companyName,
    location,
    workMode: inferWorkMode(location, combinedText),
    description: combinedText,
    summary: summarizeText(combinedText),
    url: jobUrl,
    applyUrl: jobUrl,
    postedAt: parseWorkdayDate(posting.postedOn),
    skills: extractSkills(combinedText),
  };
}

function parseWorkdayDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
