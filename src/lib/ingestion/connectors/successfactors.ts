import type { Prisma } from "@/generated/prisma/client";
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
import { decodeHtmlEntitiesFull as decodeHtmlEntities } from "@/lib/ingestion/html-description";
import {
  buildTimeoutSignal,
  throwIfAborted,
} from "@/lib/ingestion/runtime-control";

const SUCCESSFACTORS_PAGE_SIZE = 25;
const SUCCESSFACTORS_DETAIL_CONCURRENCY = 6;
const SUCCESSFACTORS_SOURCE_TOKEN_SEPARATOR = "|";

type SuccessFactorsConnectorOptions = {
  sourceToken?: string;
  host?: string;
  pathPrefix?: string;
  companyName?: string;
};

type SuccessFactorsTarget = {
  host: string;
  pathPrefix: string | null;
};

type SuccessFactorsListJob = {
  title: string;
  location: string;
  postedAt: Date | null;
  detailUrl: string;
};

type SuccessFactorsJobDetail = {
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  postedAt: Date | null;
  applyUrl: string | null;
  employmentType: EmploymentType | null;
  workMode: WorkMode | null;
};

export type SuccessFactorsBoardValidation =
  | {
      valid: true;
      boardUrl: string;
      pageTitle: string | null;
    }
  | {
      valid: false;
      boardUrl: string;
      pageTitle: string | null;
      reason:
        | "legacy_sap_webdynpro"
        | "bot_blocked"
        | "no_structured_listing";
      message: string;
    };

export function buildSuccessFactorsSourceToken(
  targetOrHost: SuccessFactorsTarget | string,
  maybePathPrefix?: string | null
) {
  const target =
    typeof targetOrHost === "string"
      ? {
          host: targetOrHost,
          pathPrefix: maybePathPrefix ?? null,
        }
      : targetOrHost;
  const host = target.host.trim().toLowerCase();
  const pathPrefix = normalizePathPrefix(target.pathPrefix);
  return pathPrefix ? `${host}${SUCCESSFACTORS_SOURCE_TOKEN_SEPARATOR}${pathPrefix}` : host;
}

export function parseSuccessFactorsSourceToken(
  sourceToken: string
): SuccessFactorsTarget {
  const [host, rawPathPrefix] = sourceToken
    .split(SUCCESSFACTORS_SOURCE_TOKEN_SEPARATOR)
    .map((segment) => segment.trim().toLowerCase());

  if (!host) {
    throw new Error(
      `Invalid SuccessFactors source token "${sourceToken}". Expected host or host|pathPrefix.`
    );
  }

  return {
    host,
    pathPrefix: normalizePathPrefix(rawPathPrefix),
  };
}

export function buildSuccessFactorsSearchUrl(
  targetOrToken: SuccessFactorsTarget | string,
  startRow = 0
) {
  const target =
    typeof targetOrToken === "string"
      ? parseSuccessFactorsSourceToken(targetOrToken)
      : targetOrToken;
  const url = new URL(
    `${buildSuccessFactorsBaseUrl(target)}/search/`
  );
  url.searchParams.set("createNewAlert", "false");
  url.searchParams.set("q", "");
  url.searchParams.set("locationsearch", "");
  url.searchParams.set("sortColumn", "referencedate");
  url.searchParams.set("sortDirection", "desc");
  if (startRow > 0) {
    url.searchParams.set("startrow", String(startRow));
  }
  return url.toString();
}

export function buildSuccessFactorsBoardUrl(
  targetOrToken: SuccessFactorsTarget | string
) {
  return buildSuccessFactorsSearchUrl(targetOrToken);
}

export async function validateSuccessFactorsBoard(
  targetOrToken: SuccessFactorsTarget | string
): Promise<SuccessFactorsBoardValidation> {
  const boardUrl = buildSuccessFactorsBoardUrl(targetOrToken);
  const html = await fetchText(boardUrl);
  const pageTitle = cleanText(extractFirstMatch(html, /<title>([\s\S]*?)<\/title>/i)) || null;

  if (detectLegacySapWebDynpro(html)) {
    return {
      valid: false,
      boardUrl,
      pageTitle,
      reason: "legacy_sap_webdynpro",
      message: "Board appears to use legacy SAP WebDynpro and is not a modern structured SuccessFactors listing.",
    };
  }

  if (detectBotBlock(html)) {
    return {
      valid: false,
      boardUrl,
      pageTitle,
      reason: "bot_blocked",
      message: "Board appears to be bot-blocked and is not accessible without browser challenges.",
    };
  }

  if (!hasStructuredSuccessFactorsListing(html)) {
    return {
      valid: false,
      boardUrl,
      pageTitle,
      reason: "no_structured_listing",
      message: "Board did not expose structured SuccessFactors listing data on the public search page.",
    };
  }

  return {
    valid: true,
    boardUrl,
    pageTitle,
  };
}

