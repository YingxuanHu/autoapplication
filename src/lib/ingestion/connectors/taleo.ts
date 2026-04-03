/**
 * Oracle Taleo ATS connector.
 *
 * Taleo career sections are fully JavaScript-rendered (FreeMarker templates).
 * Plain HTTP returns no job data — only a generic "Oracle Taleo" page shell.
 *
 * Strategy (hybrid — minimal headless usage):
 *   1. Sitemap discovery: `sitemap.jss?portalCode={code}&lang=en` returns XML
 *      with job detail URLs. This works via plain HTTP.
 *   2. Portal ID extraction: render ONE career section page via headless browser,
 *      intercept the XHR to `/rest/jobboard/searchjobs` to capture the numeric
 *      portal ID, OR parse it from the rendered HTML/JS globals.
 *   3. REST API bulk fetch: once we have the portal ID, use
 *      `/careersection/rest/jobboard/searchjobs` for paginated job listing
 *      (plain HTTP, JSON POST).
 *   4. Detail enrichment: fetch individual job details from the REST API or
 *      rendered detail pages for description/salary/apply URL.
 *
 * Source token format: `{tenant}/{careerSectionCode}`
 *   e.g. "aircanada/2", "telus/koodo", "bmo/2"
 *
 * The tenant maps to {tenant}.taleo.net.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import {
  sleepWithAbort,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import { renderPage, disposeBrowser } from "@/lib/ingestion/headless";

const TALEO_DETAIL_CONCURRENCY = 4;
const TALEO_REST_PAGE_SIZE = 25;
const TALEO_SOURCE_TOKEN_SEPARATOR = "/";

// ─── Types ────────────────────────────────────────────────────────────────────

type TaleoConnectorOptions = {
  sourceToken?: string;
  tenant?: string;
  careerSection?: string;
  companyName?: string;
};

type TaleoTarget = {
  tenant: string;
  careerSection: string;
};

type TaleoSitemapEntry = {
  loc: string;
  jobId: string;
};

type TaleoRestJobRow = {
  contestNo: string;
  title: string;
  location?: string | null;
  department?: string | null;
  jobField?: string | null;
  postingDate?: string | null;
  openingDate?: string | null;
  closingDate?: string | null;
  description?: string | null;
  qualifications?: string | null;
  additionalInfo?: string | null;
};

type TaleoRestSearchResponse = {
  requisitionList?: TaleoRestJobRow[];
  total?: number;
};

type TaleoJobDetail = {
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
  postedAt: Date | null;
  deadline: Date | null;
  employmentType: EmploymentType | null;
  workMode: WorkMode | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
};

// ─── Token helpers ───────────────────────────────────────────────────────────

export function buildTaleoSourceToken(target: TaleoTarget): string {
  return `${target.tenant.trim().toLowerCase()}${TALEO_SOURCE_TOKEN_SEPARATOR}${target.careerSection.trim().toLowerCase()}`;
}

export function parseTaleoSourceToken(token: string): TaleoTarget {
  const sepIndex = token.indexOf(TALEO_SOURCE_TOKEN_SEPARATOR);
  if (sepIndex <= 0) {
    throw new Error(
      `Invalid Taleo source token "${token}". Expected tenant/careerSection.`
    );
  }
  return {
    tenant: token.slice(0, sepIndex).trim().toLowerCase(),
    careerSection: token.slice(sepIndex + 1).trim().toLowerCase(),
  };
}

export function buildTaleoBoardUrl(tokenOrTarget: string | TaleoTarget): string {
  const target =
    typeof tokenOrTarget === "string"
      ? parseTaleoSourceToken(tokenOrTarget)
      : tokenOrTarget;
  return `https://${target.tenant}.taleo.net/careersection/${target.careerSection}/jobsearch.ftl?lang=en`;
}

export function buildTaleoSitemapUrl(target: TaleoTarget): string {
  return `https://${target.tenant}.taleo.net/careersection/sitemap.jss?portalCode=${target.careerSection}&lang=en`;
}

export function buildTaleoRestUrl(target: TaleoTarget): string {
  return `https://${target.tenant}.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=${target.careerSection}`;
}

function buildTaleoJobDetailUrl(target: TaleoTarget, jobId: string): string {
  return `https://${target.tenant}.taleo.net/careersection/${target.careerSection}/jobdetail.ftl?job=${jobId}&lang=en`;
}

function buildTaleoApplyUrl(target: TaleoTarget, jobId: string): string {
  return `https://${target.tenant}.taleo.net/careersection/${target.careerSection}/jobapply.ftl?job=${jobId}&lang=en`;
}

// ─── Connector factory ──────────────────────────────────────────────────────

export function createTaleoConnector(
  options: TaleoConnectorOptions
): SourceConnector {
  const target = resolveTaleoTarget(options);
  const sourceToken = buildTaleoSourceToken(target);
  const resolvedCompanyName =
    options.companyName ?? buildCompanyName(target.tenant);
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `taleo:${sourceToken}`,
    sourceName: `Taleo:${sourceToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(fetchOptions.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchTaleoJobs({
        target,
        fallbackCompanyName: resolvedCompanyName,
        now: fetchOptions.now,
        limit: fetchOptions.limit,
        signal: fetchOptions.signal,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

// ─── Main fetch pipeline ────────────────────────────────────────────────────

async function fetchTaleoJobs({
  target,
  fallbackCompanyName,
  now,
  limit,
  signal,
}: {
  target: TaleoTarget;
  fallbackCompanyName: string;
  now: Date;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SourceConnectorFetchResult> {
  throwIfAborted(signal);

  // Step 1: Try REST API with headless portal ID discovery
  const restResult = await tryRestApiFetch(target, fallbackCompanyName, now, limit, signal);
  if (restResult) {
    return restResult;
  }

  // Step 2: Fall back to sitemap + headless detail rendering
  console.log(
    `[taleo:${buildTaleoSourceToken(target)}] REST API unavailable, falling back to sitemap + headless detail`
  );
  return fetchViaSitemapAndHeadless(target, fallbackCompanyName, now, limit, signal);
}

// ─── REST API path ──────────────────────────────────────────────────────────

async function tryRestApiFetch(
  target: TaleoTarget,
  fallbackCompanyName: string,
  now: Date,
  limit?: number,
  signal?: AbortSignal
): Promise<SourceConnectorFetchResult | null> {
  // First: discover the numeric portal ID by rendering the search page
  const portalId = await discoverPortalId(target);
  if (!portalId) {
    console.log(
      `[taleo:${buildTaleoSourceToken(target)}] Could not discover portal ID via headless`
    );
    return null;
  }

  console.log(
    `[taleo:${buildTaleoSourceToken(target)}] Discovered portal ID: ${portalId}`
  );

  // Now use the REST API with the numeric portal ID
  try {
    const restJobs = await fetchRestJobs(target, portalId, limit, signal);
    if (restJobs.length === 0) return null;

    const jobs = restJobs.map((row) =>
      restRowToSourceJob(target, row, fallbackCompanyName, now)
    );

    return {
      jobs,
      metadata: {
        tenant: target.tenant,
        careerSection: target.careerSection,
        portalId,
        strategy: "rest_api",
        boardUrl: buildTaleoBoardUrl(target),
        fetchedAt: now.toISOString(),
        totalFetched: jobs.length,
      } as Prisma.InputJsonValue,
    };
  } catch (error) {
    console.log(
      `[taleo:${buildTaleoSourceToken(target)}] REST API failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function discoverPortalId(target: TaleoTarget): Promise<string | null> {
  const searchUrl = buildTaleoBoardUrl(target);
  try {
    const result = await renderPage({
      url: searchUrl,
      waitForNetworkIdle: true,
      extraWaitMs: 2000,
      timeoutMs: 35_000,
      navigationTimeoutMs: 25_000,
      interceptUrlPatterns: ["/rest/jobboard/searchjobs", "/rest/jobboard/"],
    });

    // Method 1: Extract portal ID from intercepted REST API requests
    for (const req of result.interceptedRequests) {
      // URL may contain ?portal=NUMERIC_ID
      const urlMatch = req.url.match(/[?&]portal=(\d+)/);
      if (urlMatch?.[1]) return urlMatch[1];

      // POST body may contain portalId
      if (req.postData) {
        const bodyMatch = req.postData.match(/"portalId"\s*:\s*(\d+)/);
        if (bodyMatch?.[1]) return bodyMatch[1];
      }
    }

    // Method 2: Parse from rendered HTML — look for portal ID in JS variables
    const htmlPatterns = [
      /portal[Ii]d\s*[=:]\s*['"]?(\d+)['"]?/,
      /portalId\s*:\s*(\d+)/,
      /PORTAL_ID\s*[=:]\s*['"]?(\d+)['"]?/,
      /"portal"\s*:\s*"?(\d+)"?/,
      /portal=(\d+)/,
    ];

    for (const pattern of htmlPatterns) {
      const match = result.html.match(pattern);
      if (match?.[1]) return match[1];
    }

    // Method 3: Try the career section code itself as the portal param
    // (some Taleo instances use the section code directly)
    return null;
  } catch (error) {
    console.log(
      `[taleo:${buildTaleoSourceToken(target)}] Headless portal discovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function fetchRestJobs(
  target: TaleoTarget,
  portalId: string,
  maxJobs?: number,
  signal?: AbortSignal
): Promise<TaleoRestJobRow[]> {
  const jobs: TaleoRestJobRow[] = [];
  let offset = 1;
  let total: number | null = null;
  const restBaseUrl = `https://${target.tenant}.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=${portalId}`;

  while (true) {
    throwIfAborted(signal);
    const remaining =
      typeof maxJobs === "number" ? Math.max(maxJobs - jobs.length, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      typeof remaining === "number"
        ? Math.min(TALEO_REST_PAGE_SIZE, remaining)
        : TALEO_REST_PAGE_SIZE;

    const response = await fetch(restBaseUrl, {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        multilineEnabled: false,
        sortingSelection: {
          sortBySelectionParam: "3",
          ascendingSortingOrder: "false",
        },
        fieldData: {
          fields: {
            KEYWORD: "",
            LOCATION: "",
            ORGANIZATION: "",
          },
          valid: true,
        },
        filterSelectionParam: {
          searchFilterByVal: "",
          timeZone: -5,
        },
        pageNo: Math.ceil(offset / pageSize),
        pageSize,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Taleo REST API ${response.status}: ${await response.text().catch(() => response.statusText)}`
      );
    }

    const payload = (await response.json()) as TaleoRestSearchResponse;
    const rows = payload.requisitionList ?? [];

    if (typeof payload.total === "number" && payload.total > 0) {
      total = payload.total;
    }

    if (rows.length === 0) break;
    jobs.push(...rows);
    offset += rows.length;

    if (typeof maxJobs === "number" && jobs.length >= maxJobs) break;
    if (typeof total === "number" && offset > total) break;
    if (rows.length < pageSize) break;
  }

  return typeof maxJobs === "number" ? jobs.slice(0, maxJobs) : jobs;
}

function restRowToSourceJob(
  target: TaleoTarget,
  row: TaleoRestJobRow,
  fallbackCompanyName: string,
  now: Date
): SourceConnectorJob {
  const jobId = row.contestNo;
  const description = [row.description, row.qualifications, row.additionalInfo]
    .filter(Boolean)
    .join("\n\n");

  return {
    sourceId: `taleo:${target.tenant}:${jobId}`,
    sourceUrl: buildTaleoJobDetailUrl(target, jobId),
    title: (row.title ?? "").trim() || "Untitled Position",
    company: fallbackCompanyName,
    location: (row.location ?? "").trim() || "Not specified",
    description: stripHtml(description),
    applyUrl: buildTaleoApplyUrl(target, jobId),
    postedAt: parseTaleoDate(row.postingDate ?? row.openingDate ?? null),
    deadline: parseTaleoDate(row.closingDate ?? null),
    employmentType: null,
    workMode: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      source: "taleo_rest",
      tenant: target.tenant,
      careerSection: target.careerSection,
      contestNo: jobId,
      department: row.department ?? null,
      jobField: row.jobField ?? null,
    } as Prisma.InputJsonValue,
  };
}

// ─── Sitemap + headless fallback ────────────────────────────────────────────

async function fetchViaSitemapAndHeadless(
  target: TaleoTarget,
  fallbackCompanyName: string,
  now: Date,
  limit?: number,
  signal?: AbortSignal
): Promise<SourceConnectorFetchResult> {
  const sitemapEntries = await fetchSitemap(target);
  const entriesToProcess =
    typeof limit === "number" ? sitemapEntries.slice(0, limit) : sitemapEntries;

  console.log(
    `[taleo:${buildTaleoSourceToken(target)}] Sitemap has ${sitemapEntries.length} entries, processing ${entriesToProcess.length}`
  );

  const jobs: SourceConnectorJob[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entriesToProcess.length) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      const entry = entriesToProcess[index]!;

      try {
        const detail = await fetchJobDetailViaHeadless(target, entry, fallbackCompanyName);
        if (detail) {
          jobs.push({
            sourceId: `taleo:${target.tenant}:${entry.jobId}`,
            sourceUrl: entry.loc,
            title: detail.title,
            company: detail.company,
            location: detail.location,
            description: detail.description,
            applyUrl: detail.applyUrl,
            postedAt: detail.postedAt,
            deadline: detail.deadline,
            employmentType: detail.employmentType,
            workMode: detail.workMode,
            salaryMin: detail.salaryMin,
            salaryMax: detail.salaryMax,
            salaryCurrency: detail.salaryCurrency,
            metadata: {
              source: "taleo_headless",
              tenant: target.tenant,
              careerSection: target.careerSection,
              jobId: entry.jobId,
            } as Prisma.InputJsonValue,
          });
        }
      } catch (error) {
        console.log(
          `[taleo:${buildTaleoSourceToken(target)}] Detail fetch failed for job ${entry.jobId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(TALEO_DETAIL_CONCURRENCY, entriesToProcess.length) },
      () => worker()
    )
  );

  // Clean up headless browser after batch
  await disposeBrowser();

  return {
    jobs,
    metadata: {
      tenant: target.tenant,
      careerSection: target.careerSection,
      strategy: "sitemap_headless",
      boardUrl: buildTaleoBoardUrl(target),
      sitemapUrl: buildTaleoSitemapUrl(target),
      sitemapEntryCount: sitemapEntries.length,
      fetchedAt: now.toISOString(),
      totalFetched: jobs.length,
    } as Prisma.InputJsonValue,
  };
}

async function fetchSitemap(target: TaleoTarget): Promise<TaleoSitemapEntry[]> {
  const sitemapUrl = buildTaleoSitemapUrl(target);
  const response = await fetch(sitemapUrl, {
    headers: {
      Accept: "application/xml, text/xml, */*",
      "User-Agent":
        "Mozilla/5.0 (compatible; autoapplication-taleo/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Taleo sitemap fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const xml = await response.text();
  const entries: TaleoSitemapEntry[] = [];

  // Parse <url><loc>...</loc></url> entries
  const locRegex = /<loc>([^<]+)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = locRegex.exec(xml)) !== null) {
    const loc = match[1]!.trim();
    // Extract job ID from URL: jobdetail.ftl?job=XXXXX
    const jobIdMatch = loc.match(/[?&]job=([^&]+)/i);
    if (jobIdMatch?.[1]) {
      entries.push({
        loc,
        jobId: jobIdMatch[1],
      });
    }
  }

  return entries;
}

