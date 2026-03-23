import axios from "axios";
import type { CrawledJob } from "../custom-crawler";

const USER_AGENT = "AutoApplicationBot/1.0";
const REQUEST_TIMEOUT = 15_000;
const DEFAULT_MAX_PAGES = 5;
const GOOGLE_RESULTS_PATH = "/about/careers/applications/jobs/results";

type GoogleLocation = [string?, ...unknown[]];
type GoogleTextBlock = [null, string?];
type GoogleJobRecord = [
  string?,
  string?,
  string?,
  GoogleTextBlock?,
  GoogleTextBlock?,
  string?,
  null?,
  string?,
  string?,
  GoogleLocation[]?,
  GoogleTextBlock?,
  ...unknown[],
];

type GoogleDataPayload = [GoogleJobRecord[], ...unknown[]];

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\u003c/gi, "<")
    .replace(/\u003e/gi, ">")
    .replace(/\u0026/gi, "&");
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeGoogleUrl(url: string, page: number): string {
  const parsed = new URL(url);
  parsed.pathname = GOOGLE_RESULTS_PATH;
  parsed.searchParams.delete("page");
  if (page > 1) {
    parsed.searchParams.set("page", String(page));
  }
  return parsed.toString();
}

function extractDataArray(html: string): string | null {
  const marker = "AF_initDataCallback({key: 'ds:1'";
  const start = html.indexOf(marker);
  if (start < 0) return null;

  const dataIdx = html.indexOf("data:", start);
  if (dataIdx < 0) return null;

  const firstBracket = html.indexOf("[", dataIdx);
  if (firstBracket < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBracket; i < html.length; i++) {
    const ch = html[i]!;

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        return html.slice(firstBracket, i + 1);
      }
    }
  }

  return null;
}

function mapGoogleJob(job: GoogleJobRecord, fallbackUrl: string): CrawledJob | null {
  const id = job[0]?.trim();
  const title = job[1]?.trim();
  const applyUrl = job[2]?.trim();
  const company = job[7]?.trim() || "Google";
  const location = job[9]?.[0]?.[0]?.trim() || null;
  const highlights = htmlToPlainText(job[3]?.[1] ?? "");
  const qualifications = htmlToPlainText(job[4]?.[1] ?? "");
  const description = htmlToPlainText(job[10]?.[1] ?? "");

  if (!id || !title || !applyUrl) return null;

  const combinedDescription = [description, highlights, qualifications]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    title,
    location,
    description:
      combinedDescription || `${title} at ${company}${location ? ` in ${location}` : ""}.`,
    applyUrl,
    url: applyUrl || fallbackUrl,
  };
}

export async function crawlGoogleCareers(url: string): Promise<CrawledJob[]> {
  const jobs = new Map<string, CrawledJob>();

  for (let page = 1; page <= DEFAULT_MAX_PAGES; page++) {
    const pageUrl = normalizeGoogleUrl(url, page);
    const response = await axios.get<string>(pageUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    if (response.status !== 200 || typeof response.data !== "string") {
      break;
    }

    const dataString = extractDataArray(response.data);
    if (!dataString) break;

    let parsed: GoogleDataPayload;
    try {
      parsed = JSON.parse(dataString) as GoogleDataPayload;
    } catch {
      break;
    }

    const pageJobs = Array.isArray(parsed[0]) ? parsed[0] : [];
    if (pageJobs.length === 0) break;

    for (const entry of pageJobs) {
      const mapped = mapGoogleJob(entry, pageUrl);
      if (mapped) {
        jobs.set(mapped.url, mapped);
      }
    }

    if (pageJobs.length < 20) break;
  }

  return [...jobs.values()];
}
