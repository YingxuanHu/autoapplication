import type { EnterpriseCompanyRecord } from "@/lib/ingestion/discovery/enterprise-catalog";
import {
  discoverSourceCandidatesFromPageUrls,
  discoverSourceCandidatesFromUrls,
  extractKnownAtsUrlsFromText,
  extractSourceCandidateFromUrl,
} from "@/lib/ingestion/discovery/sources";

const CAREER_PAGE_FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGES_PER_COMPANY = 8;
const CAREER_PAGE_CONCURRENCY = 8;
const COMPANY_CRAWL_CONCURRENCY = 6;
const MAX_LINKS_PER_PAGE = 24;
const CAREER_PATH_HINTS = [
  "/careers",
  "/jobs",
  "/careers/jobs",
  "/join-us",
  "/work-with-us",
  "/careers/search",
  "/en/careers",
  "/en/jobs",
  "/en-ca/careers",
  "/en-ca/jobs",
  "/about-us/careers",
  "/about/careers",
  "/company/careers",
  "/our-company/careers",
];
const CAREER_KEYWORD_RE =
  /(careers?|jobs?|opportunit(?:y|ies)|join-us|work-with-us|employment|talent)/i;
const SKIP_EXTENSIONS_RE =
  /\.(?:pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|xml|json|rss|zip|mp4|mp3)$/i;

type KnownStatus = "pending" | "rejected" | "promoted";

export type CareerPageDiscoveryRecord = {
  boardUrl: string;
  sourceKey: string;
  connectorName: string;
  token: string;
  companyNames: string[];
  careerPageUrls: string[];
  directAtsUrls: string[];
  matchedReasons: string[];
  knownStatus: KnownStatus | null;
};

export type CareerPageCompanyReport = {
  companyName: string;
  domains: string[];
  initialUrls: string[];
  pagesFetched: number;
  careerPagesDetected: number;
  directAtsUrlsDetected: number;
  errors: string[];
};

export type CareerPageDiscoverySummary = {
  companiesSelected: string[];
  domainsSeeded: number;
  initialUrls: number;
  pagesFetched: number;
  careerPagesDetected: number;
  directAtsUrlsDetected: number;
  candidatesDiscovered: number;
  newCandidates: number;
  skippedKnownCandidates: number;
  reports: CareerPageCompanyReport[];
};

type DiscoveryMetadata = {
  companyNames: Set<string>;
  careerPageUrls: Set<string>;
  directAtsUrls: Set<string>;
  matchedReasons: Set<string>;
};

