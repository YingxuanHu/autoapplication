import axios from "axios";
import { DiscoveryMethod } from "@/generated/prisma";
import { fetchRobotsTxt, getCareerPaths, getSitemapUrls } from "./robots-parser";
import { rateLimiter } from "./rate-limiter";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 10_000;

const CAREER_PATH_PATTERNS = [
  "careers", "jobs", "join-us", "work-with-us", "open-roles",
  "hiring", "opportunities", "vacancies", "work-at",
];

const CAREER_PATH_REGEX = new RegExp(
  `\\b(${CAREER_PATH_PATTERNS.join("|")})\\b`,
  "i",
);

const HIGH_SIGNAL_JOB_PATHS = [
  /\/all-jobs\/?$/i,
  /\/jobs\/?$/i,
  /\/jobs\/results\/?$/i,
  /\/careers\/jobs\/?$/i,
  /\/open-roles\/?$/i,
  /\/open-positions\/?$/i,
  /\/search(?:-results)?\/?$/i,
];

const LOW_SIGNAL_PATHS = [
  /\/events?\//i,
  /\/resources?\//i,
  /\/press-release\//i,
  /\/news\//i,
  /\/blog\//i,
  /\/help\//i,
  /\/awards?\//i,
  /\/benefits?\//i,
  /\/team-playbook\/?$/i,
  /\/interviewing\/?$/i,
  /\/applying\/?$/i,
  /\/teamanywhere\/?$/i,
  /\/team-everyone\/?$/i,
  /\/candidate-prep\/?$/i,
  /\/connect-with-a-googler\/?$/i,
  /\/join\/?$/i,
  /\/team\/?$/i,
];

export interface CareerPageResult {
  url: string;
  method: DiscoveryMethod;
  confidence: number;
}

/**
 * Discover career pages for a given domain by scanning homepage links,
 * robots.txt, and sitemap.xml.
 */
export async function discoverCareerPages(domain: string): Promise<CareerPageResult[]> {
  const results: CareerPageResult[] = [];

  const [homepageResults, robotsResults, sitemapResults] = await Promise.allSettled([
    scanHomepage(domain),
    scanRobotsTxt(domain),
    scanSitemaps(domain),
  ]);

  if (homepageResults.status === "fulfilled") {
    results.push(...homepageResults.value);
  }
  if (robotsResults.status === "fulfilled") {
    results.push(...robotsResults.value);
  }
  if (sitemapResults.status === "fulfilled") {
    results.push(...sitemapResults.value);
  }

  // Deduplicate by URL and keep highest confidence
  const urlMap = new Map<string, CareerPageResult>();
  for (const result of results) {
    const normalized = normalizeUrl(result.url);
    const existing = urlMap.get(normalized);
    if (!existing || result.confidence > existing.confidence) {
      urlMap.set(normalized, { ...result, url: normalized });
    }
  }

  // Sort by confidence descending
  return Array.from(urlMap.values()).sort((a, b) => b.confidence - a.confidence);
}

/**
 * Fetch the homepage and scan for career-related links.
 */
async function scanHomepage(domain: string): Promise<CareerPageResult[]> {
  const results: CareerPageResult[] = [];

  try {
    await rateLimiter.waitForSlot(domain);
    const response = await axios.get<string>(`https://${domain}`, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      maxRedirects: 5,
    });

    const html = typeof response.data === "string" ? response.data : "";
    const links = extractLinks(html, domain);

    for (const link of links) {
      const path = getPathname(link);
      if (!path) continue;

      const pathLower = path.toLowerCase();
      const segments = pathLower.split("/").filter(Boolean);

      // Exact match: a top-level segment is exactly a career keyword
      const isExactMatch = segments.some((segment) =>
        CAREER_PATH_PATTERNS.includes(segment),
      );

      if (isExactMatch) {
        const confidence = scoreCareerUrl(link, 0.9);
        if (confidence == null) continue;

        results.push({
          url: link,
          method: DiscoveryMethod.HOMEPAGE_LINK,
          confidence,
        });
      } else if (CAREER_PATH_REGEX.test(pathLower)) {
        const confidence = scoreCareerUrl(link, 0.6);
        if (confidence == null) continue;

        results.push({
          url: link,
          method: DiscoveryMethod.HOMEPAGE_LINK,
          confidence,
        });
      }
    }
  } catch {
    // Homepage fetch failed; continue with other methods
  }

  return results;
}

/**
 * Scan robots.txt for career-related paths.
 */
async function scanRobotsTxt(domain: string): Promise<CareerPageResult[]> {
  const results: CareerPageResult[] = [];

  try {
    const robotsTxt = await fetchRobotsTxt(domain);
    if (!robotsTxt) return results;

    const careerPaths = getCareerPaths(robotsTxt);
    for (const path of careerPaths) {
      // Clean up the path (remove wildcards, etc.)
      const cleanPath = path.replace(/\*/g, "").replace(/\$$/, "");
      if (!cleanPath || cleanPath === "/") continue;

      const url = `https://${domain}${cleanPath}`;
      const confidence = scoreCareerUrl(url, 0.5);
      if (confidence == null) continue;

      results.push({
        url,
        method: DiscoveryMethod.ROBOTS_TXT,
        confidence,
      });
    }
  } catch {
    // robots.txt fetch failed; continue
  }

  return results;
}

/**
 * Scan sitemaps for career-related URLs.
 */
