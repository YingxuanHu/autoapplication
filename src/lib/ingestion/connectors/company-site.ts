import type {
  EmploymentType,
  ExtractionRouteKind,
  Prisma,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_LISTING_PAGES = 8;
const MAX_DETAIL_PAGES = 80;
const MAX_LINKS_PER_PAGE = 40;
const MAX_SITEMAP_FILES = 8;
const MAX_SITEMAP_JOB_URLS = 250;
const JOB_LINK_RE =
  /(job|career|position|opening|opportunit|vacanc|posting|requisition|role)/i;
const PAGINATION_RE = /(next|more|older|page \d+)/i;
const STRIP_TAGS_RE = /<[^>]+>/g;

type CompanySiteConnectorOptions = {
  sourceName: string;
  companyName: string;
  boardUrl: string;
  extractionRoute: ExtractionRouteKind;
  parserVersion?: string | null;
};

type HtmlFetchResult = {
  url: string;
  html: string;
};

type StructuredJobPosting = {
  sourceUrl: string;
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
  requisitionId: string | null;
  metadata: Record<string, Prisma.InputJsonValue | null>;
};

type ParsedLink = {
  href: string;
  text: string;
};

type SitemapInspection = {
  sitemapUrl: string;
  scannedCount: number;
  jobUrls: string[];
};

export function createCompanySiteConnector(
  options: CompanySiteConnectorOptions
): SourceConnector {
  return {
    key: `${options.sourceName.toLowerCase().replace(/[^a-z0-9:]+/g, "-")}:site`,
    sourceName: options.sourceName,
    sourceTier: "TIER_3",
    freshnessMode: "INCREMENTAL",
    async fetchJobs(fetchOptions: SourceConnectorFetchOptions) {
      return fetchCompanySiteJobs(options, fetchOptions);
    },
  };
}

export async function inspectCompanySiteRoute(
  url: string,
  signal?: AbortSignal
): Promise<{
  finalUrl: string;
  extractionRoute: ExtractionRouteKind;
  parserVersion: string;
  confidence: number;
  metadata: Record<string, Prisma.InputJsonValue | null>;
}> {
  const page = await fetchHtml(url, signal);
  const jsonLdJobs = extractJsonLdJobPostings(page.html, page.url);
  if (jsonLdJobs.length > 0) {
    return {
      finalUrl: page.url,
      extractionRoute: "STRUCTURED_JSON",
      parserVersion: "company-site:v1",
      confidence: 0.96,
      metadata: {
        jsonLdJobCount: jsonLdJobs.length,
      },
    };
  }

  const embeddedJobs = extractEmbeddedJobObjects(page.html, page.url);
  if (embeddedJobs.length > 0) {
    return {
      finalUrl: page.url,
      extractionRoute: "STRUCTURED_API",
      parserVersion: "company-site:v1",
      confidence: 0.82,
      metadata: {
        embeddedJobCount: embeddedJobs.length,
      },
    };
  }

  const sitemap = await inspectSitemapCandidates(page.url, page.html, signal);
  if (sitemap.jobUrls.length > 0) {
    return {
      finalUrl: sitemap.sitemapUrl,
      extractionRoute: "STRUCTURED_SITEMAP",
      parserVersion: "company-site:v3",
      confidence: Math.min(0.91, 0.58 + sitemap.jobUrls.length * 0.003),
      metadata: {
        sitemapUrl: sitemap.sitemapUrl,
        sitemapCount: sitemap.scannedCount,
        sitemapJobCount: sitemap.jobUrls.length,
      },
    };
  }

  const htmlLinks = extractCandidateJobLinks(page.html, page.url);
  if (htmlLinks.length > 0) {
    return {
      finalUrl: page.url,
      extractionRoute: "HTML_FALLBACK",
      parserVersion: "company-site:v1",
      confidence: Math.min(0.7, 0.35 + htmlLinks.length * 0.02),
      metadata: {
        candidateLinkCount: htmlLinks.length,
      },
    };
  }

  if (looksLikeCareerSurface(page.html, page.url)) {
    return {
      finalUrl: page.url,
      extractionRoute: "HTML_FALLBACK",
      parserVersion: "company-site:v2",
      confidence: 0.22,
      metadata: {
        candidateLinkCount: 0,
        fallbackReason: "career-surface-detected",
      },
    };
  }

  return {
    finalUrl: page.url,
    extractionRoute: "UNKNOWN",
    parserVersion: "company-site:v2",
    confidence: 0.15,
    metadata: {},
  };
}

async function fetchCompanySiteJobs(
  options: CompanySiteConnectorOptions,
  fetchOptions: SourceConnectorFetchOptions
): Promise<SourceConnectorFetchResult> {
  if (options.extractionRoute === "STRUCTURED_SITEMAP") {
    return fetchCompanySiteJobsFromSitemap(options, fetchOptions);
  }

  const listingPages = await crawlListingPages(options.boardUrl, fetchOptions.signal);
  const jobsById = new Map<string, SourceConnectorJob>();

  for (const listingPage of listingPages) {
    const structuredJobs = extractStructuredJobs(
      listingPage.html,
      listingPage.url,
      options.companyName
    );

    for (const job of structuredJobs) {
      jobsById.set(job.sourceId, job);
      if (typeof fetchOptions.limit === "number" && jobsById.size >= fetchOptions.limit) {
        return buildFetchResult(options, jobsById, listingPages.length, true);
      }
    }
  }

  if (jobsById.size > 0 && options.extractionRoute !== "HTML_FALLBACK") {
    return buildFetchResult(options, jobsById, listingPages.length, true);
  }

  const detailLinks = collectDetailLinks(listingPages);
  const toVisit = detailLinks.slice(
    0,
    typeof fetchOptions.limit === "number"
      ? Math.min(MAX_DETAIL_PAGES, fetchOptions.limit * 2)
      : MAX_DETAIL_PAGES
  );

  for (const link of toVisit) {
    const detailPage = await fetchHtml(link.href, fetchOptions.signal);
    const jobs = extractStructuredJobs(detailPage.html, detailPage.url, options.companyName);
    const extracted =
      jobs.length > 0
        ? jobs
        : extractHtmlDetailJob(detailPage.html, detailPage.url, link.text, options.companyName);

    for (const job of extracted) {
      jobsById.set(job.sourceId, job);
      if (typeof fetchOptions.limit === "number" && jobsById.size >= fetchOptions.limit) {
        return buildFetchResult(options, jobsById, listingPages.length, false);
      }
    }
  }

  return buildFetchResult(options, jobsById, listingPages.length, false);
}

async function fetchCompanySiteJobsFromSitemap(
  options: CompanySiteConnectorOptions,
  fetchOptions: SourceConnectorFetchOptions
): Promise<SourceConnectorFetchResult> {
  const sitemap = await inspectSitemapCandidates(options.boardUrl, null, fetchOptions.signal);
  const jobsById = new Map<string, SourceConnectorJob>();
  const toVisit = sitemap.jobUrls.slice(
    0,
    typeof fetchOptions.limit === "number"
      ? Math.min(MAX_DETAIL_PAGES, Math.max(fetchOptions.limit * 3, fetchOptions.limit))
      : MAX_DETAIL_PAGES
  );

  for (const href of toVisit) {
    const detailPage = await fetchHtml(href, fetchOptions.signal);
    const jobs = extractStructuredJobs(detailPage.html, detailPage.url, options.companyName);
    const extracted =
      jobs.length > 0
        ? jobs
        : extractHtmlDetailJob(detailPage.html, detailPage.url, "", options.companyName);

    for (const job of extracted) {
      jobsById.set(job.sourceId, job);
      if (typeof fetchOptions.limit === "number" && jobsById.size >= fetchOptions.limit) {
        return buildFetchResult(options, jobsById, sitemap.scannedCount, true);
      }
    }
  }

  return buildFetchResult(options, jobsById, sitemap.scannedCount, true);
}

function buildFetchResult(
  options: CompanySiteConnectorOptions,
  jobsById: Map<string, SourceConnectorJob>,
  listingPageCount: number,
  usedStructuredRoute: boolean
): SourceConnectorFetchResult {
  return {
    jobs: [...jobsById.values()],
    metadata: {
      boardUrl: options.boardUrl,
      extractionRoute: options.extractionRoute,
      parserVersion: options.parserVersion ?? "company-site:v1",
      listingPageCount,
      usedStructuredRoute,
      totalFetched: jobsById.size,
    } as Prisma.InputJsonValue,
  };
}

async function crawlListingPages(url: string, signal?: AbortSignal) {
  const pages: HtmlFetchResult[] = [];
  const queue = [url];
  const visited = new Set<string>();

  while (queue.length > 0 && pages.length < MAX_LISTING_PAGES) {
    const nextUrl = queue.shift();
    if (!nextUrl || visited.has(nextUrl)) continue;
    visited.add(nextUrl);

    const page = await fetchHtml(nextUrl, signal);
    pages.push(page);

    for (const link of extractPaginationLinks(page.html, page.url)) {
      if (!visited.has(link.href) && queue.length < MAX_LISTING_PAGES) {
        queue.push(link.href);
      }
    }
  }

  return pages;
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<HtmlFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abortHandler = () => controller.abort();
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json",
        "User-Agent": "Mozilla/5.0 (compatible; autoapplication-company-site/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`Company site fetch failed: ${response.status} ${response.statusText}`);
    }

    return {
      url: response.url,
      html: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortHandler);
  }
}