async function fetchJobDetailViaHeadless(
  target: TaleoTarget,
  entry: TaleoSitemapEntry,
  fallbackCompanyName: string
): Promise<TaleoJobDetail | null> {
  const detailUrl = buildTaleoJobDetailUrl(target, entry.jobId);

  const result = await renderPage({
    url: detailUrl,
    waitForNetworkIdle: true,
    extraWaitMs: 2500,
    timeoutMs: 35_000,
    navigationTimeoutMs: 25_000,
  });

  const html = result.html;

  // Check for unavailable/expired pages
  if (
    /the job is no longer available/i.test(html) ||
    /career section unavailable/i.test(html) ||
    /career section you are trying to access is not available/i.test(html)
  ) {
    return null;
  }

  // Extract structured data from rendered Taleo HTML.
  // Taleo uses a structured layout: page <title> contains job title + ID,
  // body has "Position Title" / "Location" / "Description" sections as
  // labeled fields rendered by FreeMarker templates.
  const title = extractTaleoTitle(html);
  const company = extractCompanyFromHtml(html) ?? fallbackCompanyName;
  const location = extractTaleoLocation(html) ?? "Not specified";
  const description = extractTaleoDescription(html) ?? "";
  const postedAt = extractTaleoFieldDate(html, /(?:posted|opening)\s*(?:date)?\s*[^<]*?(\d{1,2}[-/]\w{3}[-/]\d{2,4}|\d{4}[-/]\d{2}[-/]\d{2}|\w+\s+\d{1,2},?\s+\d{4})/i);
  const deadline = extractTaleoFieldDate(html, /(?:clos(?:e|ing)|end)\s*(?:date)?\s*[^<]*?(\d{1,2}[-/]\w{3}[-/]\d{2,4}|\d{4}[-/]\d{2}[-/]\d{2}|\w+\s+\d{1,2},?\s+\d{4})/i);

  if (!title) {
    return null;
  }

  return {
    title,
    company,
    location,
    description,
    applyUrl: buildTaleoApplyUrl(target, entry.jobId),
    postedAt,
    deadline,
    employmentType: inferEmploymentType(html),
    workMode: inferWorkMode(location, html),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveTaleoTarget(options: TaleoConnectorOptions): TaleoTarget {
  if (options.sourceToken) {
    return parseTaleoSourceToken(options.sourceToken);
  }
  if (options.tenant && options.careerSection) {
    return {
      tenant: options.tenant.trim().toLowerCase(),
      careerSection: options.careerSection.trim().toLowerCase(),
    };
  }
  throw new Error(
    "Taleo connector requires sourceToken or tenant + careerSection."
  );
}

function buildCompanyName(tenant: string): string {
  return tenant
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTaleoDate(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return isNaN(date.getTime()) ? null : date;
}

function extractText(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  if (!match?.[1]) return null;
  return stripHtml(match[1]).trim() || null;
}

/**
 * Extract job title from Taleo rendered page.
 * Priority: <title> tag (format: "Job Description - Title (ID)"), then
 * labeled "Position Title" field in the body.
 */
function extractTaleoTitle(html: string): string | null {
  // <title>Job Description - Cargo Customer Service Agent (39116)</title>
  const titleTag = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleTag?.[1]) {
    const raw = stripHtml(titleTag[1]).trim();
    // Strip "Job Description - " prefix and trailing "(ID)" suffix
    const cleaned = raw
      .replace(/^job\s*description\s*[-–—]\s*/i, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .trim();
    if (cleaned && cleaned.length > 3 && !/^oracle\s+taleo$/i.test(cleaned)) {
      return cleaned;
    }
  }

  // Fallback: look for "Position Title" field label followed by content
  const posMatch = html.match(
    /Position\s+Title[\s\S]{0,200}?<(?:span|td|div)[^>]*>([\s\S]*?)<\/(?:span|td|div)>/i
  );
  if (posMatch?.[1]) {
    const text = stripHtml(posMatch[1]).trim();
    if (text && text.length > 2) return text;
  }

  return null;
}

/**
 * Extract location from Taleo rendered page.
 * Taleo uses a text format like:
 *   "Location : &nbsp; United States-Massachusetts-Boston-75 Federal Street"
 */
function extractTaleoLocation(html: string): string | null {
  // Convert to plain text first, preserving the "Label : Value" structure
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");

  // Taleo format variations:
  //   "Location : United States-Massachusetts-Boston-75 Federal Street Job : ..."
  //   "Location US-New York-New York Organization A5901 ..."
  const FIELD_BOUNDARY = /\s+(?:Job|Agency|Schedule|Shift|Salary|Department|Organization|Category|Posted|Closing|Work\s+Location|Requisition|Job\s+Band)\b/i;
  const taleoLocMatch = text.match(
    /(?:Primary\s+)?Location\s*:?\s+([A-Z][\w\s,.'-]+(?:-[\w\s,.'-]+)*)/i
  );
  let locationRaw = taleoLocMatch?.[1]?.trim() ?? null;
  // Trim at the first field boundary
  if (locationRaw) {
    const boundaryMatch = locationRaw.match(FIELD_BOUNDARY);
    if (boundaryMatch?.index) {
      locationRaw = locationRaw.slice(0, boundaryMatch.index).trim();
    }
  }
  if (locationRaw && locationRaw.length > 2) {
    // Convert Taleo dash-separated format: "United States-Massachusetts-Boston-75 Federal Street"
    // to "Boston, Massachusetts, United States"
    const parts = locationRaw.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // Reverse to get city first, then state, then country. Drop street address.
      const meaningful = parts.filter(
        (p) => !/^\d/.test(p) && p.length > 1
      );
      if (meaningful.length >= 2) {
        return meaningful.reverse().join(", ");
      }
    }
    if (locationRaw.length > 3) return locationRaw;
  }

  return null;
}

/**
 * Extract description from Taleo rendered page.
 * Taleo uses "Description" sections in the body.
 */
function extractTaleoDescription(html: string): string | null {
  // Try to find description section — look for "Description" heading
  // followed by content
  const descPatterns = [
    /Description[\s\S]{0,100}?<(?:div|td|span)[^>]*>([\s\S]{100,}?)<\/(?:div|td|span)>/i,
    /class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /id="requisitionDescriptionInterface[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].length > 100) {
      return stripHtml(match[1]);
    }
  }

  // Broader fallback: grab all body text between "Description" and a
  // section boundary
  const bodyText = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyText?.[1]) {
    const text = stripHtml(bodyText[1]);
    if (text.length > 300) return text.slice(0, 5000);
  }

  return null;
}

