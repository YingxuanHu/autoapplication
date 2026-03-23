import axios from "axios";
import { rateLimiter } from "./rate-limiter";
import { crawlGoogleCareers } from "./connectors/google-careers";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 10_000;
const MAX_JOBS_TO_CRAWL = 50;
const MAX_LISTING_PAGES_TO_EXPAND = 12;

const JOB_LINK_PATTERNS = [
  /\/job\//i,
  /\/jobs\//i,
  /\/position\//i,
  /\/positions\//i,
  /\/opening\//i,
  /\/openings\//i,
  /\/role\//i,
  /\/roles\//i,
  /\/career\//i,
  /\/vacancy\//i,
  /\/posting\//i,
];

/**
 * Heuristic patterns that suggest a link text is a job title.
 * Job title links typically do NOT match generic navigation patterns.
 */
const NON_JOB_LINK_PATTERNS = [
  /^(home|about|contact|blog|news|press|login|sign|privacy|terms|cookie|faq)/i,
  /^(back|next|previous|more|view all|see all|load more|show more)/i,
  /^(facebook|twitter|linkedin|instagram|youtube)/i,
  /^(support home|legal disclosures(?: and notices)?|job details|candidate prep|connect with a googler)$/i,
];

const LISTING_PATH_PATTERNS = [
  /\/jobs\/?$/i,
  /\/careers\/?$/i,
  /\/all-jobs\/?$/i,
  /\/open-roles\/?$/i,
  /\/open-positions\/?$/i,
  /\/positions\/?$/i,
];

const LISTING_TEXT_PATTERNS = [
  /^jobs$/i,
  /^careers$/i,
  /^open roles$/i,
  /^open positions$/i,
  /^all jobs$/i,
  /^browse all jobs$/i,
  /^view all jobs$/i,
  /^search jobs$/i,
  /^see open roles$/i,
];

export interface CrawledJob {
  title: string;
  location: string | null;
  description: string;
  applyUrl: string | null;
  url: string;
}

interface CandidateLink {
  url: string;
  kind: "detail" | "listing";
}

/**
 * Crawl a custom career page to find individual job postings.
 * Extracts job links from the listing page, then fetches each one.
 */
export async function crawlCustomCareerPage(url: string): Promise<CrawledJob[]> {
  if (isGoogleCareersUrl(url)) {
    return crawlGoogleCareers(url);
  }

  const jobs = new Map<string, CrawledJob>();

  try {
    const listingPagesToVisit = [url];
    const seenListingPages = new Set<string>();
    const jobLinks = new Set<string>();

    while (
      listingPagesToVisit.length > 0 &&
      seenListingPages.size < MAX_LISTING_PAGES_TO_EXPAND &&
      jobs.size + jobLinks.size < MAX_JOBS_TO_CRAWL
    ) {
      const pageUrl = listingPagesToVisit.shift();
      if (!pageUrl || seenListingPages.has(pageUrl)) continue;
      seenListingPages.add(pageUrl);

      const html = await fetchHtmlPage(pageUrl);
      if (!html) continue;

      const directJobs = extractJobsFromListingPage(html, pageUrl);
      for (const job of directJobs) {
        jobs.set(job.url, job);
      }

      const candidates = extractJobLinks(html, pageUrl);

      for (const candidate of candidates) {
        if (candidate.kind === "detail") {
          if (jobs.has(candidate.url)) continue;
          jobLinks.add(candidate.url);
          continue;
        }

        if (
          !seenListingPages.has(candidate.url) &&
          listingPagesToVisit.length < MAX_LISTING_PAGES_TO_EXPAND
        ) {
          listingPagesToVisit.push(candidate.url);
        }
      }
    }

    const remainingCapacity = Math.max(0, MAX_JOBS_TO_CRAWL - jobs.size);
    const linksToProcess = [...jobLinks].slice(0, remainingCapacity);

    for (const link of linksToProcess) {
      try {
        const job = await fetchJobPage(link);
        if (job) {
          jobs.set(job.url, job);
        }
      } catch {
        // Skip individual job errors, continue with others
        continue;
      }
    }
  } catch {
    // Main page fetch failed
  }

  return [...jobs.values()];
}

function isGoogleCareersUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith("google.com") &&
      parsed.pathname.includes("/about/careers/applications/jobs/results")
    );
  } catch {
    return false;
  }
}

async function fetchHtmlPage(url: string): Promise<string | null> {
  try {
    const domain = new URL(url).hostname;
    await rateLimiter.waitForSlot(domain);

    const response = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    if (response.status !== 200) return null;
    return typeof response.data === "string" ? response.data : null;
  } catch {
    return null;
  }
}

/**
 * Extract links that look like individual job postings from a listing page.
 */
function extractJobLinks(html: string, baseUrl: string): CandidateLink[] {
  const links: CandidateLink[] = [];
  const seen = new Set<string>();

  // Match <a> tags with href
  const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]?.trim();
    const linkText = stripHtml(match[2] || "").trim();

    if (!href) continue;

    // Resolve relative URLs
    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    // Skip if already seen
    if (seen.has(resolvedUrl)) continue;

    const kind = classifyCandidateLink(resolvedUrl, linkText);
    if (kind) {
      seen.add(resolvedUrl);
      links.push({ url: resolvedUrl, kind });
    }
  }

  return links;
}

function extractJobsFromListingPage(html: string, baseUrl: string): CrawledJob[] {
  const jobs: CrawledJob[] = [];
  const seen = new Set<string>();

  const directJobLinkRegex =
    /<a[^>]*href\s*=\s*["']([^"']*(?:\/jobs\/apply\/\d+|\/apply\/[a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = directJobLinkRegex.exec(html)) !== null) {
    const href = match[1]?.trim();
    const innerHtml = match[2] || "";
    if (!href) continue;

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (seen.has(resolvedUrl)) continue;

    const textParts = [...innerHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((entry) => stripHtml(entry[1] || "").trim())
      .filter(Boolean);
    const plainText = stripHtml(innerHtml);
    const title = textParts[0] || plainText.split(/\s{2,}|\n/)[0]?.trim();

    if (!title || !looksLikeJobTitle(title)) continue;

    const location = textParts[1] || null;
    jobs.push({
      title,
      location,
      description: buildListingDescription(title, location, baseUrl),
      applyUrl: resolvedUrl,
      url: resolvedUrl,
    });
    seen.add(resolvedUrl);
  }

  return jobs;
}

function classifyCandidateLink(
  resolvedUrl: string,
  linkText: string,
): CandidateLink["kind"] | null {
  if (!linkText || linkText.length > 200) return null;
  if (NON_JOB_LINK_PATTERNS.some((pattern) => pattern.test(linkText))) return null;

  const pathname = getPathname(resolvedUrl) ?? "";
  const normalizedText = linkText.trim();
  const isListingPath = LISTING_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
  const isListingText = LISTING_TEXT_PATTERNS.some((pattern) => pattern.test(normalizedText));
  const isLocationListing = /^\/jobs\/[a-z-]+\/?$/i.test(pathname) && !looksLikeJobTitle(normalizedText);
  const isJobPath = JOB_LINK_PATTERNS.some((pattern) => pattern.test(pathname));
  const isJobText = looksLikeJobTitle(normalizedText);

  if (isListingPath || isListingText || isLocationListing) {
    return "listing";
  }

  if (isJobPath || isJobText) {
    return "detail";
  }

  return null;
}

/**
 * Check if link text looks like a job title.
 */
function looksLikeJobTitle(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (
    [
      "job details",
      "support home",
      "legal disclosures",
      "legal disclosures and notices",
      "candidate prep",
      "connect with a googler",
      "careers",
      "jobs",
    ].includes(normalized)
  ) {
    return false;
  }

  // Job titles typically contain role-related keywords
  const roleKeywords =
    /\b(engineer|developer|designer|manager|analyst|coordinator|specialist|director|lead|senior|junior|intern|associate|consultant|architect|administrator|recruiter|sales|marketing|product|data|software|frontend|backend|full.?stack|devops|qa|test|support|operations|finance|hr|legal|executive)\b/i;

  return roleKeywords.test(text);
}

/**
 * Fetch an individual job page and extract job details.
 */
async function fetchJobPage(url: string): Promise<CrawledJob | null> {
  try {
    const html = await fetchHtmlPage(url);
    if (!html) return null;
    return extractJobDetails(html, url);
  } catch {
    return null;
  }
}

/**
 * Extract job details from a job posting page.
 */
function extractJobDetails(html: string, url: string): CrawledJob | null {
  const title = extractTitle(html);
  if (!title) return null;
  if (LISTING_TEXT_PATTERNS.some((pattern) => pattern.test(title))) return null;
  if (!looksLikeJobTitle(title)) return null;

  return {
    title,
    location: extractJobLocation(html),
    description: extractMainContent(html),
    applyUrl: extractApplyLink(html, url),
    url,
  };
}

function buildListingDescription(
  title: string,
  location: string | null,
  pageUrl: string,
): string {
  const locationLine = location ? `Location: ${location}. ` : "";
  return `${title}. ${locationLine}Discovered from ${pageUrl}.`.trim();
}

/**
 * Extract the job title from the page.
 * Priority: h1 > og:title > title tag
 */
function extractTitle(html: string): string | null {
  // Try h1
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const text = stripHtml(h1Match[1] || "").trim();
    if (text.length > 2 && text.length < 200) return text;
  }

  // Try og:title
  const ogMatch = html.match(/<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i);
  if (ogMatch) {
    const text = ogMatch[1]?.trim();
    if (text && text.length > 2) return text;
  }

  // Try title tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const text = stripHtml(titleMatch[1] || "").trim();
    // Remove common suffixes like " | Company Name" or " - Company"
    const cleaned = text.split(/\s*[|\-–—]\s*/)[0]?.trim();
    if (cleaned && cleaned.length > 2) return cleaned;
  }

  return null;
}