export function createSuccessFactorsConnector(
  options: SuccessFactorsConnectorOptions
): SourceConnector {
  const target = resolveTarget(options);
  const sourceToken = buildSuccessFactorsSourceToken(target);
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: `successfactors:${sourceToken}`,
    sourceName: `SuccessFactors:${sourceToken}`,
    sourceTier: "TIER_2",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      fetchOptions: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(fetchOptions.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchSuccessFactorsJobs({
        target,
        fallbackCompanyName:
          options.companyName ?? deriveCompanyName(target.host),
        now: fetchOptions.now,
        limit: fetchOptions.limit,
        signal: fetchOptions.signal,
      });
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchSuccessFactorsJobs({
  target,
  fallbackCompanyName,
  now,
  limit,
  signal,
}: {
  target: SuccessFactorsTarget;
  fallbackCompanyName: string;
  now: Date;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SourceConnectorFetchResult> {
  const listingJobs = await fetchListingJobs(target, limit, signal);
  const jobs = await mapWithConcurrency(
    listingJobs,
    SUCCESSFACTORS_DETAIL_CONCURRENCY,
    async (listingJob) =>
      buildSourceJob({
        target,
        fallbackCompanyName,
        listingJob,
        now,
        signal,
      })
  );

  return {
    jobs,
    metadata: {
      host: target.host,
      pathPrefix: target.pathPrefix,
      boardUrl: buildSuccessFactorsBoardUrl(target),
      fetchedAt: now.toISOString(),
      totalFetched: jobs.length,
    } as Prisma.InputJsonValue,
  };
}

async function fetchListingJobs(
  target: SuccessFactorsTarget,
  limit?: number,
  signal?: AbortSignal
): Promise<SuccessFactorsListJob[]> {
  const jobs: SuccessFactorsListJob[] = [];
  let startRow = 0;
  let totalCount: number | null = null;

  while (true) {
    const remaining =
      typeof limit === "number" ? Math.max(limit - jobs.length, 0) : null;
    if (remaining === 0) break;

    const url = buildSuccessFactorsSearchUrl(target, startRow);
    const html = await fetchText(url, signal);
    const pageJobs = parseSearchResultsPage(html, target);

    if (pageJobs.length === 0) break;

    jobs.push(...pageJobs);

    if (totalCount === null) {
      totalCount = extractTotalCount(html);
    }

    startRow += pageJobs.length;

    if (typeof limit === "number" && jobs.length >= limit) break;
    if (typeof totalCount === "number" && startRow >= totalCount) break;
    if (pageJobs.length < SUCCESSFACTORS_PAGE_SIZE) break;
  }

  return typeof limit === "number" ? jobs.slice(0, limit) : jobs;
}

function parseSearchResultsPage(
  html: string,
  target: SuccessFactorsTarget
): SuccessFactorsListJob[] {
  const jobs: SuccessFactorsListJob[] = [];
  const rowMatches = html.matchAll(/<tr class="data-row">([\s\S]*?)<\/tr>/gi);

  for (const match of rowMatches) {
    const rowHtml = match[1] ?? "";
    const titleMatch = rowHtml.match(
      /<a href="([^"]*\/job\/[^"]+)" class="jobTitle-link">([^<]+)<\/a>/i
    );
    const detailHref = titleMatch?.[1] ?? null;
    const rawTitle = titleMatch?.[2] ?? null;
    const rawLocation = extractLastMatch(
      rowHtml,
      /<span class="jobLocation">\s*([\s\S]*?)\s*<\/span>/gi
    );
    const rawDate = extractLastMatch(
      rowHtml,
      /<span class="jobDate">\s*([\s\S]*?)\s*<\/span>/gi
    );

    if (!detailHref || !rawTitle || !rawLocation) continue;

    jobs.push({
      title: cleanText(rawTitle),
      location: cleanText(rawLocation),
      postedAt: parseSuccessFactorsDate(rawDate),
      detailUrl: new URL(detailHref, buildSuccessFactorsBaseUrl(target)).toString(),
    });
  }

  return jobs;
}

async function buildSourceJob({
  target,
  fallbackCompanyName,
  listingJob,
  now,
  signal,
}: {
  target: SuccessFactorsTarget;
  fallbackCompanyName: string;
  listingJob: SuccessFactorsListJob;
  now: Date;
  signal?: AbortSignal;
}): Promise<SourceConnectorJob> {
  let detail: SuccessFactorsJobDetail | null = null;

  try {
    const html = await fetchText(listingJob.detailUrl, signal);
    detail = parseJobDetailPage(html, listingJob.detailUrl);
  } catch {
    detail = null;
  }

  const description =
    detail?.description?.trim() ||
    `${listingJob.title} at ${fallbackCompanyName}. ${listingJob.location}`;
  const company =
    detail?.company?.trim() || fallbackCompanyName;
  const title = detail?.title?.trim() || listingJob.title;
  const location = detail?.location?.trim() || listingJob.location;
  const applyUrl = detail?.applyUrl?.trim() || listingJob.detailUrl;

  return {
    sourceId: listingJob.detailUrl,
    sourceUrl: listingJob.detailUrl,
    title,
    company,
    location,
    description,
    applyUrl,
    postedAt: detail?.postedAt ?? listingJob.postedAt ?? now,
    deadline: null,
    employmentType: detail?.employmentType ?? null,
    workMode: detail?.workMode ?? inferWorkMode(location, description),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      boardUrl: buildSuccessFactorsBoardUrl(target),
      detailUrl: listingJob.detailUrl,
      host: target.host,
      pathPrefix: target.pathPrefix,
    } as Prisma.InputJsonValue,
  };
}

function parseJobDetailPage(
  html: string,
  detailUrl: string
): SuccessFactorsJobDetail {
  const title =
    cleanText(
      extractFirstMatch(
        html,
        /itemprop="title"[^>]*>([^<]+)</i
      )
    ) || cleanText(extractFirstMatch(html, /<title>([\s\S]*?)<\/title>/i));
  const locality = cleanText(
    extractFirstMatch(html, /itemprop="addressLocality" content="([^"]+)"/i)
  );
  const region = cleanText(
    extractFirstMatch(html, /itemprop="addressRegion" content="([^"]+)"/i)
  );
  const country = cleanText(
    extractFirstMatch(html, /itemprop="addressCountry" content="([^"]+)"/i)
  );
  const company = cleanText(
    extractFirstMatch(html, /itemprop="hiringOrganization" content="([^"]+)"/i)
  );
  const postedAt = parseSuccessFactorsDate(
    extractFirstMatch(html, /itemprop="datePosted" content="([^"]+)"/i)
  );
  const applyHref = extractFirstMatch(
    html,
    /<a[^>]*class="[^"]*\bapply\b[^"]*"[^>]*href="([^"]+)"/i
  );
  const applyUrl = applyHref ? new URL(applyHref, detailUrl).toString() : null;
  const descriptionHtml =
    extractBalancedTagContent(
      html,
      /<span class="jobdescription">/i,
      "span"
    ) ??
    extractBalancedTagContent(
      html,
      /itemprop="description"[^>]*>/i,
      "span"
    );
  const description = descriptionHtml ? htmlToText(descriptionHtml) : null;

  return {
    title: title || null,
    company: company || null,
    location: [locality, region, country].filter(Boolean).join(", ") || null,
    description,
    postedAt,
    applyUrl,
    employmentType: inferEmploymentType(title, description),
    workMode: inferWorkMode(
      [locality, region, country].filter(Boolean).join(", "),
      description
    ),
  };
}