function extractTaleoFieldDate(html: string, pattern: RegExp): Date | null {
  const match = html.match(pattern);
  if (!match?.[1]) return null;
  return parseTaleoDate(match[1]);
}

function extractCompanyFromHtml(html: string): string | null {
  // Try JSON-LD first
  const jsonLdMatch = html.match(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (jsonLdMatch?.[1]) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld.hiringOrganization?.name) return ld.hiringOrganization.name;
    } catch {}
  }

  // Try common patterns
  const patterns = [
    /company\s*[:]\s*<[^>]*>([^<]+)</i,
    /organization\s*[:]\s*<[^>]*>([^<]+)</i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripHtml(match[1]).trim() || null;
  }

  return null;
}

function extractLocationFromHtml(html: string): string | null {
  // Try JSON-LD
  const jsonLdMatch = html.match(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (jsonLdMatch?.[1]) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      const loc = ld.jobLocation;
      if (loc?.address) {
        const addr = loc.address;
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
        if (parts.length > 0) return parts.join(", ");
      }
    } catch {}
  }

  // Try common Taleo patterns
  const patterns = [
    /location\s*[:]\s*<[^>]*>([^<]+)</i,
    /class\s*=\s*["'][^"']*location[^"']*["'][^>]*>([^<]+)</i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripHtml(match[1]).trim() || null;
  }

  return null;
}