async function scanSitemaps(domain: string): Promise<CareerPageResult[]> {
  const results: CareerPageResult[] = [];

  try {
    // Try fetching robots.txt for sitemap references
    const robotsTxt = await fetchRobotsTxt(domain);
    const sitemapUrls = robotsTxt
      ? getSitemapUrls(robotsTxt)
      : [`https://${domain}/sitemap.xml`];

    if (sitemapUrls.length === 0) {
      sitemapUrls.push(`https://${domain}/sitemap.xml`);
    }

    const careerUrls = await fetchSitemapCareerUrls(sitemapUrls, domain, 0);

    for (const url of careerUrls) {
      const confidence = scoreCareerUrl(url, 0.7);
      if (confidence == null) continue;

      results.push({
        url,
        method: DiscoveryMethod.SITEMAP,
        confidence,
      });
    }
  } catch {
    // sitemap fetch failed; continue
  }

  return results;
}

/**
 * Recursively fetch sitemaps (including sitemap indexes) and extract career URLs.
 */
async function fetchSitemapCareerUrls(
  sitemapUrls: string[],
  domain: string,
  depth: number,
): Promise<string[]> {
  if (depth > 3) return []; // Prevent infinite recursion

  const careerUrls: string[] = [];

  for (const sitemapUrl of sitemapUrls) {
    try {
      await rateLimiter.waitForSlot(domain);
      const response = await axios.get<string>(sitemapUrl, {
        timeout: REQUEST_TIMEOUT,
        headers: { "User-Agent": USER_AGENT },
        responseType: "text",
        validateStatus: (status) => status < 500,
      });

      if (response.status !== 200) continue;
      const xml = typeof response.data === "string" ? response.data : "";

      // Check if this is a sitemap index
      if (xml.includes("<sitemapindex")) {
        const nestedUrls = extractXmlLocs(xml, "sitemap");
        // Only follow sitemaps that might contain career URLs
        const relevantSitemaps = nestedUrls.filter((url) => {
          const lower = url.toLowerCase();
          return (
            CAREER_PATH_REGEX.test(lower) ||
            !lower.includes("product") // follow generic sitemaps too
          );
        });

        // Limit to 5 nested sitemaps to avoid excessive requests
        const limitedSitemaps = relevantSitemaps.slice(0, 5);
        const nested = await fetchSitemapCareerUrls(limitedSitemaps, domain, depth + 1);
        careerUrls.push(...nested);
      } else {
        // Regular sitemap - extract career-related URLs
        const urls = extractXmlLocs(xml, "url");
        for (const url of urls) {
          if (CAREER_PATH_REGEX.test(url.toLowerCase())) {
            careerUrls.push(url);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return careerUrls;
}

/**
 * Extract <loc> values from a sitemap XML string.
 */
function extractXmlLocs(xml: string, parentTag: "url" | "sitemap"): string[] {
  const locs: string[] = [];
  const regex = new RegExp(`<${parentTag}>[\\s\\S]*?<loc>([^<]+)</loc>[\\s\\S]*?</${parentTag}>`, "gi");
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const loc = match[1]?.trim();
    if (loc) locs.push(loc);
  }

  return locs;
}

/**
 * Extract all href links from HTML and resolve them against the domain.
 */
function extractLinks(html: string, domain: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1]?.trim();
    if (!href) continue;

    try {
      let resolved: string;
      if (href.startsWith("http://") || href.startsWith("https://")) {
        resolved = href;
      } else if (href.startsWith("//")) {
        resolved = `https:${href}`;
      } else if (href.startsWith("/")) {
        resolved = `https://${domain}${href}`;
      } else {
        resolved = `https://${domain}/${href}`;
      }
      // Only include links on the same domain or subdomains
      const parsedUrl = new URL(resolved);
      if (parsedUrl.hostname === domain || parsedUrl.hostname.endsWith(`.${domain}`)) {
        links.push(resolved);
      }
    } catch {
      continue;
    }
  }

  return links;
}

/**
 * Get the pathname from a URL string.
 */
function getPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Normalize a URL by removing trailing slashes, fragments, and lowercasing.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    // Remove trailing slash (except root)
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function scoreCareerUrl(url: string, baseConfidence: number): number | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    if (
      parsed.hostname.startsWith("events.") ||
      parsed.hostname.startsWith("docs.") ||
      parsed.hostname.startsWith("developer.") ||
      parsed.hostname.startsWith("forum.") ||
      parsed.hostname.startsWith("blog.") ||
      parsed.hostname.startsWith("community.") ||
      parsed.hostname.startsWith("support.") ||
      LOW_SIGNAL_PATHS.some((pattern) => pattern.test(path))
    ) {
      return null;
    }

    if (path.includes("/applications/") && !path.includes("/jobs/results")) {
      return null;
    }

    let confidence = baseConfidence;

    if (HIGH_SIGNAL_JOB_PATHS.some((pattern) => pattern.test(path))) {
      confidence += 0.3;
    }

    if (search.includes("team=") || search.includes("search=") || search.includes("location=")) {
      confidence += 0.15;
    }

    if (search.includes("utm_")) {
      confidence -= 0.2;
    }

    if (path.includes("/team/") || path.endsWith("/team")) {
      confidence -= 0.15;
    }

    if (path.endsWith("/careers") || path.endsWith("/company/careers")) {
      confidence -= 0.05;
    }

    if (path.includes("/jobs/results")) {
      confidence += 0.25;
    }

    return Math.max(0.1, Math.min(0.99, confidence));
  } catch {
    return baseConfidence;
  }
}