function extractStructuredJobs(html: string, pageUrl: string, companyName: string) {
  const jobs = [
    ...extractJsonLdJobPostings(html, pageUrl),
    ...extractEmbeddedJobObjects(html, pageUrl),
  ];

  return dedupeStructuredJobs(jobs).map((job) => ({
    sourceId: buildSourceId(job.requisitionId, job.sourceUrl, job.title),
    sourceUrl: job.sourceUrl,
    title: job.title,
    company: job.company || companyName,
    location: job.location || "Unknown",
    description: job.description,
    applyUrl: job.applyUrl || job.sourceUrl,
    postedAt: job.postedAt,
    deadline: job.deadline,
    employmentType: job.employmentType,
    workMode: job.workMode,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    metadata: {
      source: "company-site",
      route: "structured",
      requisitionId: job.requisitionId,
      pageUrl,
      structuredMetadata: job.metadata,
    } as Prisma.InputJsonValue,
  }));
}

function extractHtmlDetailJob(
  html: string,
  pageUrl: string,
  linkText: string,
  companyName: string
) {
  const heading = extractPrimaryHeading(html) ?? linkText.trim();
  if (!heading || heading.length < 4) {
    return [];
  }

  const description = buildReadableDescription(html);
  if (description.length < 120) {
    return [];
  }

  return [
    {
      sourceId: buildSourceId(null, pageUrl, heading),
      sourceUrl: pageUrl,
      title: heading,
      company: companyName,
      location: extractLocation(html) ?? "Unknown",
      description,
      applyUrl: extractApplyUrl(html, pageUrl) ?? pageUrl,
      postedAt: extractDate(html, [
        /posted[^0-9a-z]{0,12}([a-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
      ]),
      deadline: extractDate(html, [
        /deadline[^0-9a-z]{0,12}([a-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
        /apply by[^0-9a-z]{0,12}([a-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
      ]),
      employmentType: inferEmploymentType(`${heading}\n${description}`),
      workMode: inferWorkMode(`${heading}\n${description}`),
      salaryMin: extractSalary(description).salaryMin,
      salaryMax: extractSalary(description).salaryMax,
      salaryCurrency: extractSalary(description).salaryCurrency,
      metadata: {
        source: "company-site",
        route: "html",
        pageUrl,
      } as Prisma.InputJsonValue,
    },
  ];
}

function extractJsonLdJobPostings(html: string, pageUrl: string): StructuredJobPosting[] {
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const jobs: StructuredJobPosting[] = [];

  for (const match of matches) {
    const raw = decodeHtmlEntities(match[1] ?? "");
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const candidate of flattenJsonLd(parsed)) {
        const job = mapStructuredCandidate(candidate, pageUrl);
        if (job) jobs.push(job);
      }
    } catch {
      continue;
    }
  }

  return jobs;
}

function flattenJsonLd(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenJsonLd(entry));
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  if (record["@graph"] && Array.isArray(record["@graph"])) {
    return flattenJsonLd(record["@graph"]);
  }

  return [record];
}

function extractEmbeddedJobObjects(html: string, pageUrl: string): StructuredJobPosting[] {
  const jobs: StructuredJobPosting[] = [];
  const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const match of scriptMatches) {
    const script = decodeHtmlEntities(match[1] ?? "");
    const snippets = script.match(/(\{[\s\S]{0,1200}"jobTitle"[\s\S]{0,4000}\})/gi) ?? [];
    for (const snippet of snippets.slice(0, 20)) {
      const parsed = safeParseLooseJson(snippet);
      if (!parsed) continue;
      const job = mapStructuredCandidate(parsed, pageUrl);
      if (job) jobs.push(job);
    }
  }

  return jobs;
}

function mapStructuredCandidate(candidate: unknown, pageUrl: string): StructuredJobPosting | null {
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const typeValue = String(record["@type"] ?? record.type ?? "").toLowerCase();
  const looksLikeJob =
    typeValue.includes("jobposting") ||
    "jobTitle" in record ||
    "title" in record ||
    "hiringOrganization" in record;

  if (!looksLikeJob) return null;

  const title = asString(record.title ?? record.jobTitle ?? record.name);
  const description = stripHtml(asString(record.description));
  const structuredSalary = extractStructuredSalary(record);
  const applyUrl =
    asString(record.url) ??
    asString(record.applicationUrl) ??
    asString(record.applyUrl) ??
    pageUrl;

  if (!title || !description || !applyUrl) return null;

  const baseText = `${title}\n${description}`;
  const salary = extractSalary(description);

  return {
    sourceUrl: asString(record.url) ?? pageUrl,
    title,
    company:
      asString((record.hiringOrganization as Record<string, unknown> | undefined)?.name) ??
      asString(record.company) ??
      "",
    location:
      extractStructuredLocation(record) ??
      asString(record.location) ??
      asString(record.jobLocationText) ??
      "",
    description,
    applyUrl,
    postedAt: parseDateValue(record.datePosted ?? record.postedDate),
    deadline: parseDateValue(record.validThrough ?? record.closeDate),
    employmentType: inferEmploymentType(baseText),
    workMode: extractStructuredWorkMode(record) ?? inferWorkMode(baseText),
    salaryMin: structuredSalary.salaryMin ?? salary.salaryMin,
    salaryMax: structuredSalary.salaryMax ?? salary.salaryMax,
    salaryCurrency: structuredSalary.salaryCurrency ?? salary.salaryCurrency,
    requisitionId: extractStructuredIdentifier(record),
    metadata: {
      structuredType: asString(record["@type"] ?? record.type),
    },
  };
}

function extractStructuredLocation(record: Record<string, unknown>) {
  const rawJobLocation = record.jobLocation;
  const locations = Array.isArray(rawJobLocation) ? rawJobLocation : [rawJobLocation];
  const parsed = locations
    .map((jobLocation) => {
      if (!jobLocation || typeof jobLocation !== "object") return null;
      const addressValue = (jobLocation as Record<string, unknown>).address;
      if (!addressValue || typeof addressValue !== "object") return null;

      const address = addressValue as Record<string, unknown>;
      const parts = [
        asString(address.addressLocality),
        asString(address.addressRegion),
        asString(address.addressCountry),
      ].filter((value): value is string => Boolean(value));
      return parts.length > 0 ? parts.join(", ") : asString(address.streetAddress);
    })
    .filter((value): value is string => Boolean(value));

  return parsed.length > 0 ? parsed.join(" | ") : null;
}

function dedupeStructuredJobs(jobs: StructuredJobPosting[]) {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    const key = `${job.requisitionId ?? ""}|${job.sourceUrl}|${job.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectDetailLinks(listingPages: HtmlFetchResult[]) {
  const seen = new Set<string>();
  const links: ParsedLink[] = [];

  for (const page of listingPages) {
    for (const link of [
      ...extractCandidateJobLinks(page.html, page.url),
      ...extractCandidateJobLinksFromScripts(page.html, page.url),
    ]) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      links.push(link);
    }
  }

  return links;
}

function extractCandidateJobLinks(html: string, pageUrl: string) {
  return extractLinks(html, pageUrl)
    .filter((link) => {
      const text = link.text.trim();
      return (
        text.length <= 140 &&
        JOB_LINK_RE.test(`${text} ${link.href}`) &&
        !PAGINATION_RE.test(text)
      );
    })
    .slice(0, MAX_LINKS_PER_PAGE);
}

function extractCandidateJobLinksFromScripts(html: string, pageUrl: string) {
  const base = new URL(pageUrl);
  const seen = new Set<string>();
  const links: ParsedLink[] = [];
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const directUrlMatches = /https?:\/\/[^"'`\s<>]+|\/(?:jobs?|careers?|positions?|openings?)[^"'`\s<>]*/gi;

  for (const match of scripts) {
    const script = decodeHtmlEntities(match[1] ?? "");
    const candidates = script.match(directUrlMatches) ?? [];

    for (const candidate of candidates.slice(0, 200)) {
      try {
        const href = new URL(candidate, base).toString();
        if (new URL(href).hostname !== base.hostname) continue;
        if (!JOB_LINK_RE.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        links.push({
          href,
          text: href.split("/").pop()?.replace(/[-_]+/g, " ").slice(0, 140) ?? href,
        });
      } catch {
        continue;
      }
    }
  }

  return links.slice(0, MAX_LINKS_PER_PAGE);
}

function extractPaginationLinks(html: string, pageUrl: string) {
  return extractLinks(html, pageUrl).filter((link) => PAGINATION_RE.test(link.text));
}

function extractLinks(html: string, pageUrl: string) {
  const base = new URL(pageUrl);
  const links: ParsedLink[] = [];
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];

  for (const match of matches) {
    const rawHref = decodeHtmlEntities(match[1] ?? "").trim();
    if (!rawHref || rawHref.startsWith("javascript:") || rawHref.startsWith("#")) continue;

    let href: string;
    try {
      href = new URL(rawHref, base).toString();
    } catch {
      continue;
    }

    if (new URL(href).hostname !== base.hostname) continue;

    const text = stripHtml(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    links.push({ href, text });
  }

  return links;
}

function looksLikeCareerSurface(html: string, pageUrl: string) {
  const text = buildReadableDescription(html).slice(0, 4000).toLowerCase();
  const pageSignals = `${pageUrl.toLowerCase()}\n${text}`;

  const positiveSignals = [
    /\bcareers?\b/,
    /\bopen roles?\b/,
    /\bopen positions?\b/,
    /\bjob openings?\b/,
    /\bjoin (our )?team\b/,
    /\bwork with us\b/,
    /\bsearch jobs\b/,
    /\bview jobs\b/,
    /\bcurrent openings\b/,
    /\bopportunities\b/,
  ];

  return positiveSignals.some((pattern) => pattern.test(pageSignals));
}

function buildReadableDescription(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/ul|\/ol|\/section|\/article|\/h[1-6])[^>]*>/gi, "\n")
      .replace(STRIP_TAGS_RE, " ")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  ).slice(0, 18_000);
}