function extractTotalCount(html: string) {
  const match = html.match(/of <b>([\d,]+)<\/b>/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildSuccessFactorsBaseUrl(target: SuccessFactorsTarget) {
  return `https://${target.host}${target.pathPrefix ? `/${target.pathPrefix}` : ""}`;
}

function resolveTarget(options: SuccessFactorsConnectorOptions): SuccessFactorsTarget {
  if (options.sourceToken) {
    return parseSuccessFactorsSourceToken(options.sourceToken);
  }

  if (!options.host) {
    throw new Error(
      "SuccessFactors connector requires sourceToken or host."
    );
  }

  return {
    host: options.host.trim().toLowerCase(),
    pathPrefix: normalizePathPrefix(options.pathPrefix),
  };
}

function normalizePathPrefix(pathPrefix: string | null | undefined) {
  const normalized = pathPrefix?.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  return normalized ? normalized : null;
}

function deriveCompanyName(host: string) {
  const base = host
    .trim()
    .toLowerCase()
    .replace(/^jobs\./, "")
    .replace(/^careers?\./, "")
    .split(".")[0] ?? host;

  return base
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

async function fetchText(url: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-successfactors/1.0)",
    },
    signal: buildTimeoutSignal(signal, 45_000),
  });

  if (!response.ok) {
    throw new Error(
      `SuccessFactors fetch failed for ${url}: ${response.status} ${response.statusText}`
    );
  }

  throwIfAborted(signal);
  return response.text();
}