function extractDescriptionFromHtml(html: string): string | null {
  // Try JSON-LD first
  const jsonLdMatch = html.match(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (jsonLdMatch?.[1]) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld.description) return stripHtml(ld.description);
    } catch {}
  }

  // Try to find the main description container
  const descPatterns = [
    /class\s*=\s*["'][^"']*jobdescription[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class\s*=\s*["'][^"']*job-description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /id\s*=\s*["']jobDescriptionText["'][^>]*>([\s\S]*?)<\/div>/i,
    /class\s*=\s*["'][^"']*requisitionDescription[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].length > 50) {
      return stripHtml(match[1]);
    }
  }

  // Fallback: grab all text between the title and apply button
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    const text = stripHtml(bodyMatch[1]);
    if (text.length > 200) return text.slice(0, 5000);
  }

  return null;
}

function extractDateFromHtml(html: string, pattern: RegExp): Date | null {
  const match = html.match(pattern);
  if (!match?.[1]) return null;
  return parseTaleoDate(match[1]);
}

function inferEmploymentType(html: string): EmploymentType | null {
  const lower = html.toLowerCase();
  if (/\b(part[- ]?time)\b/.test(lower)) return "PART_TIME";
  if (/\bcontract\b/.test(lower) && !/\bcontract(or|ual)?\b.*\bfull[- ]?time\b/.test(lower)) return "CONTRACT";
  if (/\bintern(ship)?\b/.test(lower)) return "INTERNSHIP";
  return null; // Default: let normalization handle it
}

