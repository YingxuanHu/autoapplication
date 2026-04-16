/**
 * We Work Remotely RSS connector.
 *
 * WWR publishes per-category RSS feeds at:
 *   https://weworkremotely.com/remote-jobs.rss           (aggregate, ~100 items)
 *   https://weworkremotely.com/categories/{slug}.rss     (per category)
 *
 * Each <item> carries structured fields not found on most RSS feeds — region,
 * country, state, category, type, and an explicit <expires_at> (30 days from
 * posting). We fan out across 11 category feeds and dedupe on <guid>.
 *
 * Volume: ~500-1,000 unique remote jobs at any time (high overlap across feeds).
 * Net-new value for NA: MEDIUM-HIGH. WWR listings are explicitly remote-friendly
 * and many are US/NA-hirable; they are often missing from ATS boards because
 * remote-first startups post here first.
 *
 * Canada relevance: Jobs tagged "Anywhere in the World", "USA and Canada",
 * "North America", or with Canadian state codes are flagged as Canada-eligible.
 *
 * Attribution requirement: Must link back to weworkremotely.com.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { EmploymentType, WorkMode } from "@/generated/prisma/client";
import { sleepWithAbort, throwIfAborted } from "@/lib/ingestion/runtime-control";
import type {
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorFetchResult,
  SourceConnectorJob,
} from "@/lib/ingestion/types";

const WWR_HOST = "https://weworkremotely.com";

// One aggregate feed plus 11 category feeds. We fetch all and dedupe on guid.
// The aggregate feed shows the 100 most recent; category feeds shift the
// category-specific distribution, so together we pick up jobs the aggregate
// truncated out.
const WWR_FEEDS: Array<{ slug: string; url: string }> = [
  { slug: "aggregate", url: `${WWR_HOST}/remote-jobs.rss` },
  { slug: "programming", url: `${WWR_HOST}/categories/remote-programming-jobs.rss` },
  { slug: "full-stack", url: `${WWR_HOST}/categories/remote-full-stack-programming-jobs.rss` },
  { slug: "back-end", url: `${WWR_HOST}/categories/remote-back-end-programming-jobs.rss` },
  { slug: "front-end", url: `${WWR_HOST}/categories/remote-front-end-programming-jobs.rss` },
  { slug: "devops", url: `${WWR_HOST}/categories/remote-devops-sysadmin-jobs.rss` },
  { slug: "design", url: `${WWR_HOST}/categories/remote-design-jobs.rss` },
  { slug: "customer-support", url: `${WWR_HOST}/categories/remote-customer-support-jobs.rss` },
  { slug: "sales-marketing", url: `${WWR_HOST}/categories/remote-sales-and-marketing-jobs.rss` },
  { slug: "management-finance", url: `${WWR_HOST}/categories/remote-management-and-finance-jobs.rss` },
  { slug: "product", url: `${WWR_HOST}/categories/remote-product-jobs.rss` },
  { slug: "all-other", url: `${WWR_HOST}/categories/all-other-remote-jobs.rss` },
];

const WWR_INTER_FEED_DELAY_MS = 600; // be polite between feed fetches

type WwrItem = {
  title: string;
  region: string;
  country: string;
  state: string;
  category: string;
  type: string;
  description: string;
  pubDate: string;
  expiresAt: string;
  guid: string;
  link: string;
};

export function createWeWorkRemotelyConnector(): SourceConnector {
  const fetchCache = new Map<string, Promise<SourceConnectorFetchResult>>();

  return {
    key: "weworkremotely:feed",
    sourceName: "WeWorkRemotely:feed",
    sourceTier: "TIER_3",
    freshnessMode: "FULL_SNAPSHOT",
    async fetchJobs(
      options: SourceConnectorFetchOptions
    ): Promise<SourceConnectorFetchResult> {
      const cacheKey = String(options.limit ?? "all");
      const existing = fetchCache.get(cacheKey);
      if (existing) return existing;

      const request = fetchWwrJobs(options);
      fetchCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchWwrJobs(
  options: SourceConnectorFetchOptions
): Promise<SourceConnectorFetchResult> {
  const { now, limit, signal, log = console.log } = options;
  const seenGuids = new Set<string>();
  const collected: WwrItem[] = [];
  const fetchedByFeed: Record<string, number> = {};
  const errorsByFeed: Record<string, string> = {};
  let totalFetched = 0;

  for (let i = 0; i < WWR_FEEDS.length; i++) {
    throwIfAborted(signal);
    const feed = WWR_FEEDS[i];
    try {
      const items = await fetchFeed(feed.url, signal);
      fetchedByFeed[feed.slug] = items.length;
      totalFetched += items.length;
      for (const item of items) {
        if (seenGuids.has(item.guid)) continue;
        seenGuids.add(item.guid);
        collected.push(item);
      }
    } catch (error) {
      errorsByFeed[feed.slug] =
        error instanceof Error ? error.message : String(error);
      log(
        `[weworkremotely] feed '${feed.slug}' failed: ${errorsByFeed[feed.slug]}`
      );
    }

    // Be polite between feeds so we never trigger Cloudflare rate-limits.
    if (i < WWR_FEEDS.length - 1) {
      await sleepWithAbort(WWR_INTER_FEED_DELAY_MS, signal);
    }
  }

  const toProcess =
    typeof limit === "number" && limit > 0 ? collected.slice(0, limit) : collected;

  const jobs: SourceConnectorJob[] = toProcess.map((item) => mapToSourceJob(item, now));

  return {
    jobs,
    metadata: {
      feedsFetched: Object.keys(fetchedByFeed).length,
      fetchedByFeed,
      errorsByFeed,
      totalRawItems: totalFetched,
      uniqueItems: collected.length,
      fetchedAt: now.toISOString(),
    } as Prisma.InputJsonValue,
  };
}

async function fetchFeed(url: string, signal?: AbortSignal): Promise<WwrItem[]> {
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "User-Agent":
        "Mozilla/5.0 (compatible; autoapplication-wwr/1.0; +https://autoapplication.example)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `WeWorkRemotely feed ${url} fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const xml = await response.text();
  return parseWwrRss(xml);
}

// ─── RSS parsing ──────────────────────────────────────────────────────────────
// WWR RSS is plain XML with simple <tag>value</tag> structure (no namespaces
// on the job fields besides media:content which we ignore). Regex parsing is
// safe enough given the constrained feed shape and avoids a new dep.

function parseWwrRss(xml: string): WwrItem[] {
  const items: WwrItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const body = match[1];
    const item: WwrItem = {
      title: extractTag(body, "title"),
      region: extractTag(body, "region"),
      country: extractTag(body, "country"),
      state: extractTag(body, "state"),
      category: extractTag(body, "category"),
      type: extractTag(body, "type"),
      description: extractTag(body, "description"),
      pubDate: extractTag(body, "pubDate"),
      expiresAt: extractTag(body, "expires_at"),
      guid: extractTag(body, "guid"),
      link: extractTag(body, "link"),
    };
    // Only keep items with a stable unique identifier.
    if (!item.guid && !item.link) continue;
    if (!item.title) continue;
    items.push(item);
  }
  return items;
}

function extractTag(body: string, tag: string): string {
  // Escape regex meta-chars in tag (none expected, but safe).
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Handle both <tag>value</tag> and <tag><![CDATA[value]]></tag>, plus
  // self-closing <tag/> (return empty).
  const re = new RegExp(
    `<${safeTag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${safeTag}>|<${safeTag}(?:\\s[^>]*)?/>`,
    "i"
  );
  const m = body.match(re);
  if (!m) return "";
  const raw = m[1] ?? m[2] ?? "";
  return decodeXmlEntities(raw).trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ─── Job mapping ──────────────────────────────────────────────────────────────

function mapToSourceJob(item: WwrItem, now: Date): SourceConnectorJob {
  const { company, title } = splitCompanyAndTitle(item.title);
  const sourceUrl = item.link || item.guid || `${WWR_HOST}/`;
  const stableId = item.guid || item.link;
  // Turn the GUID URL tail into a stable sourceId. Fall back to the raw guid.
  const sourceId = `weworkremotely:${slugFromUrl(stableId) || stableId}`;

  const description = cleanHtml(item.description);
  const postedAt = parseRfc2822(item.pubDate);
  const deadline = parseRfc2822(item.expiresAt);

  const location = buildLocationLabel(item);
  const workMode: WorkMode = "REMOTE";
  const employmentType = mapEmploymentType(item.type);

  return {
    sourceId,
    sourceUrl,
    title: title || "Untitled Position",
    company: company || "Unknown Company",
    location,
    description,
    applyUrl: sourceUrl,
    postedAt: postedAt ?? null,
    deadline: deadline ?? null,
    employmentType,
    workMode,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    metadata: {
      source: "weworkremotely",
      category: item.category || null,
      region: item.region || null,
      country: item.country || null,
      state: item.state || null,
      type: item.type || null,
      fetchedAt: now.toISOString(),
    } as Prisma.InputJsonValue,
  };
}

function splitCompanyAndTitle(rawTitle: string): { company: string; title: string } {
  const trimmed = rawTitle.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx <= 0 || colonIdx > 80) {
    // No sensible split — treat whole thing as the title.
    return { company: "", title: trimmed };
  }
  const company = trimmed.slice(0, colonIdx).trim();
  const title = trimmed.slice(colonIdx + 1).trim();
  return { company, title: title || trimmed };
}

function buildLocationLabel(item: WwrItem): string {
  const parts: string[] = [];
  const state = item.state?.trim();
  const country = item.country?.trim();
  const region = item.region?.trim();

  if (state) parts.push(state);
  if (country) parts.push(country);
  if (parts.length === 0 && region) return `Remote (${region})`;
  if (parts.length === 0) return "Remote";
  return `Remote (${parts.join(", ")})`;
}

function mapEmploymentType(raw: string): EmploymentType | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("full")) return "FULL_TIME";
  if (value.includes("part")) return "PART_TIME";
  if (value.includes("contract")) return "CONTRACT";
  if (value.includes("intern")) return "INTERNSHIP";
  if (value.includes("freelance")) return "CONTRACT";
  return null;
}

function parseRfc2822(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function slugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.replace(/\/+$/, "").split("/").pop();
    return tail ?? "";
  } catch {
    return "";
  }
}

function cleanHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
