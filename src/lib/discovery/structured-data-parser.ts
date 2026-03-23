import axios from "axios";
import { rateLimiter } from "./rate-limiter";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 10_000;

export interface ParsedJobPosting {
  title: string;
  company: string;
  location: string;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  description: string;
  datePosted: string | null;
  validThrough: string | null;
  applyUrl: string;
  workMode: "REMOTE" | "HYBRID" | "ONSITE" | null;
}

/**
 * Fetch a page and extract all JobPosting structured data (JSON-LD).
 */
export async function parseJobPostings(url: string): Promise<ParsedJobPosting[]> {
  try {
    const domain = new URL(url).hostname;
    await rateLimiter.waitForSlot(domain);

    const response = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      maxRedirects: 5,
    });

    const html = typeof response.data === "string" ? response.data : "";
    return extractJobPostingsFromHtml(html, url);
  } catch {
    return [];
  }
}

/**
 * Extract JSON-LD JobPosting data from HTML.
 */
export function extractJobPostingsFromHtml(
  html: string,
  pageUrl: string,
): ParsedJobPosting[] {
  const results: ParsedJobPosting[] = [];
  const jsonLdRegex =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    const content = match[1]?.trim();
    if (!content) continue;

    try {
      const parsed = JSON.parse(content);
      const items = normalizeJsonLd(parsed);

      for (const item of items) {
        if (isJobPosting(item)) {
          const posting = mapJobPosting(item, pageUrl);
          if (posting) {
            results.push(posting);
          }
        }
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  return results;
}

/**
 * Normalize JSON-LD into an array of items.
 * Handles @graph, arrays, and single objects.
 */
function normalizeJsonLd(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];

  if (Array.isArray(data)) {
    return data.flatMap((item) => normalizeJsonLd(item));
  }

  const obj = data as Record<string, unknown>;

  // Handle @graph containing multiple items
  if (Array.isArray(obj["@graph"])) {
    return obj["@graph"].flatMap((item: unknown) => normalizeJsonLd(item));
  }

  return [obj];
}

/**
 * Check if a JSON-LD item is a JobPosting.
 */
function isJobPosting(item: Record<string, unknown>): boolean {
  const type = item["@type"];
  if (typeof type === "string") {
    return type === "JobPosting" || type === "schema:JobPosting";
  }
  if (Array.isArray(type)) {
    return type.some(
      (t) => t === "JobPosting" || t === "schema:JobPosting",
    );
  }
  return false;
}

/**
 * Map a JSON-LD JobPosting to our normalized format.
 */
function mapJobPosting(
  item: Record<string, unknown>,
  pageUrl: string,
): ParsedJobPosting | null {
  const title = getString(item, "title") || getString(item, "name");
  if (!title) return null;

  const company = extractCompanyName(item);
  const location = extractLocation(item);
  const salary = extractSalary(item);
  const description = extractDescription(item);

  return {
    title,
    company: company || "Unknown",
    location: location || "",
    employmentType: extractEmploymentType(item),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    description: description || "",
    datePosted: getString(item, "datePosted"),
    validThrough: getString(item, "validThrough"),
    applyUrl: extractApplyUrl(item) || pageUrl,
    workMode: inferWorkModeFromPosting(item, location),
  };
}

/**
 * Extract company name from hiringOrganization.
 */
function extractCompanyName(item: Record<string, unknown>): string {
  const org = item["hiringOrganization"];
  if (typeof org === "string") return org;
  if (org && typeof org === "object") {
    const orgObj = org as Record<string, unknown>;
    return getString(orgObj, "name") || getString(orgObj, "legalName") || "";
  }
  return "";
}

/**
 * Extract location from jobLocation.
 */
function extractLocation(item: Record<string, unknown>): string {
  const loc = item["jobLocation"];
  if (typeof loc === "string") return loc;

  const locations: string[] = [];
  const locArray = Array.isArray(loc) ? loc : loc ? [loc] : [];

  for (const l of locArray) {
    if (typeof l === "string") {
      locations.push(l);
      continue;
    }
    if (l && typeof l === "object") {
      const locObj = l as Record<string, unknown>;
      const address = locObj["address"];

      if (typeof address === "string") {
        locations.push(address);
      } else if (address && typeof address === "object") {
        const addr = address as Record<string, unknown>;
        const parts = [
          getString(addr, "addressLocality"),
          getString(addr, "addressRegion"),
          getString(addr, "addressCountry"),
        ].filter(Boolean);
        if (parts.length > 0) {
          locations.push(parts.join(", "));
        }
      }

      // Fall back to name
      if (locations.length === 0) {
        const name = getString(locObj, "name");
        if (name) locations.push(name);
      }
    }
  }

  return locations.join("; ");
}

/**
 * Extract salary information from baseSalary.
 */
function extractSalary(
  item: Record<string, unknown>,
): { min: number | null; max: number | null; currency: string | null } {
  const result = { min: null as number | null, max: null as number | null, currency: null as string | null };

  const salary = item["baseSalary"];
  if (!salary || typeof salary !== "object") return result;

  const salaryObj = salary as Record<string, unknown>;
  result.currency = getString(salaryObj, "currency");

  const value = salaryObj["value"];
  if (typeof value === "number") {
    result.min = value;
    result.max = value;
  } else if (value && typeof value === "object") {
    const valueObj = value as Record<string, unknown>;
    const minVal = valueObj["minValue"] ?? valueObj["value"];
    const maxVal = valueObj["maxValue"] ?? valueObj["value"];

    if (typeof minVal === "number") result.min = minVal;
    else if (typeof minVal === "string") {
      const parsed = parseFloat(minVal);
      if (!isNaN(parsed)) result.min = parsed;
    }

    if (typeof maxVal === "number") result.max = maxVal;
    else if (typeof maxVal === "string") {
      const parsed = parseFloat(maxVal);
      if (!isNaN(parsed)) result.max = parsed;
    }

    // Currency might be in the value object
    if (!result.currency) {
      result.currency = getString(valueObj, "currency") || getString(valueObj, "unitText");
    }
  }

  return result;
}

/**
 * Extract employment type.
 */
function extractEmploymentType(item: Record<string, unknown>): string | null {
  const type = item["employmentType"];
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.filter((t) => typeof t === "string").join(", ");
  return null;
}

/**
 * Extract description, handling both plain text and HTML.
 */
function extractDescription(item: Record<string, unknown>): string {
  const desc = getString(item, "description");
  if (!desc) return "";

  // Strip HTML tags for plain text
  return desc
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
 * Extract the application URL.
 */
function extractApplyUrl(item: Record<string, unknown>): string | null {
  // Check directApply URL
  const directApply = item["directApply"];
  if (typeof directApply === "string" && directApply.startsWith("http")) {
    return directApply;
  }

  // Check applicationContact
  const contact = item["applicationContact"];
  if (contact && typeof contact === "object") {
    const contactObj = contact as Record<string, unknown>;
    const url = getString(contactObj, "url");
    if (url) return url;
  }

  // Check url field
  const url = getString(item, "url");
  if (url) return url;

  return null;
}

/**
 * Infer work mode from job posting fields.
 */
function inferWorkModeFromPosting(
  item: Record<string, unknown>,
  location: string,
): "REMOTE" | "HYBRID" | "ONSITE" | null {
  // Check jobLocationType (schema.org standard)
  const locationType = getString(item, "jobLocationType");
  if (locationType) {
    const lower = locationType.toLowerCase();
    if (lower.includes("telecommute") || lower.includes("remote")) return "REMOTE";
  }

  // Check applicantLocationRequirements
  const locReq = item["applicantLocationRequirements"];
  if (locReq) return "REMOTE";

  // Infer from location text
  const lower = location.toLowerCase();
  if (lower.includes("remote")) return "REMOTE";
  if (lower.includes("hybrid")) return "HYBRID";

  // Check employment type for remote indicators
  const empType = extractEmploymentType(item);
  if (empType?.toLowerCase().includes("remote")) return "REMOTE";

  return null;
}

/**
 * Safely extract a string value from an object.
 */
function getString(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  if (typeof val === "string") return val;
  return null;
}