function inferWorkMode(location: string, html: string): WorkMode | null {
  const lower = (location + " " + html.slice(0, 3000)).toLowerCase();
  if (/\bremote\b/.test(lower) && /\bhybrid\b/.test(lower)) return "HYBRID";
  if (/\bfully\s+remote\b/.test(lower) || /\b100%?\s*remote\b/.test(lower)) return "REMOTE";
  if (/\bhybrid\b/.test(lower)) return "HYBRID";
  if (/\bremote\b/.test(lower)) return "REMOTE";
  return null;
}

// ─── Validation helpers ─────────────────────────────────────────────────────

export async function validateTaleoPortal(
  tenant: string,
  careerSection: string
): Promise<{
  valid: boolean;
  sitemapEntryCount: number;
  sitemapUrl: string;
  boardUrl: string;
  error?: string;
}> {
  const target: TaleoTarget = {
    tenant: tenant.trim().toLowerCase(),
    careerSection: careerSection.trim().toLowerCase(),
  };

  const sitemapUrl = buildTaleoSitemapUrl(target);
  const boardUrl = buildTaleoBoardUrl(target);

  try {
    const entries = await fetchSitemap(target);
    return {
      valid: entries.length > 0,
      sitemapEntryCount: entries.length,
      sitemapUrl,
      boardUrl,
    };
  } catch (error) {
    return {
      valid: false,
      sitemapEntryCount: 0,
      sitemapUrl,
      boardUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