function extractFirstMatch(html: string, pattern: RegExp) {
  return pattern.exec(html)?.[1] ?? null;
}

function extractLastMatch(html: string, pattern: RegExp) {
  const matches = [...html.matchAll(pattern)];
  const value = matches[matches.length - 1]?.[1];
  return value ?? null;
}

function extractBalancedTagContent(
  html: string,
  startPattern: RegExp,
  tagName: string
) {
  const match = startPattern.exec(html);
  if (!match || match.index < 0) return null;

  const openTagIndex = html.lastIndexOf("<", match.index);
  const startIndex = html.indexOf(">", match.index);
  if (openTagIndex < 0 || startIndex < 0) return null;

  let depth = 1;
  let cursor = startIndex + 1;
  const openTag = new RegExp(`<${tagName}(\\s|>)`, "gi");
  const closeTag = new RegExp(`</${tagName}>`, "gi");
  openTag.lastIndex = cursor;
  closeTag.lastIndex = cursor;

  while (depth > 0) {
    const nextOpen = openTag.exec(html);
    const nextClose = closeTag.exec(html);

    if (!nextClose) return null;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      openTag.lastIndex = nextOpen.index + nextOpen[0].length;
      closeTag.lastIndex = cursor;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }

    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) {
      return html.slice(startIndex + 1, nextClose.index);
    }
  }

  return null;
}

function htmlToText(html: string) {
  return cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<img[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function cleanText(value: string | null | undefined) {
  if (!value) return "";
  return decodeHtmlEntities(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function parseSuccessFactorsDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(cleanText(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function detectLegacySapWebDynpro(html: string) {
  return (
    /webdynpro/i.test(html) ||
    /sap-wd-configid/i.test(html) ||
    /sap-wd-tstamp/i.test(html) ||
    /sap\.com\/tc\/webdynpro/i.test(html)
  );
}

function detectBotBlock(html: string) {
  return (
    /incapsula/i.test(html) ||
    /_incapsula_/i.test(html) ||
    /pardon the interruption/i.test(html) ||
    /request unsuccessful\.\s*incapsula/i.test(html) ||
    /automated access/i.test(html)
  );
}

function hasStructuredSuccessFactorsListing(html: string) {
  return (
    /class="data-row"/i.test(html) ||
    /class="jobTitle-link"/i.test(html) ||
    /\/job\/[^"' <]+/i.test(html) ||
    /talentcommunity\/apply\//i.test(html)
  );
}

function inferWorkMode(location: string, description: string | null) {
  const combined = `${location} ${description ?? ""}`.toLowerCase();
  if (combined.includes("hybrid")) return "HYBRID" as WorkMode;
  if (
    combined.includes("remote") ||
    combined.includes("virtual") ||
    combined.includes("work from home")
  ) {
    return "REMOTE" as WorkMode;
  }
  if (combined.includes("flexible")) return "FLEXIBLE" as WorkMode;
  if (combined.includes("on-site") || combined.includes("onsite")) {
    return "ONSITE" as WorkMode;
  }
  return null;
}

function inferEmploymentType(
  title: string | null,
  description: string | null
) {
  const combined = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (combined.includes("intern") || combined.includes("internship") || combined.includes("co-op")) {
    return "INTERNSHIP" as EmploymentType;
  }
  if (
    combined.includes("contract") ||
    combined.includes("temporary") ||
    combined.includes("fixed-term")
  ) {
    return "CONTRACT" as EmploymentType;
  }
  if (combined.includes("part time") || combined.includes("part-time")) {
    return "PART_TIME" as EmploymentType;
  }
  return null;
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TOutput>
) {
  const results: TOutput[] = new Array(inputs.length);
  let cursor = 0;

  async function worker() {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(inputs[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker())
  );

  return results;
}