/**
 * Extract location from common patterns on a job page.
 */
function extractJobLocation(html: string): string | null {
  // Check for common location indicators
  const locationPatterns = [
    /<(?:span|div|p)[^>]*class\s*=\s*["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div|p)>/i,
    /<(?:span|div|p)[^>]*data-\w*location[^>]*>([\s\S]*?)<\/(?:span|div|p)>/i,
    /(?:location|office)\s*:\s*([^<\n]{3,80})/i,
  ];

  for (const pattern of locationPatterns) {
    const match = html.match(pattern);
    if (match) {
      const text = stripHtml(match[1] || "").trim();
      if (text.length >= 2 && text.length <= 100) return text;
    }
  }

  // Check meta tags
  const geoMatch = html.match(/<meta[^>]*name\s*=\s*["']geo\.placename["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  if (geoMatch) return geoMatch[1]?.trim() || null;

  return null;
}

/**
 * Extract the main content area of a page as plain text.
 */
function extractMainContent(html: string): string {
  // Try to find the main content area
  const mainPatterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:content|description|job-detail|job-description|posting)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of mainPatterns) {
    const match = html.match(pattern);
    if (match) {
      const content = match[1] || match[2] || "";
      const text = stripHtml(content).trim();
      if (text.length > 50) return text;
    }
  }

  // Fall back to body content, stripping nav/footer/header/script/style
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "");

  const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1] || "";

  return stripHtml(body).trim().slice(0, 5000);
}

/**
 * Extract an apply URL from the page.
 */
function extractApplyLink(html: string, pageUrl: string): string | null {
  // Look for apply buttons/links
  const applyPatterns = [
    /<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?apply[\s\S]*?<\/a>/i,
    /<a[^>]*class\s*=\s*["'][^"']*apply[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/i,
    /<button[^>]*data-href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?apply[\s\S]*?<\/button>/i,
  ];

  for (const pattern of applyPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return new URL(match[1], pageUrl).toString();
      } catch {
        continue;
      }
    }
  }

  return pageUrl;
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Get pathname from URL string.
 */
function getPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
