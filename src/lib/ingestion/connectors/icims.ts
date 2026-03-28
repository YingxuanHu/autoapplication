import type {
  EmploymentType,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

/**
 * iCIMS connector — parses public career portal pages.
 *
 * Source token: the iCIMS subdomain, e.g. "jobs-microsoft" for
 * https://jobs-microsoft.icims.com.
 *
 * Strategy:
 * 1. Paginate the search listing (`/jobs/search?pr=N&in_iframe=1`)
 * 2. For each job, fetch the detail page and extract the JSON-LD
 *    `schema.org/JobPosting` blob.
 * 3. Map the structured data to SourceConnectorJob.
 */

const ICIMS_SEARCH_PAGE_SIZE = 20; // iCIMS default per page
const DETAIL_BATCH_SIZE = 6; // concurrent detail fetches
const MAX_PAGES = 100; // safety cap

type IcimsConnectorOptions = {
  /** The subdomain portion, e.g. "jobs-microsoft" */
  portalSubdomain: string;
  companyName?: string;
};

// ─── JSON-LD JobPosting shape (partial — only fields we use) ──────────────────

type JsonLdJobPosting = {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  jobLocationType?: string;
  directApply?: boolean;
  url?: string;
  hiringOrganization?: {
    name?: string;
    sameAs?: string;
  };
  jobLocation?: Array<{
    address?: {
      streetAddress?: string;
      addressLocality?: string;
      addressRegion?: string;
      addressCountry?: string;
      postalCode?: string;
    };
  }>;
  baseSalary?: {
    currency?: string;
    value?: {
      minValue?: number;
      maxValue?: number;
      unitText?: string;
    };
  };
  occupationalCategory?: string;
};

// ─── Listing row extracted from search page HTML ──────────────────────────────

type IcimsListingRow = {
  jobId: string;
  title: string;
  detailPath: string; // e.g. /jobs/42066/software-engineering/job
  location: string;
  postedText: string;
  positionType: string;
  remote: string;
  category: string;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildIcimsSourceToken(portalSubdomain: string): string {
  return portalSubdomain.toLowerCase().trim();
}

export function parseIcimsSourceToken(token: string): {
  portalSubdomain: string;
  baseUrl: string;
} {
  const portalSubdomain = token.toLowerCase().trim();
  return {
    portalSubdomain,
    baseUrl: `https://${portalSubdomain}.icims.com`,
  };
}

export function buildIcimsBoardUrl(portalSubdomain: string): string {
  return `https://${portalSubdomain}.icims.com/jobs/search`;
}

export async function validateIcimsPortal(portalSubdomain: string): Promise<{
  valid: boolean;
  jobCount: number;
  error?: string;
}> {
  try {
    const baseUrl = `https://${portalSubdomain}.icims.com`;
    const response = await fetch(
      `${baseUrl}/jobs/search?pr=0&in_iframe=1`,
      {
        headers: buildHeaders(),
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      return { valid: false, jobCount: 0, error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Check for bot block / login required
    if (
      html.includes("Incapsula") ||
      html.includes("cf-browser-verification") ||
      html.includes("captcha")
    ) {
      return { valid: false, jobCount: 0, error: "bot_blocked" };
    }

    if (!html.includes("iCIMS_JobsTable") && !html.includes("iCIMS_JobListingRow")) {
      // Might be a redirect to login or empty portal
      if (html.includes("Log In") && html.includes("password")) {
        return { valid: false, jobCount: 0, error: "login_required" };
      }
      return { valid: false, jobCount: 0, error: "no_job_table" };
    }

    const rows = parseSearchPage(html);
    const pageCount = parsePageCount(html);
    const estimatedTotal = pageCount * ICIMS_SEARCH_PAGE_SIZE;

    return {
      valid: rows.length > 0,
      jobCount: Math.max(rows.length, estimatedTotal),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, jobCount: 0, error: message };
  }
}

export function createIcimsConnector(
  options: IcimsConnectorOptions
): SourceConnector {
  const { portalSubdomain } = options;
  const token = buildIcimsSourceToken(portalSubdomain);
  const baseUrl = `https://${token}.icims.com`;
  const resolvedCompanyName =
    options.companyName ?? buildCompanyName(portalSubdomain);

  return {
    key: `icims:${token}`,
    sourceName: `iCIMS:${token}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",

    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      // Phase 1: Paginate through search pages to collect listing stubs
      const listings = await fetchAllListings({
        baseUrl,
        limit: fetchOptions.limit,
      });

      // Phase 2: Fetch detail pages in batches, extracting JSON-LD
      const jobs = await mapInBatches(
        listings,
        DETAIL_BATCH_SIZE,
        async (listing) =>
          fetchAndBuildJob({
            baseUrl,
            listing,
            fallbackCompanyName: resolvedCompanyName,
          })
      );

      // Filter out nulls (detail fetch failures)
      const validJobs = jobs.filter(
        (job): job is SourceConnectorJob => job !== null
      );

      return {
        jobs: validJobs,
        metadata: {
          portalSubdomain: token,
          companyName: resolvedCompanyName,
          fetchedAt: fetchOptions.now.toISOString(),
          listingCount: listings.length,
          detailSuccessCount: validJobs.length,
        },
      };
    },
  };
}

// ─── Search page fetching & parsing ───────────────────────────────────────────

async function fetchAllListings({
  baseUrl,
  limit,
}: {
  baseUrl: string;
  limit?: number;
}) {
  const allRows: IcimsListingRow[] = [];
  let page = 0;

  while (page < MAX_PAGES) {
    const url = `${baseUrl}/jobs/search?pr=${page}&in_iframe=1`;
    const response = await fetch(url, {
      headers: buildHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) break;

    const html = await response.text();
    const rows = parseSearchPage(html);
    if (rows.length === 0) break;

    allRows.push(...rows);

    if (typeof limit === "number" && allRows.length >= limit) {
      return allRows.slice(0, limit);
    }

    // Check if there's a next page
    const pageCount = parsePageCount(html);
    page++;
    if (page >= pageCount) break;
  }

  return allRows;
}

/**
 * Parse the iCIMS search results HTML.
 *
 * iCIMS portals use two layouts:
 * 1. Div-based (Bootstrap grid) with absolute URLs — newer portals
 * 2. Table-based with `iCIMS_JobsTable` / `iCIMS_JobListingRow` — older portals
 *
 * We detect job detail links in both formats.
 */
function parseSearchPage(html: string): IcimsListingRow[] {
  const rows: IcimsListingRow[] = [];
  const seen = new Set<string>();

  // Strategy: find all job detail links (absolute or relative)
  // Absolute: href="https://{subdomain}.icims.com/jobs/{id}/{slug}/job..."
  // Relative: href="/jobs/{id}/{slug}/job..."
  const linkRegex =
    /href="((?:https?:\/\/[^"]*)?\/jobs\/(\d+)\/([^"]*?)\/job[^"]*)"/gi;
  let linkMatch: RegExpExecArray | null;

  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const fullHref = linkMatch[1];
    const jobId = linkMatch[2];

    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Extract the path portion for detail fetching
    const pathMatch = fullHref.match(/\/jobs\/\d+\/[^?#]*/);
    if (!pathMatch) continue;
    const detailPath = pathMatch[0];

    // Find the context around this link to extract title, location, dates
    const linkIdx = linkMatch.index;
    // Look in a window around the link for surrounding data
    const windowStart = Math.max(0, linkIdx - 500);
    const windowEnd = Math.min(html.length, linkIdx + 800);
    const context = html.substring(windowStart, windowEnd);

    // Title: inside <h2>, <h3>, or <a> element containing the link
    const titleMatch = context.match(
      new RegExp(
        `href="[^"]*\\/jobs\\/${jobId}\\/[^"]*"[^>]*>[\\s\\S]*?<(?:h[1-6]|span)[^>]*>\\s*([\\s\\S]*?)\\s*<\\/(?:h[1-6]|span)>`,
        "i"
      )
    );
    let title = titleMatch ? stripHtml(titleMatch[1]).trim() : "";

    // Fallback: use the <a> title attribute
    if (!title) {
      const titleAttrMatch = context.match(
        new RegExp(`title="[^"]*?-\\s*([^"]+)"[^>]*href="[^"]*\\/jobs\\/${jobId}`, "i")
      ) ?? context.match(
        new RegExp(`href="[^"]*\\/jobs\\/${jobId}[^"]*"[^>]*title="[^"]*?-\\s*([^"]+)"`, "i")
      );
      title = titleAttrMatch ? stripHtml(titleAttrMatch[1]).trim() : "";
    }

    // Fallback: derive from slug
    if (!title) {
      title = linkMatch[3]
        .replace(/[?#].*$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }

    if (!title) continue;

    // Location: look for location patterns near the link
    const locationMatch = context.match(
      /(?:Job Locations?|Location)[^>]*<\/span>\s*<span[^>]*>\s*([^<]+)/i
    ) ?? context.match(
      /(?:field-label[^>]*>[^<]*Location[^<]*<\/span>[\s\S]*?<span[^>]*>\s*([^<]+))/i
    );
    const location = locationMatch ? locationMatch[1].trim() : "";

    // Posted date
    const dateMatch = context.match(
      /(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i
    );
    const postedText = dateMatch ? dateMatch[1] : "";

    // Position type
    const posTypeMatch = context.match(
      /(?:Position Type|Employment Type)[^>]*<\/span>\s*<span[^>]*>\s*([^<]+)/i
    );
    const positionType = posTypeMatch ? posTypeMatch[1].trim() : "";

    // Category
    const catMatch = context.match(
      /(?:Category|Department)[^>]*<\/span>\s*<span[^>]*>\s*([^<]+)/i
    );
    const category = catMatch ? catMatch[1].trim() : "";

    // Remote
    const remoteMatch = context.match(
      /(?:Remote)[^>]*<\/span>\s*<span[^>]*>\s*(Yes|No)/i
    );
    const remote = remoteMatch ? remoteMatch[1] : "";

    rows.push({
      jobId,
      title,
      detailPath,
      location,
      postedText,
      positionType,
      remote,
      category,
    });
  }

  return rows;
}

function parsePageCount(html: string): number {
  // Look for "Page X of Y" pattern
  const pageMatch = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  if (pageMatch) return Number.parseInt(pageMatch[1], 10);

  // Look for pagination links: pr=N
  const prMatches = [...html.matchAll(/[?&]pr=(\d+)/g)];
  if (prMatches.length > 0) {
    const maxPr = Math.max(...prMatches.map((m) => Number.parseInt(m[1], 10)));
    return maxPr + 1;
  }

  return 1;
}

// ─── Detail page fetching ─────────────────────────────────────────────────────

async function fetchAndBuildJob({
  baseUrl,
  listing,
  fallbackCompanyName,
}: {
  baseUrl: string;
  listing: IcimsListingRow;
  fallbackCompanyName: string;
}): Promise<SourceConnectorJob | null> {
  try {
    const detailUrl = `${baseUrl}${listing.detailPath}?in_iframe=1`;
    const response = await fetch(detailUrl, {
      headers: buildHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;

    const html = await response.text();
    const jsonLd = extractJsonLd(html);

    if (jsonLd) {
      return buildJobFromJsonLd({
        jobId: listing.jobId,
        detailPath: listing.detailPath,
        baseUrl,
        jsonLd,
        fallbackCompanyName,
        listingRow: listing,
      });
    }

    // Fallback: build from listing data + page content
    return buildJobFromHtml({
      jobId: listing.jobId,
      detailPath: listing.detailPath,
      baseUrl,
      html,
      fallbackCompanyName,
      listingRow: listing,
    });
  } catch {
    return null;
  }
}

function extractJsonLd(html: string): JsonLdJobPosting | null {
  const scriptRegex =
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as JsonLdJobPosting;
      if (parsed["@type"] === "JobPosting") return parsed;
    } catch {
      // Malformed JSON-LD, skip
    }
  }

  return null;
}

function buildJobFromJsonLd({
  jobId,
  detailPath,
  baseUrl,
  jsonLd,
  fallbackCompanyName,
  listingRow,
}: {
  jobId: string;
  detailPath: string;
  baseUrl: string;
  jsonLd: JsonLdJobPosting;
  fallbackCompanyName: string;
  listingRow: IcimsListingRow;
}): SourceConnectorJob {
  const sourceUrl = jsonLd.url ?? `${baseUrl}${detailPath}`;
  const applyUrl = `${baseUrl}${detailPath}?mode=apply&apply=yes`;

  const location = buildLocationFromJsonLd(jsonLd);
  const description = jsonLd.description
    ? stripHtml(jsonLd.description)
    : "";
  const salary = parseSalary(jsonLd.baseSalary);

  return {
    sourceId: jobId,
    sourceUrl,
    title: jsonLd.title ?? listingRow.title,
    company: jsonLd.hiringOrganization?.name ?? fallbackCompanyName,
    location,
    description,
    applyUrl,
    postedAt: parseDateValue(jsonLd.datePosted),
    deadline: parseDateValue(jsonLd.validThrough),
    employmentType: inferEmploymentType(jsonLd.employmentType),
    workMode: inferWorkMode(jsonLd.jobLocationType, location, listingRow.remote),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    metadata: {
      jsonLd,
      listingRow,
      sourcePortal: baseUrl,
    },
  };
}

function buildJobFromHtml({
  jobId,
  detailPath,
  baseUrl,
  html,
  fallbackCompanyName,
  listingRow,
}: {
  jobId: string;
  detailPath: string;
  baseUrl: string;
  html: string;
  fallbackCompanyName: string;
  listingRow: IcimsListingRow;
}): SourceConnectorJob {
  // Attempt to extract description from the main content area
  const descMatch = html.match(
    /class="[^"]*iCIMS_JobContent[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  ) ?? html.match(
    /class="[^"]*iCIMS_InfoMsg_Job[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const description = descMatch ? stripHtml(descMatch[1]) : "";

  return {
    sourceId: jobId,
    sourceUrl: `${baseUrl}${detailPath}`,
    title: listingRow.title,
    company: fallbackCompanyName,
    location: listingRow.location || "Unknown",
    description,
    applyUrl: `${baseUrl}${detailPath}?mode=apply&apply=yes`,
    postedAt: null,
    deadline: null,
    employmentType: inferEmploymentType(listingRow.positionType),
    workMode: inferWorkMode(null, listingRow.location, listingRow.remote),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      listingRow,
      sourcePortal: baseUrl,
      jsonLdAvailable: false,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildLocationFromJsonLd(jsonLd: JsonLdJobPosting): string {
  const locations = jsonLd.jobLocation ?? [];
  if (locations.length === 0) {
    if (jsonLd.jobLocationType === "TELECOMMUTE") return "Remote";
    return "Unknown";
  }

  const parts = locations.map((loc) => {
    const addr = loc.address;
    if (!addr) return "Unknown";

    return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .filter(Boolean)
      .join(", ");
  });

  const locationString = parts.filter((p) => p !== "Unknown").join("; ");

  if (jsonLd.jobLocationType === "TELECOMMUTE" && locationString) {
    return `Remote – ${locationString}`;
  }

  return locationString || "Unknown";
}

function parseSalary(baseSalary: JsonLdJobPosting["baseSalary"]): {
  min: number | null;
  max: number | null;
  currency: string | null;
} {
  if (!baseSalary?.value) {
    return { min: null, max: null, currency: null };
  }

  const { minValue, maxValue, unitText } = baseSalary.value;
  let min = minValue ?? null;
  let max = maxValue ?? null;

  // Normalize hourly to annual (assume 2080 hours/year)
  if (unitText?.toLowerCase() === "hour" || unitText?.toLowerCase() === "hourly") {
    if (min !== null) min = Math.round(min * 2080);
    if (max !== null) max = Math.round(max * 2080);
  }

  return {
    min,
    max,
    currency: baseSalary.currency ?? null,
  };
}

function inferEmploymentType(
  value: string | string[] | null | undefined
): EmploymentType | null {
  if (!value) return null;

  const normalized = (Array.isArray(value) ? value.join(" ") : value).toLowerCase();
  if (normalized.includes("intern")) return "INTERNSHIP";
  if (normalized.includes("contract") || normalized.includes("temporary")) {
    return "CONTRACT";
  }
  if (normalized.includes("part")) return "PART_TIME";
  if (
    normalized.includes("full") ||
    normalized.includes("permanent") ||
    normalized.includes("other")
  ) {
    return "FULL_TIME";
  }
  return null;
}

function inferWorkMode(
  jobLocationType: string | null | undefined,
  location: string,
  remoteField: string
): WorkMode | null {
  if (jobLocationType === "TELECOMMUTE") return "REMOTE";
  if (remoteField?.toLowerCase() === "yes") return "REMOTE";

  const locationLower = location.toLowerCase();
  if (locationLower.includes("remote")) return "REMOTE";
  if (locationLower.includes("hybrid")) return "HYBRID";

  return null;
}

function parseDateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function buildCompanyName(portalSubdomain: string): string {
  // Strip common prefixes: "jobs-", "careers-", "uscareers-", "us-"
  const stripped = portalSubdomain.replace(
    /^(jobs|careers|uscareers|us|ca|uk|eu|apac)-/i,
    ""
  );
  return stripped
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function mapInBatches<TInput, TOutput>(
  items: TInput[],
  batchSize: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map((item) => mapper(item)));
    results.push(...batchResults);
  }

  return results;
}