export async function discoverEnterpriseCareerPageCandidates(options: {
  companies: EnterpriseCompanyRecord[];
  knownStatuses: Map<string, KnownStatus>;
}) {
  const reports: CareerPageCompanyReport[] = [];
  const pageUrls = new Set<string>();
  const directAtsUrls = new Set<string>();
  const pageCompanyMap = new Map<string, Set<string>>();
  const atsCompanyMap = new Map<string, Set<string>>();

  const companyResults = new Array<Awaited<ReturnType<typeof crawlCompanyCareerPages>>>(
    options.companies.length
  );
  let companyCursor = 0;

  async function companyWorker() {
    while (companyCursor < options.companies.length) {
      const index = companyCursor;
      companyCursor += 1;
      const company = options.companies[index]!;
      companyResults[index] = await crawlCompanyCareerPages(company);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(COMPANY_CRAWL_CONCURRENCY, options.companies.length) },
      () => companyWorker()
    )
  );

  for (let index = 0; index < options.companies.length; index += 1) {
    const company = options.companies[index]!;
    const result = companyResults[index]!;
    reports.push(result.report);

    for (const pageUrl of result.pageUrls) {
      pageUrls.add(pageUrl);
      const companies = pageCompanyMap.get(pageUrl) ?? new Set<string>();
      companies.add(company.name);
      pageCompanyMap.set(pageUrl, companies);
    }

    for (const atsUrl of result.directAtsUrls) {
      directAtsUrls.add(atsUrl);
      const companies = atsCompanyMap.get(atsUrl) ?? new Set<string>();
      companies.add(company.name);
      atsCompanyMap.set(atsUrl, companies);
    }
  }

  const [pageDiscovery, urlDiscovery] = await Promise.all([
    discoverSourceCandidatesFromPageUrls([...pageUrls], {
      concurrency: CAREER_PAGE_CONCURRENCY,
    }),
    discoverSourceCandidatesFromUrls([...directAtsUrls]),
  ]);

  const mergedCandidates = new Map<
    string,
    { boardUrl: string; sourceKey: string; connectorName: string; token: string }
  >();
  const metadataMap = new Map<string, DiscoveryMetadata>();

  for (const candidate of [...pageDiscovery.candidates, ...urlDiscovery.candidates]) {
    mergedCandidates.set(candidate.sourceKey, {
      boardUrl: candidate.boardUrl,
      sourceKey: candidate.sourceKey,
      connectorName: candidate.connectorName,
      token: candidate.token,
    });
  }

  for (const [sourceKey, entries] of pageDiscovery.sourceMap.entries()) {
    const metadata = getOrCreateMetadata(metadataMap, sourceKey);
    metadata.matchedReasons.add("career_page_scan");
    for (const entry of entries) {
      metadata.careerPageUrls.add(entry.pageUrl);
      for (const companyName of pageCompanyMap.get(entry.pageUrl) ?? []) {
        metadata.companyNames.add(companyName);
      }
    }
  }

  for (const [sourceKey, entries] of urlDiscovery.sourceMap.entries()) {
    const metadata = getOrCreateMetadata(metadataMap, sourceKey);
    metadata.matchedReasons.add("career_page_direct_ats_link");
    for (const entry of entries) {
      metadata.directAtsUrls.add(entry.value);
      for (const companyName of atsCompanyMap.get(entry.value) ?? []) {
        metadata.companyNames.add(companyName);
      }
    }
  }

  const records = [...mergedCandidates.values()]
    .map((candidate) => {
      const metadata = metadataMap.get(candidate.sourceKey);
      return {
        ...candidate,
        companyNames: [...(metadata?.companyNames ?? new Set<string>())].sort(),
        careerPageUrls: [...(metadata?.careerPageUrls ?? new Set<string>())].sort(),
        directAtsUrls: [...(metadata?.directAtsUrls ?? new Set<string>())].sort(),
        matchedReasons: [...(metadata?.matchedReasons ?? new Set<string>())].sort(),
        knownStatus: options.knownStatuses.get(candidate.sourceKey) ?? null,
      } satisfies CareerPageDiscoveryRecord;
    })
    .filter((record) => record.knownStatus === null)
    .sort((left, right) => {
      const leftStrength = left.companyNames.length + left.careerPageUrls.length;
      const rightStrength = right.companyNames.length + right.careerPageUrls.length;
      if (rightStrength !== leftStrength) return rightStrength - leftStrength;
      return left.sourceKey.localeCompare(right.sourceKey);
    });

  return {
    records,
    summary: {
      companiesSelected: options.companies.map((company) => company.name),
      domainsSeeded: reports.reduce((sum, report) => sum + report.domains.length, 0),
      initialUrls: reports.reduce((sum, report) => sum + report.initialUrls.length, 0),
      pagesFetched: reports.reduce((sum, report) => sum + report.pagesFetched, 0),
      careerPagesDetected: reports.reduce(
        (sum, report) => sum + report.careerPagesDetected,
        0
      ),
      directAtsUrlsDetected: reports.reduce(
        (sum, report) => sum + report.directAtsUrlsDetected,
        0
      ),
      candidatesDiscovered: mergedCandidates.size,
      newCandidates: records.length,
      skippedKnownCandidates: mergedCandidates.size - records.length,
      reports,
    } satisfies CareerPageDiscoverySummary,
  };
}

