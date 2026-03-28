/**
 * USAJobs federal government job API connector.
 *
 * USAJobs (data.usajobs.gov/api) provides access to all US federal government
 * job postings. Free API with key. 100% net-new — federal jobs are never on
 * commercial ATS boards.
 *
 * Volume: 60K-80K active postings at any time.
 * Canada: No (US federal only), but critical for US tech/finance coverage.
 *
 * Environment: USAJOBS_API_KEY, USAJOBS_EMAIL
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const USAJOBS_API_BASE = "https://data.usajobs.gov/api/Search";
const USAJOBS_PAGE_SIZE = 250;
const USAJOBS_RATE_DELAY_MS = 1500;

type UsaJobsConnectorOptions = {
  keyword?: string;
  apiKey?: string;
  email?: string;
};

type UsaJobsPosition = {
  PositionID?: string;
  PositionTitle?: string;
  PositionURI?: string;
  PositionLocation?: Array<{
    LocationName?: string;
    CountryCode?: string;
    CityName?: string;
    CountrySubDivisionCode?: string;
  }>;
  OrganizationName?: string;
  DepartmentName?: string;
  JobCategory?: Array<{ Name?: string; Code?: string }>;
  PositionSchedule?: Array<{ Name?: string; Code?: string }>;
  PositionOfferingType?: Array<{ Name?: string; Code?: string }>;
  PositionRemuneration?: Array<{
    MinimumRange?: string;
    MaximumRange?: string;
    RateIntervalCode?: string;
    Description?: string;
  }>;
  QualificationSummary?: string;
  PositionStartDate?: string;
  PositionEndDate?: string;
  PublicationStartDate?: string;
  ApplicationCloseDate?: string;
  UserArea?: {
    Details?: {
      JobSummary?: string;
      MajorDuties?: string[];
      WhoMayApply?: { Name?: string; Code?: string };
      LowGrade?: string;
      HighGrade?: string;
      TeleworkEligible?: boolean;
    };
    IsRadSelection?: boolean;
  };
};

type UsaJobsResult = {
  MatchedObjectId?: string;
  MatchedObjectDescriptor?: UsaJobsPosition;
};

type UsaJobsSearchResponse = {
  SearchResult?: {
    SearchResultCount?: number;
    SearchResultCountAll?: number;
    SearchResultItems?: UsaJobsResult[];
  };
};

// Keywords targeting tech and finance roles in federal government
const DEFAULT_KEYWORDS = [
  "Software Engineer",
  "Software Developer",
  "Data Scientist",
  "Data Engineer",
  "Cloud Engineer",
  "Cybersecurity",
  "Information Technology",
  "IT Specialist",
  "Systems Engineer",
  "DevOps",
  "Machine Learning",
  "Financial Analyst",
  "Economist",
  "Accountant",
  "Budget Analyst",
  "Program Analyst",
  "Management Analyst",
  "Operations Research",
];

export function createUsaJobsConnector(
  options: UsaJobsConnectorOptions = {}
): SourceConnector {
  const apiKey =
    options.apiKey ?? process.env.USAJOBS_API_KEY ?? "";
  const email =
    options.email ?? process.env.USAJOBS_EMAIL ?? "";

  if (!apiKey || !email) {
    throw new Error(
      "USAJobs connector requires USAJOBS_API_KEY and USAJOBS_EMAIL environment variables."
    );
  }

  const keyword = options.keyword ?? "";
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `usajobs:${keyword || "all"}`,
    sourceName: `USAJobs:${keyword || "all"}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(fetchOptions.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchUsaJobsJobs({
        keyword,
        apiKey,
        email,
        now: fetchOptions.now,
        limit: fetchOptions.limit,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

/**
 * Create a batch of USAJobs connectors across multiple keyword searches.
 */
export function createUsaJobsBatchConnectors(
  options: { apiKey?: string; email?: string } = {}
): SourceConnector[] {
  const apiKey = options.apiKey ?? process.env.USAJOBS_API_KEY ?? "";
  const email = options.email ?? process.env.USAJOBS_EMAIL ?? "";

  if (!apiKey || !email) return [];

  return DEFAULT_KEYWORDS.map((keyword) =>
    createUsaJobsConnector({ keyword, apiKey, email })
  );
}