function extractPrimaryHeading(html: string) {
  const headingMatch =
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ??
    html.match(/<title>([\s\S]*?)<\/title>/i);
  return headingMatch ? stripHtml(headingMatch[1]).replace(/\s+/g, " ").trim() : null;
}

function extractLocation(html: string) {
  const cleaned = buildReadableDescription(html);
  const match =
    cleaned.match(/location[:\s]+([^\n]+)/i) ??
    cleaned.match(/work location[:\s]+([^\n]+)/i);
  return match?.[1]?.trim() ?? null;
}

function extractApplyUrl(html: string, pageUrl: string) {
  const applyMatch = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].find(
    (match) => /apply/i.test(stripHtml(match[2] ?? ""))
  );
  if (!applyMatch) return null;

  try {
    return new URL(decodeHtmlEntities(applyMatch[1] ?? ""), pageUrl).toString();
  } catch {
    return null;
  }
}

function extractDate(text: string, patterns: RegExp[]) {
  const normalized = buildReadableDescription(text);
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const parsed = new Date(match[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function parseDateValue(value: unknown) {
  const stringValue = asString(value);
  if (!stringValue) return null;
  const parsed = new Date(stringValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractSalary(text: string) {
  const rangeMatch = text.match(/([$£€])\s?(\d[\d,]{2,})\s*(?:-|–|—|to)\s*([$£€])?\s?(\d[\d,]{2,})/);
  if (!rangeMatch) {
    return {
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    };
  }

  const symbol = rangeMatch[1] ?? rangeMatch[3] ?? "$";
  return {
    salaryMin: parseInt(rangeMatch[2].replace(/,/g, ""), 10),
    salaryMax: parseInt(rangeMatch[4].replace(/,/g, ""), 10),
    salaryCurrency: symbol === "$" ? "USD" : symbol === "£" ? "GBP" : "EUR",
  };
}

function inferEmploymentType(text: string): EmploymentType | null {
  if (/\bintern(ship)?\b/i.test(text)) return "INTERNSHIP";
  if (/\bcontract\b/i.test(text)) return "CONTRACT";
  if (/\bpart[- ]?time\b/i.test(text)) return "PART_TIME";
  return null;
}

function inferWorkMode(text: string): WorkMode | null {
  if (/\bhybrid\b/i.test(text)) return "HYBRID";
  if (/\bremote\b/i.test(text)) return "REMOTE";
  if (/\bon[- ]site\b/i.test(text) || /\bin office\b/i.test(text)) return "ONSITE";
  return null;
}

function buildSourceId(requisitionId: string | null, sourceUrl: string, title: string) {
  return requisitionId
    ? `company:${requisitionId}`
    : `company:${Buffer.from(`${sourceUrl}|${title}`).toString("base64url").slice(0, 48)}`;
}

function stripHtml(value: string | null | undefined) {
  return decodeHtmlEntities((value ?? "").replace(STRIP_TAGS_RE, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function asString(value: unknown) {
  return typeof value === "string" ? decodeHtmlEntities(value).trim() : null;
}

function safeParseLooseJson(input: string) {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&#x2013;/gi, "–")
    .replace(/&#x2014;/gi, "—")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2B;/gi, "+")
    .replace(/&#xE3;/gi, "ã")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&nbsp;/gi, " ");
}

async function inspectSitemapCandidates(
  pageUrl: string,
  pageHtml: string | null,
  signal?: AbortSignal
): Promise<SitemapInspection> {
  const base = new URL(pageUrl);
  const queue: string[] = [];
  const visited = new Set<string>();
  const jobUrls = new Set<string>();
  let primarySitemapUrl = pageUrl;
  let scannedCount = 0;

  const enqueue = (candidate: string | null | undefined) => {
    if (!candidate) return;
    try {
      const url = new URL(candidate, base).toString();
      if (new URL(url).hostname !== base.hostname) return;
      if (!looksLikeSitemapUrl(url)) return;
      if (visited.has(url) || queue.includes(url)) return;
      queue.push(url);
    } catch {
      return;
    }
  };

  if (pageHtml && looksLikeSitemapXml(pageHtml)) {
    enqueue(pageUrl);
  } else {
    enqueue(new URL("/sitemap.xml", base).toString());
    enqueue(new URL("/sitemap_index.xml", base).toString());
    for (const candidate of extractSitemapHintsFromHtml(pageHtml ?? "", pageUrl)) {
      enqueue(candidate);
    }
    for (const candidate of await fetchRobotsSitemaps(base, signal)) {
      enqueue(candidate);
    }
  }

  while (queue.length > 0 && visited.size < MAX_SITEMAP_FILES && jobUrls.size < MAX_SITEMAP_JOB_URLS) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    primarySitemapUrl = next;

    let xml: string;
    try {
      xml = next === pageUrl && pageHtml && looksLikeSitemapXml(pageHtml) ? pageHtml : (await fetchHtml(next, signal)).html;
    } catch {
      continue;
    }

    if (!looksLikeSitemapXml(xml)) continue;
    scannedCount += 1;

    for (const loc of extractSitemapLocs(xml)) {
      try {
        const href = new URL(loc, base).toString();
        if (new URL(href).hostname !== base.hostname) continue;
        if (looksLikeSitemapUrl(href)) {
          enqueue(href);
          continue;
        }
        if (looksLikeJobUrl(href)) {
          jobUrls.add(href);
          if (jobUrls.size >= MAX_SITEMAP_JOB_URLS) break;
        }
      } catch {
        continue;
      }
    }
  }

  return {
    sitemapUrl: primarySitemapUrl,
    scannedCount,
    jobUrls: [...jobUrls],
  };
}

function looksLikeSitemapXml(input: string) {
  return /<(urlset|sitemapindex)\b/i.test(input);
}

function looksLikeSitemapUrl(url: string) {
  return /sitemap/i.test(url) && /\.xml(?:\.gz)?(?:$|\?)/i.test(url);
}

function extractSitemapHintsFromHtml(html: string, pageUrl: string) {
  const hints = new Set<string>();
  const base = new URL(pageUrl);
  const relMatches = [...html.matchAll(/<link\b[^>]*rel=["'][^"']*sitemap[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi)];
  const directMatches = html.match(/https?:\/\/[^"'`\s<>]*sitemap[^"'`\s<>]*\.xml(?:\.gz)?/gi) ?? [];

  for (const match of relMatches) {
    const href = decodeHtmlEntities(match[1] ?? "").trim();
    try {
      hints.add(new URL(href, base).toString());
    } catch {
      continue;
    }
  }

  for (const candidate of directMatches) {
    try {
      hints.add(new URL(candidate, base).toString());
    } catch {
      continue;
    }
  }

  return [...hints];
}

async function fetchRobotsSitemaps(base: URL, signal?: AbortSignal) {
  try {
    const robots = await fetchHtml(new URL("/robots.txt", base).toString(), signal);
    return robots.html
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^sitemap:/i.test(line))
      .map((line) => line.replace(/^sitemap:\s*/i, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractSitemapLocs(xml: string) {
  return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((match) =>
    decodeHtmlEntities(match[1] ?? "").trim()
  );
}

function looksLikeJobUrl(url: string) {
  return JOB_LINK_RE.test(url) || /\/(jobs?|careers?|positions?|openings?)\//i.test(url);
}

function extractStructuredSalary(record: Record<string, unknown>) {
  const baseSalary = record.baseSalary;
  if (!baseSalary || typeof baseSalary !== "object") {
    return {
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    };
  }

  const salaryRecord = baseSalary as Record<string, unknown>;
  const value = salaryRecord.value;
  const currency = asString(salaryRecord.currency);
  if (!value || typeof value !== "object") {
    return {
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: currency,
    };
  }

  const range = value as Record<string, unknown>;
  const min = asNumber(range.minValue ?? range.value);
  const max = asNumber(range.maxValue ?? range.value);

  return {
    salaryMin: min,
    salaryMax: max,
    salaryCurrency: currency,
  };
}

function extractStructuredWorkMode(record: Record<string, unknown>) {
  const locationType = asString(record.jobLocationType);
  if (locationType && /telecommute/i.test(locationType)) {
    return "REMOTE" as const;
  }

  const applicantRequirements = Array.isArray(record.applicantLocationRequirements)
    ? record.applicantLocationRequirements
    : [record.applicantLocationRequirements];
  const combined = applicantRequirements
    .map((entry) => JSON.stringify(entry))
    .filter(Boolean)
    .join("\n");

  return inferWorkMode(combined);
}

function extractStructuredIdentifier(record: Record<string, unknown>) {
  const identifier = record.identifier;
  if (typeof identifier === "string") {
    return asString(identifier);
  }
  if (identifier && typeof identifier === "object") {
    const value = identifier as Record<string, unknown>;
    return asString(value.value) ?? asString(value.name) ?? null;
  }
  return asString(record.reqId) ?? null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
