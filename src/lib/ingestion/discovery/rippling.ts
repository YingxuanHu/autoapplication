import { createRipplingConnector } from "@/lib/ingestion/connectors";
import { previewConnectorIngestion } from "@/lib/ingestion/pipeline";

const RIPPLING_HOST_RE = /^https?:\/\/ats\.rippling\.com\//i;
const RIPPLING_SLUG_RE =
  /^https?:\/\/ats\.rippling\.com\/(?:(?:[a-z]{2}(?:-[A-Z]{2})?)\/)?([^/?#]+)\/jobs(?:[/?#]|$)/i;
const TITLE_RE = /<title>([^<]+)<\/title>/i;
const BING_RSS_ENDPOINT = "https://www.bing.com/search?format=rss&q=";

export const RIPPLING_DISCOVERY_THRESHOLD = 5;

export const RIPPLING_DISCOVERY_DEFAULT_QUERIES = [
  'site:ats.rippling.com/ats.rippling.com/jobs "Apply now"',
  'site:ats.rippling.com/ats.rippling.com/jobs "Software Engineer"',
  'site:ats.rippling.com/ats.rippling.com/jobs "Product Manager"',
  'site:ats.rippling.com/ats.rippling.com/jobs "Data Scientist"',
  'site:ats.rippling.com/ats.rippling.com/jobs "DevOps Engineer"',
  'site:ats.rippling.com/ats.rippling.com/jobs "Official emails come from"',
] as const;

export type RipplingDiscoveryCandidate = {
  input: string;
  boardSlug: string;
  boardUrl: string;
  source: "slug" | "url";
};

export type RipplingDiscoveryResult = {
  input: string;
  boardSlug: string;
  boardUrl: string;
  source: "slug" | "url";
  pageTitle: string | null;
  fetchedCount: number;
  acceptedCount: number;
  previewCreatedCount: number;
  previewUpdatedCount: number;
  dedupedCount: number;
  rejectedCount: number;
  sampleTitles: string[];
  sampleLocations: string[];
  error?: string;
};

export type RipplingSearchQueryReport = {
  query: string;
  searchProvider: "bing_rss";
  resultUrlsFetched: number;
  ripplingUrlsDiscovered: number;
  errors: string[];
};

export type RipplingSourcePageReport = {
  pageUrl: string;
  ripplingUrlsDiscovered: number;
  errors: string[];
};

export type RipplingUrlSourceReport = {
  inputUrl: string;
  ripplingUrlsDiscovered: number;
  errors: string[];
};

export function normalizeRipplingCandidates(options: {
  slugs?: string[];
  urls?: string[];
}): RipplingDiscoveryCandidate[] {
  const candidates = new Map<string, RipplingDiscoveryCandidate>();

  for (const rawSlug of options.slugs ?? []) {
    const boardSlug = rawSlug.trim().toLowerCase();
    if (!boardSlug) continue;
    candidates.set(boardSlug, {
      input: rawSlug,
      boardSlug,
      boardUrl: buildRipplingBoardUrl(boardSlug),
      source: "slug",
    });
  }

  for (const rawUrl of options.urls ?? []) {
    const boardSlug = extractRipplingSlugFromUrl(rawUrl);
    if (!boardSlug) continue;
    if (candidates.has(boardSlug)) continue;

    candidates.set(boardSlug, {
      input: rawUrl,
      boardSlug,
      boardUrl: buildRipplingBoardUrl(boardSlug),
      source: "url",
    });
  }

  return [...candidates.values()];
}

export function extractRipplingSlugFromUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || !RIPPLING_HOST_RE.test(trimmed)) {
    return null;
  }

  const match = trimmed.match(RIPPLING_SLUG_RE);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

export async function previewRipplingCandidate(
  candidate: RipplingDiscoveryCandidate,
  limit?: number
): Promise<RipplingDiscoveryResult> {
  const connector = createRipplingConnector({ boardSlug: candidate.boardSlug });

  const [jobs, previewSummary, pageTitle] = await Promise.all([
    connector.fetchJobs({ now: new Date(), limit }).then((result) => result.jobs),
    previewConnectorIngestion(connector, { limit }),
    fetchBoardTitle(candidate.boardUrl),
  ]);

  return {
    input: candidate.input,
    boardSlug: candidate.boardSlug,
    boardUrl: candidate.boardUrl,
    source: candidate.source,
    pageTitle,
    fetchedCount: previewSummary.fetchedCount,
    acceptedCount: previewSummary.acceptedCount,
    previewCreatedCount: previewSummary.canonicalCreatedCount,
    previewUpdatedCount: previewSummary.canonicalUpdatedCount,
    dedupedCount: previewSummary.dedupedCount,
    rejectedCount: previewSummary.rejectedCount,
    sampleTitles: jobs
      .map((job) => job.title.trim())
      .filter(Boolean)
      .slice(0, 5),
    sampleLocations: jobs
      .map((job) => job.location?.trim() ?? "")
      .filter(Boolean)
      .slice(0, 5),
  };
}

export async function previewRipplingCandidates(
  candidates: RipplingDiscoveryCandidate[],
  limit?: number
) {
  const results = [];

  for (const candidate of candidates) {
    try {
      const result = await previewRipplingCandidate(candidate, limit);
      results.push(result);
    } catch (error) {
      results.push({
        input: candidate.input,
        boardSlug: candidate.boardSlug,
        boardUrl: candidate.boardUrl,
        source: candidate.source,
        pageTitle: null,
        fetchedCount: 0,
        acceptedCount: 0,
        previewCreatedCount: 0,
        previewUpdatedCount: 0,
        dedupedCount: 0,
        rejectedCount: 0,
        sampleTitles: [],
        sampleLocations: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results.sort((left, right) => {
    if (right.previewCreatedCount !== left.previewCreatedCount) {
      return right.previewCreatedCount - left.previewCreatedCount;
    }
    if (right.acceptedCount !== left.acceptedCount) {
      return right.acceptedCount - left.acceptedCount;
    }
    return right.fetchedCount - left.fetchedCount;
  });
}

export async function discoverRipplingCandidatesFromSearchQueries(
  queries: string[],
  options: {
    maxResultUrlsPerQuery?: number;
  } = {}
) {
  const maxResultUrlsPerQuery = options.maxResultUrlsPerQuery ?? 8;
  const urlSources: Array<{
    url: string;
    query: string;
    sourcePageUrl?: string;
  }> = [];
  const reports: RipplingSearchQueryReport[] = [];

  for (const query of queries) {
    const report: RipplingSearchQueryReport = {
      query,
      searchProvider: "bing_rss",
      resultUrlsFetched: 0,
      ripplingUrlsDiscovered: 0,
      errors: [],
    };

    try {
      const resultUrls = await fetchBingRssLinks(query, maxResultUrlsPerQuery);
      report.resultUrlsFetched = resultUrls.length;

      for (const resultUrl of resultUrls) {
        if (extractRipplingSlugFromUrl(resultUrl)) {
          urlSources.push({ url: resultUrl, query });
          report.ripplingUrlsDiscovered += 1;
          continue;
        }

        try {
          const html = await fetchPageText(resultUrl, "text/html");
          const ripplingUrls = extractRipplingUrlsFromText(html);
          report.ripplingUrlsDiscovered += ripplingUrls.length;

          for (const ripplingUrl of ripplingUrls) {
            urlSources.push({
              url: ripplingUrl,
              query,
              sourcePageUrl: resultUrl,
            });
          }
        } catch (error) {
          report.errors.push(
            error instanceof Error
              ? `${resultUrl}: ${error.message}`
              : `${resultUrl}: ${String(error)}`
          );
        }
      }
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }

    reports.push(report);
  }

  const candidates = normalizeRipplingCandidates({
    urls: urlSources.map((source) => source.url),
  });
  const sourceMap = new Map<
    string,
    Array<{
      type: "search_query";
      query: string;
      value: string;
      sourcePageUrl?: string;
    }>
  >();

  for (const source of urlSources) {
    const slug = extractRipplingSlugFromUrl(source.url);
    if (!slug) continue;
    const existing = sourceMap.get(slug) ?? [];
    existing.push({
      type: "search_query",
      query: source.query,
      value: source.url,
      sourcePageUrl: source.sourcePageUrl,
    });
    sourceMap.set(slug, existing);
  }

  return { candidates, reports, sourceMap };
}

export async function discoverRipplingCandidatesFromPageUrls(pageUrls: string[]) {
  const normalizedPageUrls = [...new Set(pageUrls.map((url) => url.trim()).filter(Boolean))];
  const reports: RipplingSourcePageReport[] = [];
  const urlSources: Array<{
    url: string;
    pageUrl: string;
  }> = [];

  for (const pageUrl of normalizedPageUrls) {
    const report: RipplingSourcePageReport = {
      pageUrl,
      ripplingUrlsDiscovered: 0,
      errors: [],
    };

    try {
      const directSlug = extractRipplingSlugFromUrl(pageUrl);
      if (directSlug) {
        urlSources.push({ url: pageUrl, pageUrl });
        report.ripplingUrlsDiscovered = 1;
        reports.push(report);
        continue;
      }

      const html = await fetchPageText(pageUrl, "text/html");
      const ripplingUrls = extractRipplingUrlsFromText(html);
      report.ripplingUrlsDiscovered = ripplingUrls.length;

      for (const ripplingUrl of ripplingUrls) {
        urlSources.push({
          url: ripplingUrl,
          pageUrl,
        });
      }
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }

    reports.push(report);
  }

  const candidates = normalizeRipplingCandidates({
    urls: urlSources.map((source) => source.url),
  });
  const sourceMap = new Map<
    string,
    Array<{
      type: "external_page";
      value: string;
      pageUrl: string;
    }>
  >();

  for (const source of urlSources) {
    const slug = extractRipplingSlugFromUrl(source.url);
    if (!slug) continue;
    const existing = sourceMap.get(slug) ?? [];
    existing.push({
      type: "external_page",
      value: source.url,
      pageUrl: source.pageUrl,
    });
    sourceMap.set(slug, existing);
  }

  return { candidates, reports, sourceMap };
}

export async function discoverRipplingCandidatesFromUrls(urls: string[]) {
  const normalizedUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  const reports: RipplingUrlSourceReport[] = [];
  const urlSources: Array<{
    url: string;
    inputUrl: string;
  }> = [];

  for (const inputUrl of normalizedUrls) {
    const report: RipplingUrlSourceReport = {
      inputUrl,
      ripplingUrlsDiscovered: 0,
      errors: [],
    };

    try {
      const ripplingUrls = await extractRipplingUrlsFromInputUrl(inputUrl);
      report.ripplingUrlsDiscovered = ripplingUrls.length;

      for (const ripplingUrl of ripplingUrls) {
        urlSources.push({
          url: ripplingUrl,
          inputUrl,
        });
      }
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }

    reports.push(report);
  }

  const candidates = normalizeRipplingCandidates({
    urls: urlSources.map((source) => source.url),
  });
  const sourceMap = new Map<
    string,
    Array<{
      type: "url";
      value: string;
      inputUrl: string;
    }>
  >();

  for (const source of urlSources) {
    const slug = extractRipplingSlugFromUrl(source.url);
    if (!slug) continue;
    const existing = sourceMap.get(slug) ?? [];
    existing.push({
      type: "url",
      value: source.url,
      inputUrl: source.inputUrl,
    });
    sourceMap.set(slug, existing);
  }

  return { candidates, reports, sourceMap };
}

export function extractRipplingUrlsFromText(text: string) {
  const normalizedText = decodeHtmlEntities(text).replace(/\\\//g, "/");
  const urls = new Set<string>();

  for (const match of normalizedText.match(/https?:\/\/ats\.rippling\.com\/[^"'\\s<>()]+/gi) ?? []) {
    const normalized = normalizeDetectedUrl(match);
    if (extractRipplingSlugFromUrl(normalized)) urls.add(normalized);
  }

  for (const candidateUrl of extractUrlsFromText(normalizedText)) {
    for (const ripplingUrl of extractRipplingUrlsFromUrl(candidateUrl)) {
      urls.add(ripplingUrl);
    }
  }

  for (const encodedUrl of normalizedText.match(/https?%3A%2F%2F[^"'\\s<>()]+/gi) ?? []) {
    try {
      const decoded = decodeURIComponent(encodedUrl);
      for (const ripplingUrl of extractRipplingUrlsFromUrl(decoded)) {
        urls.add(ripplingUrl);
      }
    } catch {
      continue;
    }
  }

  return [...urls];
}

export function extractUrlsFromText(text: string) {
  const normalizedText = decodeHtmlEntities(text).replace(/\\\//g, "/");
  const trimmedText = normalizedText.trim();
  const unwrappedText = trimmedText.replace(/^['"]+|['"]+$/g, "").trim();

  if (/^https?:\/\//i.test(unwrappedText) && !/\s/.test(unwrappedText)) {
    return [normalizeDetectedUrl(unwrappedText)];
  }

  return [...new Set(
    (normalizedText.match(/https?:\/\/[^"'\\s<>()]+/gi) ?? [])
      .map((url) => normalizeDetectedUrl(url))
      .filter(Boolean)
  )];
}

async function fetchBoardTitle(boardUrl: string) {
  const html = await fetchPageText(boardUrl, "text/html").catch(() => null);
  if (!html) return null;
  return html.match(TITLE_RE)?.[1]?.trim() ?? null;
}

function buildRipplingBoardUrl(boardSlug: string) {
  return `https://ats.rippling.com/${boardSlug}/jobs`;
}

async function fetchBingRssLinks(query: string, maxLinks: number) {
  const xml = await fetchPageText(
    `${BING_RSS_ENDPOINT}${encodeURIComponent(query)}`,
    "application/rss+xml, application/xml, text/xml"
  );

  const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)]
    .map((match) => decodeHtmlEntities(match[1]?.trim() ?? ""))
    .filter(Boolean);

  // First <link> is the Bing channel URL, not a search result.
  return links.slice(1, maxLinks + 1);
}

async function fetchPageText(url: string, accept: string) {
  const page = await fetchPage(url, accept);
  return page.text();
}

async function fetchPage(url: string, accept: string) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-bot/1.0)",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response;
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeDetectedUrl(url: string) {
  return decodeHtmlEntities(url)
    .replace(/\\\//g, "/")
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[),.;]+$/g, "")
    .trim();
}

function extractRipplingUrlsFromUrl(candidateUrl: string) {
  const urls = new Set<string>();
  const normalizedUrl = normalizeDetectedUrl(candidateUrl);
  const directSlug = extractRipplingSlugFromUrl(normalizedUrl);
  if (directSlug) {
    urls.add(normalizedUrl);
  }

  try {
    const parsed = new URL(normalizedUrl);
    for (const value of parsed.searchParams.values()) {
      for (const ripplingUrl of extractRipplingUrlsFromText(value)) {
        urls.add(ripplingUrl);
      }

      try {
        const decoded = decodeURIComponent(value);
        for (const ripplingUrl of extractRipplingUrlsFromText(decoded)) {
          urls.add(ripplingUrl);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [...urls];
  }

  return [...urls];
}

async function extractRipplingUrlsFromInputUrl(inputUrl: string) {
  const urls = new Set<string>();

  for (const ripplingUrl of extractRipplingUrlsFromText(inputUrl)) {
    urls.add(ripplingUrl);
  }
  if (urls.size > 0) {
    return [...urls];
  }

  const response = await fetchPage(inputUrl, "text/html");
  for (const ripplingUrl of extractRipplingUrlsFromText(response.url)) {
    urls.add(ripplingUrl);
  }
  for (const ripplingUrl of extractRipplingUrlsFromText(await response.text())) {
    urls.add(ripplingUrl);
  }

  return [...urls];
}