async function fetchUsaJobsJobs({
  keyword,
  apiKey,
  email,
  now,
  limit,
}: {
  keyword: string;
  apiKey: string;
  email: string;
  now: Date;
  limit?: number;
}): Promise<SourceConnectorFetchResult> {
  const allJobs: SourceConnectorJob[] = [];
  const seenIds = new Set<string>();
  let page = 1;
  let totalAvailable = 0;

  while (true) {
    if (typeof limit === "number" && allJobs.length >= limit) break;

    const params = new URLSearchParams({
      ResultsPerPage: String(USAJOBS_PAGE_SIZE),
      Page: String(page),
      DatePosted: "14", // Last 14 days
    });
    if (keyword) params.set("Keyword", keyword);

    const url = `${USAJOBS_API_BASE}?${params.toString()}`;

    if (page > 1) {
      await sleep(USAJOBS_RATE_DELAY_MS);
    }

    const response = await fetch(url, {
      headers: {
        "Authorization-Key": apiKey,
        "User-Agent": email,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.log(`[usajobs:${keyword || "all"}] Rate limited on page ${page}`);
        break;
      }
      throw new Error(
        `USAJobs API failed: ${response.status} ${response.statusText}`
      );
    }

    const payload = (await response.json()) as UsaJobsSearchResponse;
    const items = payload.SearchResult?.SearchResultItems ?? [];
    totalAvailable = payload.SearchResult?.SearchResultCountAll ?? totalAvailable;

    if (items.length === 0) break;

    for (const item of items) {
      const pos = item.MatchedObjectDescriptor;
      if (!pos?.PositionTitle || !pos?.PositionID) continue;
      const sourceId = `usajobs:${pos.PositionID}`;
      if (seenIds.has(sourceId)) continue;
      seenIds.add(sourceId);
      allJobs.push(mapUsaJobsPosition(pos, now));
    }

    if (items.length < USAJOBS_PAGE_SIZE) break;
    if (typeof limit === "number" && allJobs.length >= limit) break;
    page++;

    // Safety: don't paginate too deep
    if (page > 10) break;
  }

  const finalJobs =
    typeof limit === "number" ? allJobs.slice(0, limit) : allJobs;

  return {
    jobs: finalJobs,
    metadata: {
      keyword,
      totalAvailable,
      pagesSearched: page,
      fetchedAt: now.toISOString(),
      totalFetched: finalJobs.length,
    } as Prisma.InputJsonValue,
  };
}

function mapUsaJobsPosition(
  pos: UsaJobsPosition,
  now: Date
): SourceConnectorJob {
  const id = pos.PositionID ?? "";
  const title = (pos.PositionTitle ?? "").trim();
  const company = buildOrgName(pos);
  const location = buildLocationStr(pos);
  const description = buildDescription(pos);

  const salary = pos.PositionRemuneration?.[0];
  const salaryMin = salary?.MinimumRange ? parseFloat(salary.MinimumRange) : null;
  const salaryMax = salary?.MaximumRange ? parseFloat(salary.MaximumRange) : null;

  return {
    sourceId: `usajobs:${id}`,
    sourceUrl: pos.PositionURI ?? null,
    title,
    company,
    location,
    description,
    applyUrl: pos.PositionURI ?? `https://www.usajobs.gov/job/${id}`,
    postedAt: pos.PublicationStartDate ? new Date(pos.PublicationStartDate) : null,
    deadline: pos.ApplicationCloseDate ? new Date(pos.ApplicationCloseDate) : null,
    employmentType: inferEmploymentType(pos),
    workMode: inferWorkMode(pos, location),
    salaryMin: salaryMin && salaryMin > 0 ? salaryMin : null,
    salaryMax: salaryMax && salaryMax > 0 ? salaryMax : null,
    salaryCurrency: salaryMin || salaryMax ? "USD" : null,
    metadata: {
      source: "usajobs",
      positionId: id,
      department: pos.DepartmentName ?? null,
      organization: pos.OrganizationName ?? null,
      gradeRange:
        pos.UserArea?.Details
          ? `${pos.UserArea.Details.LowGrade ?? ""}-${pos.UserArea.Details.HighGrade ?? ""}`
          : null,
      jobCategory: pos.JobCategory?.[0]?.Name ?? null,
      whoMayApply: pos.UserArea?.Details?.WhoMayApply?.Name ?? null,
    } as Prisma.InputJsonValue,
  };
}

function buildOrgName(pos: UsaJobsPosition): string {
  const org = pos.OrganizationName?.trim();
  const dept = pos.DepartmentName?.trim();
  if (org && dept && org !== dept) return `${org} (${dept})`;
  return org || dept || "US Federal Government";
}

function buildLocationStr(pos: UsaJobsPosition): string {
  const locs = pos.PositionLocation ?? [];
  if (locs.length === 0) return "United States";

  const formatted = locs
    .slice(0, 3) // Show up to 3 locations
    .map((loc) => {
      const city = loc.CityName?.trim();
      const state = loc.CountrySubDivisionCode?.trim();
      if (city && state) return `${city}, ${state}`;
      return loc.LocationName?.trim() ?? "";
    })
    .filter(Boolean);

  if (formatted.length === 0) return "United States";
  const suffix = locs.length > 3 ? ` (+${locs.length - 3} more)` : "";
  return formatted.join("; ") + suffix;
}

function buildDescription(pos: UsaJobsPosition): string {
  const parts: string[] = [];

  if (pos.UserArea?.Details?.JobSummary) {
    parts.push(pos.UserArea.Details.JobSummary);
  }

  if (pos.QualificationSummary) {
    parts.push("Qualifications:\n" + pos.QualificationSummary);
  }

  if (pos.UserArea?.Details?.MajorDuties?.length) {
    parts.push(
      "Major Duties:\n" +
        pos.UserArea.Details.MajorDuties.map((d) => `• ${d}`).join("\n")
    );
  }

  return parts.join("\n\n") || "See full posting for details.";
}

function inferEmploymentType(pos: UsaJobsPosition): EmploymentType | null {
  const schedule = pos.PositionSchedule?.[0]?.Name?.toLowerCase() ?? "";
  if (schedule.includes("part-time")) return "PART_TIME";
  if (schedule.includes("intermittent")) return "CONTRACT";
  const offering = pos.PositionOfferingType?.[0]?.Name?.toLowerCase() ?? "";
  if (offering.includes("term") || offering.includes("temporary")) return "CONTRACT";
  if (offering.includes("internship")) return "INTERNSHIP";
  return null;
}

function inferWorkMode(pos: UsaJobsPosition, location: string): WorkMode | null {
  if (pos.UserArea?.Details?.TeleworkEligible) return "HYBRID";
  const lower = location.toLowerCase();
  if (/\bremote\b/.test(lower)) return "REMOTE";
  if (/\btelework\b/.test(lower)) return "HYBRID";
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