async function crawlCompanyCareerPages(company: EnterpriseCompanyRecord) {
  const domains = getCompanyDomains(company);
  const initialUrls = buildInitialUrls(company, domains);
  const queue = [...initialUrls];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const pageUrls = new Set<string>();
  const directAtsUrls = new Set<string>();
  const errors: string[] = [];

  while (queue.length > 0 && visited.size < MAX_PAGES_PER_COMPANY) {
    const pageUrl = queue.shift()!;
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    try {
      const page = await fetchHtmlPage(pageUrl);
      pageUrls.add(page.finalUrl);

      const directCandidate = extractSourceCandidateFromUrl(page.finalUrl);
      if (directCandidate) {
        directAtsUrls.add(directCandidate.boardUrl);
        continue;
      }

      for (const embeddedUrl of extractKnownAtsUrlsFromText(page.html)) {
        const embeddedCandidate = extractSourceCandidateFromUrl(embeddedUrl);
        if (!embeddedCandidate) continue;
        directAtsUrls.add(embeddedCandidate.boardUrl);
      }

      for (const link of extractCareerLinks(page.html, page.finalUrl, domains)) {
        if (link.kind === "ats") {
          directAtsUrls.add(link.url);
          continue;
        }
        if (visited.has(link.url) || queued.has(link.url)) continue;
        queue.push(link.url);
        queued.add(link.url);
      }
    } catch (error) {
      errors.push(`${pageUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    pageUrls: [...pageUrls],
    directAtsUrls: [...directAtsUrls],
    report: {
      companyName: company.name,
      domains,
      initialUrls,
      pagesFetched: visited.size,
      careerPagesDetected: pageUrls.size,
      directAtsUrlsDetected: directAtsUrls.size,
      errors,
    } satisfies CareerPageCompanyReport,
  };
}

function getCompanyDomains(company: EnterpriseCompanyRecord) {
  const domains = new Set<string>();

  for (const domain of company.domains ?? []) {
    const normalized = normalizeDomain(domain);
    if (normalized) domains.add(normalized);
  }

  for (const seedPageUrl of company.seedPageUrls ?? []) {
    try {
      const parsed = new URL(seedPageUrl);
      const normalized = normalizeDomain(parsed.hostname);
      if (normalized) domains.add(normalized);
    } catch {
      continue;
    }
  }

  return [...domains];
}

function buildInitialUrls(company: EnterpriseCompanyRecord, domains: string[]) {
  const urls = new Set<string>();

  for (const seedPageUrl of company.seedPageUrls ?? []) {
    if (seedPageUrl.trim()) urls.add(seedPageUrl.trim());
  }

  for (const domain of domains) {
    for (const host of buildCompanyHosts(domain)) {
      urls.add(`https://${host}/`);
      for (const hint of CAREER_PATH_HINTS) {
        urls.add(`https://${host}${hint}`);
      }

      if (host.startsWith("careers.") || host.startsWith("jobs.")) {
        urls.add(`https://${host}/search`);
        urls.add(`https://${host}/en`);
        urls.add(`https://${host}/en/search`);
        urls.add(`https://${host}/en-ca`);
        urls.add(`https://${host}/en-ca/search`);
      }
    }

    urls.add(`https://careers.${domain}/`);
    urls.add(`https://jobs.${domain}/`);
  }

  return [...urls];
}

function buildCompanyHosts(domain: string) {
  const hosts = new Set<string>([domain]);
  if (!domain.startsWith("www.")) {
    hosts.add(`www.${domain}`);
  }
  return [...hosts];
}

function normalizeDomain(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^careers\./, "")
    .replace(/^jobs\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");

  if (!normalized || !normalized.includes(".")) return null;
  return normalized;
}

async function fetchHtmlPage(pageUrl: string) {
  const response = await fetch(pageUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-careers/1.0)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(CAREER_PAGE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    throw new Error(`unexpected_content_type:${contentType || "unknown"}`);
  }

  return {
    finalUrl: response.url,
    html: await response.text(),
  };
}

function extractCareerLinks(
  html: string,
  baseUrl: string,
  domains: string[]
): Array<{ kind: "career" | "ats"; url: string }> {
  const discovered = new Map<string, "career" | "ats">();
  const anchorRe =
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const hrefRe = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) !== null) {
    const rawHref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#")) continue;
    if (/^(?:mailto:|tel:|javascript:)/i.test(rawHref)) continue;
    const anchorText = stripHtml(match[4] ?? "");

    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }

    if (!/^https?:$/i.test(resolved.protocol)) continue;
    if (SKIP_EXTENSIONS_RE.test(resolved.pathname)) continue;

    const resolvedUrl = resolved.toString();
    const directCandidate = extractSourceCandidateFromUrl(resolvedUrl);
    if (directCandidate) {
      discovered.set(directCandidate.boardUrl, "ats");
      continue;
    }

    if (!shouldFollowCareerUrl(resolved, domains, anchorText)) continue;
    if (!discovered.has(resolvedUrl)) {
      discovered.set(resolvedUrl, "career");
    }
    if (discovered.size >= MAX_LINKS_PER_PAGE) break;
  }

  while ((match = hrefRe.exec(html)) !== null) {
    const rawHref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#")) continue;
    if (/^(?:mailto:|tel:|javascript:)/i.test(rawHref)) continue;

    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }

    if (!/^https?:$/i.test(resolved.protocol)) continue;
    if (SKIP_EXTENSIONS_RE.test(resolved.pathname)) continue;

    const resolvedUrl = resolved.toString();
    const directCandidate = extractSourceCandidateFromUrl(resolvedUrl);
    if (directCandidate) {
      discovered.set(directCandidate.boardUrl, "ats");
      continue;
    }

    if (!shouldFollowCareerUrl(resolved, domains)) continue;
    if (!discovered.has(resolvedUrl)) {
      discovered.set(resolvedUrl, "career");
    }
    if (discovered.size >= MAX_LINKS_PER_PAGE) break;
  }

  return [...discovered.entries()].map(([url, kind]) => ({ url, kind }));
}

function shouldFollowCareerUrl(url: URL, domains: string[], anchorText?: string) {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const combined = `${hostname}${url.pathname.toLowerCase()}`;
  const sameDomain = domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  const careerish =
    hostname.startsWith("careers.") ||
    hostname.startsWith("jobs.") ||
    CAREER_KEYWORD_RE.test(combined) ||
    CAREER_KEYWORD_RE.test(anchorText ?? "");

  return careerish && (sameDomain || hostname.startsWith("careers.") || hostname.startsWith("jobs."));
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getOrCreateMetadata(
  metadataMap: Map<string, DiscoveryMetadata>,
  sourceKey: string
) {
  const existing = metadataMap.get(sourceKey);
  if (existing) return existing;

  const created: DiscoveryMetadata = {
    companyNames: new Set<string>(),
    careerPageUrls: new Set<string>(),
    directAtsUrls: new Set<string>(),
    matchedReasons: new Set<string>(),
  };
  metadataMap.set(sourceKey, created);
  return created;
}
