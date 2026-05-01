import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import {
  createAdzunaConnector,
  createAshbyConnector,
  createGreenhouseConnector,
  createHimalayasConnector,
  createIcimsConnector,
  createJobicyConnector,
  createJobviteConnector,
  createTeamtailorConnector,
  createLeverConnector,
  createMuseConnector,
  createRemoteOkConnector,
  createRemotiveConnector,
  createTaleoConnector,
  createUsaJobsConnector,
  createRecruiteeConnector,
  createRipplingConnector,
  createSuccessFactorsConnector,
  createSmartRecruitersConnector,
  createWorkdayConnector,
  createWorkableConnector,
  buildSuccessFactorsBoardUrl,
  buildSuccessFactorsSourceToken,
  validateSuccessFactorsBoard,
  buildWorkdayBoardUrl,
  buildWorkdaySourceToken,
} from "@/lib/ingestion/connectors";
import { extractUrlsFromText } from "@/lib/ingestion/discovery/rippling";
import { previewConnectorIngestion } from "@/lib/ingestion/pipeline";
import type { SupportedConnectorName } from "@/lib/ingestion/registry";

const TITLE_RE = /<title>([^<]+)<\/title>/i;
const BING_RSS_ENDPOINT = "https://www.bing.com/search?format=rss&q=";
const SOURCE_PREVIEW_CONCURRENCY = 4;
const DISCOVERY_FETCH_TIMEOUT_MS = 12000;

// ─── Default search queries per ATS family ──────────────────────────────────

// Bing RSS queries for automated search discovery. Note: Bing RSS has limited
// support for advanced operators and may return low-quality results. For better
// discovery yield, use --dataset with a curated seed file instead.
// Seed files can be created by running web searches for ATS board URLs and
// collecting the results into data/discovery/seeds/.
export const ATS_SEARCH_DEFAULT_QUERIES: Array<{
  family: SupportedConnectorName;
  queries: string[];
}> = [
  {
    family: "ashby",
    queries: [
      '"jobs.ashbyhq.com" careers "Software Engineer"',
      '"jobs.ashbyhq.com" careers "Product Manager"',
      '"jobs.ashbyhq.com" careers apply',
      '"jobs.ashbyhq.com" hiring engineering',
    ],
  },
  {
    family: "greenhouse",
    queries: [
      '"boards.greenhouse.io" careers "Software Engineer"',
      '"job-boards.greenhouse.io" careers apply',
      '"boards.greenhouse.io" hiring engineering',
    ],
  },
  {
    family: "jobvite",
    queries: [
      '"jobs.jobvite.com" careers "Software Engineer"',
      '"jobs.jobvite.com" careers "Product Manager"',
      '"jobs.jobvite.com" jobs apply hiring',
    ],
  },
  {
    family: "teamtailor",
    queries: [
      '"teamtailor.com/jobs" careers "Software Engineer"',
      '"teamtailor.com/jobs" careers "Product Manager"',
      '"teamtailor.com/jobs" Toronto hiring',
    ],
  },
  {
    family: "lever",
    queries: [
      '"jobs.lever.co" careers "Software Engineer"',
      '"jobs.lever.co" careers apply hiring',
      '"jobs.lever.co" engineering data',
    ],
  },
  {
    family: "recruitee",
    queries: [
      '"recruitee.com" careers "Software Engineer"',
      '"recruitee.com" careers apply hiring',
    ],
  },
  {
    family: "rippling",
    queries: [
      '"ats.rippling.com" careers "Software Engineer"',
      '"ats.rippling.com" jobs apply hiring',
    ],
  },
  {
    family: "successfactors",
    queries: [
      '"createNewAlert=false" "Software Engineer"',
      '"talentcommunity/apply" "Software Engineer"',
      '"createNewAlert=false" "Toronto"',
    ],
  },
  {
    family: "smartrecruiters",
    queries: [
      '"jobs.smartrecruiters.com" careers "Software Engineer"',
      '"jobs.smartrecruiters.com" hiring apply',
    ],
  },
  {
    family: "workable",
    queries: [
      '"apply.workable.com" careers "Software Engineer"',
      '"apply.workable.com" hiring apply',
    ],
  },
  {
    family: "workday",
    queries: [
      '"myworkdayjobs.com/wday/cxs" careers "Software Engineer"',
      '"myworkdayjobs.com/wday/cxs" jobs apply',
    ],
  },
  {
    family: "icims",
    queries: [
      '"icims.com/jobs" careers "Software Engineer"',
      '"icims.com/jobs" hiring apply Canada',
    ],
  },
  {
    family: "taleo",
    queries: [
      '"taleo.net/careersection" careers "Software Engineer"',
      '"taleo.net/careersection" jobs hiring Canada',
    ],
  },
];

export const SOURCE_DISCOVERY_PROMOTION_THRESHOLD = 5;
const GENERIC_JOBVITE_TOKENS = new Set([
  "about",
  "career",
  "careers",
  "company",
  "job",
  "jobs",
  "join",
  "join-us",
  "openings",
  "search",
]);

type AtsMatch = {
  connectorName: SupportedConnectorName;
  token: string;
};

export type DiscoveredSourceCandidate = {
  input: string;
  connectorName: SupportedConnectorName;
  token: string;
  sourceKey: string;
  sourceName: string;
  boardUrl: string;
  source: "token" | "url";
};

export type ExistingSourceStats = {
  rawCount: number;
  activeMappingCount: number;
  liveCanonicalCount: number;
};

export type SourceDiscoveryPreviewResult = {
  input: string;
  connectorName: SupportedConnectorName;
  token: string;
  sourceKey: string;
  sourceName: string;
  boardUrl: string;
  source: "token" | "url";
  pageTitle: string | null;
  fetchedCount: number;
  acceptedCount: number;
  acceptedCanadaCount: number;
  acceptedCanadaRemoteCount: number;
  previewCreatedCount: number;
  previewCreatedCanadaCount: number;
  previewCreatedCanadaRemoteCount: number;
  previewUpdatedCount: number;
  dedupedCount: number;
  rejectedCount: number;
  existingRawCount: number;
  existingActiveMappingCount: number;
  existingLiveCanonicalCount: number;
  sampleTitles: string[];
  sampleLocations: string[];
  error?: string;
};

export type SourceUrlDiscoveryReport = {
  inputUrl: string;
  sourceUrlsDiscovered: number;
  errors: string[];
};

export type SourcePageDiscoveryReport = {
  pageUrl: string;
  sourceUrlsDiscovered: number;
  errors: string[];
};

export function buildDiscoveredSourceKey(
  connectorName: SupportedConnectorName,
  token: string
) {
  return `${connectorName}:${token.trim().toLowerCase()}`;
}

export function buildDiscoveredSourceName(
  connectorName: SupportedConnectorName,
  token: string
) {
  const prefix = (() => {
    switch (connectorName) {
      case "smartrecruiters":
        return "SmartRecruiters";
      case "successfactors":
        return "SuccessFactors";
      case "icims":
        return "iCIMS";
      case "taleo":
        return "Taleo";
      case "himalayas":
        return "Himalayas";
      case "jobicy":
        return "Jobicy";
      case "jooble":
        return "Jooble";
      case "remotive":
        return "Remotive";
      case "themuse":
        return "TheMuse";
      case "usajobs":
        return "USAJobs";
      case "weworkremotely":
        return "WeWorkRemotely";
      default:
        return connectorName.charAt(0).toUpperCase() + connectorName.slice(1);
    }
  })();
  return `${prefix}:${token}`;
}

export function buildDiscoveredSourceUrl(
  connectorName: SupportedConnectorName,
  token: string
) {
  const normalizedToken = token.trim().toLowerCase();

  switch (connectorName) {
    case "ashby":
      return `https://jobs.ashbyhq.com/${normalizedToken}`;
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${normalizedToken}`;
    case "lever":
      return `https://jobs.lever.co/${normalizedToken}`;
    case "recruitee":
      return `https://${normalizedToken}.recruitee.com/`;
    case "rippling":
      return `https://ats.rippling.com/${normalizedToken}/jobs`;
    case "successfactors":
      return buildSuccessFactorsBoardUrl(normalizedToken);
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${normalizedToken}`;
    case "workday":
      return buildWorkdayBoardUrl(token);
    case "workable":
      return `https://apply.workable.com/${normalizedToken}/`;
    case "jobvite":
      return `https://jobs.jobvite.com/${normalizedToken}/jobs`;
    case "teamtailor":
      return `https://${normalizedToken}.teamtailor.com/jobs`;
    case "icims":
      return `https://${normalizedToken}.icims.com/jobs/search`;
    case "taleo": {
      const sepIndex = normalizedToken.indexOf("/");
      const tenant = sepIndex > 0 ? normalizedToken.slice(0, sepIndex) : normalizedToken;
      const section = sepIndex > 0 ? normalizedToken.slice(sepIndex + 1) : "1";
      return `https://${tenant}.taleo.net/careersection/${section}/jobsearch.ftl?lang=en`;
    }
    case "adzuna":
      return `https://www.adzuna.${normalizedToken === "us" ? "com" : normalizedToken === "ca" ? "ca" : "com"}/search?q=`;
    case "remoteok":
      return "https://remoteok.com/remote-jobs";
    case "usajobs":
      return "https://www.usajobs.gov/Search/Results";
    case "himalayas":
      return "https://himalayas.app/jobs";
    case "jobicy":
      return "https://jobicy.com/remote-jobs";
    case "jooble":
      return "https://jooble.org/";
    case "remotive":
      return "https://remotive.com/remote-jobs";
    case "themuse":
      return "https://www.themuse.com/jobs";
    case "weworkremotely":
      return "https://weworkremotely.com/remote-jobs";
    default:
      throw new Error(`Unsupported discovered source connector: ${connectorName}`);
  }
}

export function extractSourceCandidateFromUrl(
  rawUrl: string
): DiscoveredSourceCandidate | null {
  const normalizedUrl = normalizeDetectedUrl(rawUrl);
  if (!normalizedUrl) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return null;
  }

  const match = matchAtsSource(parsedUrl);
  if (!match) return null;

  return {
    input: rawUrl,
    connectorName: match.connectorName,
    token: match.token,
    sourceKey: buildDiscoveredSourceKey(match.connectorName, match.token),
    sourceName: buildDiscoveredSourceName(match.connectorName, match.token),
    boardUrl: buildDiscoveredSourceUrl(match.connectorName, match.token),
    source: "url",
  };
}

export function isKnownAtsHost(hostname: string) {
  const normalizedHost = hostname.trim().toLowerCase();

  return (
    normalizedHost === "jobs.ashbyhq.com" ||
    normalizedHost === "jobs.eu.ashbyhq.com" ||
    normalizedHost === "boards.greenhouse.io" ||
    normalizedHost === "job-boards.greenhouse.io" ||
    normalizedHost === "boards-api.greenhouse.io" ||
    normalizedHost === "jobs.lever.co" ||
    normalizedHost === "api.lever.co" ||
    normalizedHost === "ats.rippling.com" ||
    normalizedHost === "jobs.rippling.com" ||
    normalizedHost.endsWith(".successfactors.com") ||
    normalizedHost.endsWith(".successfactors.eu") ||
    normalizedHost === "jobs.smartrecruiters.com" ||
    normalizedHost === "careers.smartrecruiters.com" ||
    normalizedHost === "api.smartrecruiters.com" ||
    normalizedHost === "apply.workable.com" ||
    normalizedHost === "jobs.jobvite.com" ||
    normalizedHost.endsWith(".teamtailor.com") ||
    normalizedHost === "www.workable.com" ||
    normalizedHost.endsWith(".myworkdayjobs.com") ||
    normalizedHost.endsWith(".myworkdaysite.com") ||
    normalizedHost.endsWith(".recruitee.com") ||
    normalizedHost.endsWith(".icims.com") ||
    normalizedHost.endsWith(".taleo.net")
  );
}

export function normalizeSourceCandidates(options: {
  tokens?: Array<{
    connectorName: SupportedConnectorName;
    token: string;
    input?: string;
  }>;
  urls?: string[];
}) {
  const candidates = new Map<string, DiscoveredSourceCandidate>();

  for (const tokenInput of options.tokens ?? []) {
    const token = tokenInput.token.trim().toLowerCase();
    if (!token) continue;
    const sourceKey = buildDiscoveredSourceKey(tokenInput.connectorName, token);
    if (candidates.has(sourceKey)) continue;

    candidates.set(sourceKey, {
      input: tokenInput.input ?? token,
      connectorName: tokenInput.connectorName,
      token,
      sourceKey,
      sourceName: buildDiscoveredSourceName(tokenInput.connectorName, token),
      boardUrl: buildDiscoveredSourceUrl(tokenInput.connectorName, token),
      source: "token",
    });
  }

  for (const rawUrl of options.urls ?? []) {
    const candidate = extractSourceCandidateFromUrl(rawUrl);
    if (!candidate || candidates.has(candidate.sourceKey)) continue;
    candidates.set(candidate.sourceKey, candidate);
  }

  return [...candidates.values()];
}

export async function discoverSourceCandidatesFromUrls(urls: string[]) {
  const normalizedUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  const reports: SourceUrlDiscoveryReport[] = [];
  const urlSources: Array<{
    discoveredUrl: string;
    inputUrl: string;
  }> = [];

  for (const inputUrl of normalizedUrls) {
    const report: SourceUrlDiscoveryReport = {
      inputUrl,
      sourceUrlsDiscovered: 0,
      errors: [],
    };

    try {
      const discoveredUrls = extractKnownAtsUrlsFromInputUrl(inputUrl);
      report.sourceUrlsDiscovered = discoveredUrls.length;

      for (const discoveredUrl of discoveredUrls) {
        urlSources.push({
          discoveredUrl,
          inputUrl,
        });
      }
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }

    reports.push(report);
  }

  const candidates = normalizeSourceCandidates({
    urls: urlSources.map((source) => source.discoveredUrl),
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
    const candidate = extractSourceCandidateFromUrl(source.discoveredUrl);
    if (!candidate) continue;
    const existing = sourceMap.get(candidate.sourceKey) ?? [];
    existing.push({
      type: "url",
      value: source.discoveredUrl,
      inputUrl: source.inputUrl,
    });
    sourceMap.set(candidate.sourceKey, existing);
  }

  return { candidates, reports, sourceMap };
}

export async function discoverSourceCandidatesFromPageUrls(
  pageUrls: string[],
  options?: { concurrency?: number }
) {
  const normalizedPageUrls = [...new Set(pageUrls.map((url) => url.trim()).filter(Boolean))];
  const reports: SourcePageDiscoveryReport[] = new Array(normalizedPageUrls.length);
  const urlSources: Array<{
    discoveredUrl: string;
    pageUrl: string;
  }> = [];
  const concurrency = Math.max(1, options?.concurrency ?? 8);
  let cursor = 0;

  async function worker() {
    while (cursor < normalizedPageUrls.length) {
      const index = cursor;
      cursor += 1;
      const pageUrl = normalizedPageUrls[index]!;
      const report: SourcePageDiscoveryReport = {
        pageUrl,
        sourceUrlsDiscovered: 0,
        errors: [],
      };

      try {
        const directCandidate = extractSourceCandidateFromUrl(pageUrl);
        if (directCandidate) {
          urlSources.push({
            discoveredUrl: directCandidate.boardUrl,
            pageUrl,
          });
          report.sourceUrlsDiscovered = 1;
          reports[index] = report;
          continue;
        }

        const html = await fetchPageText(pageUrl, "text/html");
        const discoveredUrls = extractKnownAtsUrlsFromText(html);
        report.sourceUrlsDiscovered = discoveredUrls.length;

        for (const discoveredUrl of discoveredUrls) {
          urlSources.push({
            discoveredUrl,
            pageUrl,
          });
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }

      reports[index] = report;
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, normalizedPageUrls.length) },
      () => worker()
    )
  );

  const candidates = normalizeSourceCandidates({
    urls: urlSources.map((source) => source.discoveredUrl),
  });
  const sourceMap = new Map<
    string,
    Array<{
      type: "page";
      value: string;
      pageUrl: string;
    }>
  >();

  for (const source of urlSources) {
    const candidate = extractSourceCandidateFromUrl(source.discoveredUrl);
    if (!candidate) continue;
    const existing = sourceMap.get(candidate.sourceKey) ?? [];
    existing.push({
      type: "page",
      value: source.discoveredUrl,
      pageUrl: source.pageUrl,
    });
    sourceMap.set(candidate.sourceKey, existing);
  }

  return { candidates, reports: reports.filter(Boolean), sourceMap };
}

export async function previewSourceCandidates(
  candidates: DiscoveredSourceCandidate[],
  limit?: number
) {
  const results = new Array<SourceDiscoveryPreviewResult>(candidates.length);
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index]!;

      try {
        results[index] = await previewSourceCandidate(candidate, limit);
      } catch (error) {
        results[index] = {
          input: candidate.input,
          connectorName: candidate.connectorName,
          token: candidate.token,
          sourceKey: candidate.sourceKey,
          sourceName: candidate.sourceName,
          boardUrl: candidate.boardUrl,
          source: candidate.source,
          pageTitle: null,
          fetchedCount: 0,
          acceptedCount: 0,
          acceptedCanadaCount: 0,
          acceptedCanadaRemoteCount: 0,
          previewCreatedCount: 0,
          previewCreatedCanadaCount: 0,
          previewCreatedCanadaRemoteCount: 0,
          previewUpdatedCount: 0,
          dedupedCount: 0,
          rejectedCount: 0,
          existingRawCount: 0,
          existingActiveMappingCount: 0,
          existingLiveCanonicalCount: 0,
          sampleTitles: [],
          sampleLocations: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SOURCE_PREVIEW_CONCURRENCY, candidates.length) },
      () => worker()
    )
  );

  return results.filter(Boolean).sort((left, right) => {
    const leftStrength = Math.max(
      left.previewCreatedCount,
      left.existingLiveCanonicalCount
    );
    const rightStrength = Math.max(
      right.previewCreatedCount,
      right.existingLiveCanonicalCount
    );

    if (rightStrength !== leftStrength) return rightStrength - leftStrength;
    if (right.acceptedCount !== left.acceptedCount) {
      return right.acceptedCount - left.acceptedCount;
    }
    return right.fetchedCount - left.fetchedCount;
  });
}

export async function previewSourceCandidate(
  candidate: DiscoveredSourceCandidate,
  limit?: number
): Promise<SourceDiscoveryPreviewResult> {
  if (candidate.connectorName === "successfactors") {
    return previewSuccessFactorsCandidate(candidate, limit);
  }

  const connector = createConnectorForCandidate(candidate);
  const [jobs, previewSummary, existingStats, pageTitle] = await Promise.all([
    connector.fetchJobs({ now: new Date(), limit }).then((result) => result.jobs),
    previewConnectorIngestion(connector, { limit }),
    getExistingSourceStats(candidate),
    fetchBoardTitle(candidate.boardUrl).catch(() => null),
  ]);

  return {
    input: candidate.input,
    connectorName: candidate.connectorName,
    token: candidate.token,
    sourceKey: candidate.sourceKey,
    sourceName: candidate.sourceName,
    boardUrl: candidate.boardUrl,
    source: candidate.source,
    pageTitle,
    fetchedCount: previewSummary.fetchedCount,
    acceptedCount: previewSummary.acceptedCount,
    acceptedCanadaCount: previewSummary.acceptedCanadaCount,
    acceptedCanadaRemoteCount: previewSummary.acceptedCanadaRemoteCount,
    previewCreatedCount: previewSummary.canonicalCreatedCount,
    previewCreatedCanadaCount: previewSummary.canonicalCreatedCanadaCount,
    previewCreatedCanadaRemoteCount:
      previewSummary.canonicalCreatedCanadaRemoteCount,
    previewUpdatedCount: previewSummary.canonicalUpdatedCount,
    dedupedCount: previewSummary.dedupedCount,
    rejectedCount: previewSummary.rejectedCount,
    existingRawCount: existingStats.rawCount,
    existingActiveMappingCount: existingStats.activeMappingCount,
    existingLiveCanonicalCount: existingStats.liveCanonicalCount,
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

async function previewSuccessFactorsCandidate(
  candidate: DiscoveredSourceCandidate,
  limit?: number
): Promise<SourceDiscoveryPreviewResult> {
  const existingStats = await getExistingSourceStats(candidate);
  const boardValidation = await validateSuccessFactorsBoard(candidate.token);

  if (!boardValidation.valid) {
    return {
      input: candidate.input,
      connectorName: candidate.connectorName,
      token: candidate.token,
      sourceKey: candidate.sourceKey,
      sourceName: candidate.sourceName,
      boardUrl: candidate.boardUrl,
      source: candidate.source,
      pageTitle: boardValidation.pageTitle,
      fetchedCount: 0,
      acceptedCount: 0,
      acceptedCanadaCount: 0,
      acceptedCanadaRemoteCount: 0,
      previewCreatedCount: 0,
      previewCreatedCanadaCount: 0,
      previewCreatedCanadaRemoteCount: 0,
      previewUpdatedCount: 0,
      dedupedCount: 0,
      rejectedCount: 0,
      existingRawCount: existingStats.rawCount,
      existingActiveMappingCount: existingStats.activeMappingCount,
      existingLiveCanonicalCount: existingStats.liveCanonicalCount,
      sampleTitles: [],
      sampleLocations: [],
      error: `${boardValidation.reason}: ${boardValidation.message}`,
    };
  }

  const connector = createConnectorForCandidate(candidate);
  const [jobs, previewSummary] = await Promise.all([
    connector.fetchJobs({ now: new Date(), limit }).then((result) => result.jobs),
    previewConnectorIngestion(connector, { limit }),
  ]);

  return {
    input: candidate.input,
    connectorName: candidate.connectorName,
    token: candidate.token,
    sourceKey: candidate.sourceKey,
    sourceName: candidate.sourceName,
    boardUrl: candidate.boardUrl,
    source: candidate.source,
    pageTitle: boardValidation.pageTitle,
    fetchedCount: previewSummary.fetchedCount,
    acceptedCount: previewSummary.acceptedCount,
    acceptedCanadaCount: previewSummary.acceptedCanadaCount,
    acceptedCanadaRemoteCount: previewSummary.acceptedCanadaRemoteCount,
    previewCreatedCount: previewSummary.canonicalCreatedCount,
    previewCreatedCanadaCount: previewSummary.canonicalCreatedCanadaCount,
    previewCreatedCanadaRemoteCount:
      previewSummary.canonicalCreatedCanadaRemoteCount,
    previewUpdatedCount: previewSummary.canonicalUpdatedCount,
    dedupedCount: previewSummary.dedupedCount,
    rejectedCount: previewSummary.rejectedCount,
    existingRawCount: existingStats.rawCount,
    existingActiveMappingCount: existingStats.activeMappingCount,
    existingLiveCanonicalCount: existingStats.liveCanonicalCount,
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

export function extractKnownAtsUrlsFromText(text: string) {
  const urls = new Set<string>();
  const normalizedText = decodeHtmlEntities(text).replace(/\\\//g, "/");

  for (const url of extractUrlsFromText(normalizedText)) {
    for (const discoveredUrl of extractKnownAtsUrlsFromInputUrl(url)) {
      urls.add(discoveredUrl);
    }
  }

  for (const encodedUrl of normalizedText.match(/https?%3A%2F%2F[^"'\\s<>()]+/gi) ?? []) {
    try {
      const decoded = decodeURIComponent(encodedUrl);
      for (const discoveredUrl of extractKnownAtsUrlsFromInputUrl(decoded)) {
        urls.add(discoveredUrl);
      }
    } catch {
      continue;
    }
  }

  for (const atsFragment of extractKnownAtsUrlFragments(normalizedText)) {
    for (const discoveredUrl of extractKnownAtsUrlsFromInputUrl(atsFragment)) {
      urls.add(discoveredUrl);
    }
  }

  return [...urls];
}

const ATS_URL_FRAGMENT_PATTERNS = [
  /(?:https?:)?\/\/jobs\.ashbyhq\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/jobs\.eu\.ashbyhq\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/(?:job-boards|boards)\.greenhouse\.io\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/boards-api\.greenhouse\.io\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/jobs\.lever\.co\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/jobs\.smartrecruiters\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/careers\.smartrecruiters\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/apply\.workable\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/jobs\.jobvite\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/[a-z0-9-]+\.teamtailor\.com\/jobs[^\s"'<>\\]*/gi,
  /(?:https?:)?\/\/[a-z0-9-]+\.icims\.com\/jobs[^\s"'<>\\]*/gi,
  /(?:https?:)?\/\/[a-z0-9-]+\.taleo\.net\/careersection\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/[a-z0-9-]+\.(?:wd\d+)\.myworkdayjobs\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/[a-z0-9-]+\.(?:wd\d+)\.myworkdaysite\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/jobs\.rippling\.com\/[^\s"'<>\\]+/gi,
  /(?:https?:)?\/\/(?:jobs|careers)\.[a-z0-9.-]+\/(?:search|job|talentcommunity)[^\s"'<>\\]*/gi,
];

function extractKnownAtsUrlFragments(text: string) {
  const fragments = new Set<string>();

  for (const pattern of ATS_URL_FRAGMENT_PATTERNS) {
    for (const match of text.match(pattern) ?? []) {
      const normalizedMatch = normalizeDetectedUrl(
        match.startsWith("//") ? `https:${match}` : match
      );
      if (normalizedMatch) {
        fragments.add(normalizedMatch);
      }
    }
  }

  return [...fragments];
}

// ─── Search-based ATS discovery ──────────────────────────────────────────────

export type SearchDiscoveryReport = {
  query: string;
  family: SupportedConnectorName | "all";
  searchProvider: "bing_rss";
  resultUrlsFetched: number;
  atsUrlsDiscovered: number;
  candidatesFound: number;
  errors: string[];
};

export type DatasetDiscoveryReport = {
  filePath: string;
  linesRead: number;
  urlsExtracted: number;
  candidatesFound: number;
  errors: string[];
};

export async function discoverSourceCandidatesFromSearch(options: {
  families?: SupportedConnectorName[];
  queries?: string[];
  maxResultUrlsPerQuery?: number;
}) {
  const maxResultUrlsPerQuery = options.maxResultUrlsPerQuery ?? 10;
  const reports: SearchDiscoveryReport[] = [];
  const allDiscoveredUrls: Array<{
    discoveredUrl: string;
    query: string;
    sourcePageUrl?: string;
  }> = [];

  // Build query list: either custom queries or default per-family queries
  const queryList: Array<{
    query: string;
    family: SupportedConnectorName | "all";
  }> = [];

  if (options.queries && options.queries.length > 0) {
    for (const query of options.queries) {
      queryList.push({ query, family: "all" });
    }
  } else {
    const targetFamilies = options.families ?? ATS_SEARCH_DEFAULT_QUERIES.map((q) => q.family);
    for (const entry of ATS_SEARCH_DEFAULT_QUERIES) {
      if (!targetFamilies.includes(entry.family)) continue;
      for (const query of entry.queries) {
        queryList.push({ query, family: entry.family });
      }
    }
  }

  for (const { query, family } of queryList) {
    const report: SearchDiscoveryReport = {
      query,
      family,
      searchProvider: "bing_rss",
      resultUrlsFetched: 0,
      atsUrlsDiscovered: 0,
      candidatesFound: 0,
      errors: [],
    };

    try {
      const resultUrls = await fetchBingRssLinks(query, maxResultUrlsPerQuery);
      report.resultUrlsFetched = resultUrls.length;

      for (const resultUrl of resultUrls) {
        // Check if the result URL itself is an ATS URL
        const directCandidate = extractSourceCandidateFromUrl(resultUrl);
        if (directCandidate) {
          allDiscoveredUrls.push({ discoveredUrl: resultUrl, query });
          report.atsUrlsDiscovered += 1;
          continue;
        }

        // Otherwise, fetch the page and scan for ATS links
        try {
          const html = await fetchPageText(resultUrl, "text/html");
          const atsUrls = extractKnownAtsUrlsFromText(html);
          report.atsUrlsDiscovered += atsUrls.length;
          for (const atsUrl of atsUrls) {
            allDiscoveredUrls.push({
              discoveredUrl: atsUrl,
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

    // Dedupe and count candidates
    const queryCandidates = normalizeSourceCandidates({
      urls: allDiscoveredUrls
        .filter((s) => s.query === query)
        .map((s) => s.discoveredUrl),
    });
    report.candidatesFound = queryCandidates.length;
    reports.push(report);
  }

  const candidates = normalizeSourceCandidates({
    urls: allDiscoveredUrls.map((s) => s.discoveredUrl),
  });

  const sourceMap = new Map<
    string,
    Array<{
      type: "search_query";
      value: string;
      query: string;
      sourcePageUrl?: string;
    }>
  >();

  for (const source of allDiscoveredUrls) {
    const candidate = extractSourceCandidateFromUrl(source.discoveredUrl);
    if (!candidate) continue;
    const existing = sourceMap.get(candidate.sourceKey) ?? [];
    existing.push({
      type: "search_query",
      value: source.discoveredUrl,
      query: source.query,
      sourcePageUrl: source.sourcePageUrl,
    });
    sourceMap.set(candidate.sourceKey, existing);
  }

  return { candidates, reports, sourceMap };
}

// ─── Dataset / file ingestion ────────────────────────────────────────────────

export async function discoverSourceCandidatesFromDataset(filePaths: string[]) {
  const reports: DatasetDiscoveryReport[] = [];
  const allUrls: Array<{
    url: string;
    filePath: string;
  }> = [];

  for (const filePath of filePaths) {
    const report: DatasetDiscoveryReport = {
      filePath,
      linesRead: 0,
      urlsExtracted: 0,
      candidatesFound: 0,
      errors: [],
    };

    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\n/).filter((line) => line.trim());
      report.linesRead = lines.length;

      // Try JSON array first
      const urls = tryParseJsonUrls(content) ?? extractUrlsFromLines(lines);
      report.urlsExtracted = urls.length;

      for (const url of urls) {
        allUrls.push({ url, filePath });
      }

      const fileCandidates = normalizeSourceCandidates({ urls });
      report.candidatesFound = fileCandidates.length;
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }

    reports.push(report);
  }

  const candidates = normalizeSourceCandidates({
    urls: allUrls.map((s) => s.url),
  });

  const sourceMap = new Map<
    string,
    Array<{
      type: "dataset";
      value: string;
      filePath: string;
    }>
  >();

  for (const source of allUrls) {
    const candidate = extractSourceCandidateFromUrl(source.url);
    if (!candidate) continue;
    const existing = sourceMap.get(candidate.sourceKey) ?? [];
    existing.push({
      type: "dataset",
      value: source.url,
      filePath: source.filePath,
    });
    sourceMap.set(candidate.sourceKey, existing);
  }

  return { candidates, reports, sourceMap };
}

function tryParseJsonUrls(content: string): string[] | null {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      // Array of strings (URLs)
      if (parsed.every((item) => typeof item === "string")) {
        return parsed.filter((url: string) => url.trim());
      }
      // Array of objects with url/href/link field
      return parsed
        .map((item: Record<string, unknown>) =>
          typeof item === "object" && item !== null
            ? String(
                item.url ??
                  item.href ??
                  item.link ??
                  item.career_url ??
                  item.boardUrl ??
                  item.sourceUrl ??
                  item.source_url ??
                  ""
              )
            : ""
        )
        .filter(Boolean);
    }
  } catch {
    return null;
  }
  return null;
}

function extractUrlsFromLines(lines: string[]): string[] {
  const urls: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and headers
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    // CSV: try to extract URLs from each comma-separated field
    for (const field of trimmed.split(/[,\t]/)) {
      const cleaned = field.trim().replace(/^["']|["']$/g, "");
      if (/^https?:\/\//i.test(cleaned)) {
        urls.push(cleaned);
      }
    }
    // Also try extracting embedded URLs from the full line
    for (const match of trimmed.matchAll(/https?:\/\/[^\s"',<>()]+/gi)) {
      urls.push(match[0].replace(/[),.;]+$/, ""));
    }
  }
  return [...new Set(urls)];
}

function extractKnownAtsUrlsFromInputUrl(inputUrl: string) {
  const discoveredUrls = new Set<string>();
  const normalizedUrl = normalizeDetectedUrl(inputUrl);

  const directCandidate = extractSourceCandidateFromUrl(normalizedUrl);
  if (directCandidate) {
    discoveredUrls.add(normalizedUrl);
  }

  try {
    const parsedUrl = new URL(normalizedUrl);
    for (const value of parsedUrl.searchParams.values()) {
      for (const nestedUrl of extractUrlsFromText(value)) {
        const nestedCandidate = extractSourceCandidateFromUrl(nestedUrl);
        if (nestedCandidate) discoveredUrls.add(nestedUrl);
      }
    }
  } catch {
    return [...discoveredUrls];
  }

  return [...discoveredUrls];
}

function matchAtsSource(parsedUrl: URL): AtsMatch | null {
  const hostname = parsedUrl.hostname.trim().toLowerCase();
  const pathSegments = parsedUrl.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (hostname === "ats.rippling.com") {
    const [, maybeToken] =
      pathSegments[0]?.match(/^[a-z]{2}(?:-[A-Z]{2})?$/)
        ? [pathSegments[0], pathSegments[1]]
        : [null, pathSegments[0]];
    if (maybeToken && pathSegments.includes("jobs")) {
      return { connectorName: "rippling", token: maybeToken.toLowerCase() };
    }
  }

  if (hostname === "jobs.rippling.com" && pathSegments[0]) {
    return { connectorName: "rippling", token: pathSegments[0].toLowerCase() };
  }

  if (
    (hostname.startsWith("jobs.") || hostname.startsWith("careers.")) &&
    (pathSegments[0] === "search" ||
      pathSegments[0] === "job" ||
      pathSegments[0] === "talentcommunity")
  ) {
    return {
      connectorName: "successfactors",
      token: buildSuccessFactorsSourceToken(hostname),
    };
  }

  if (
    (hostname === "jobs.ashbyhq.com" || hostname === "jobs.eu.ashbyhq.com") &&
    pathSegments[0]
  ) {
    return { connectorName: "ashby", token: pathSegments[0].toLowerCase() };
  }

  if (
    (hostname === "jobs.ashbyhq.com" || hostname === "jobs.eu.ashbyhq.com") &&
    pathSegments[0] === "api"
  ) {
    const organizationSlug =
      parsedUrl.searchParams.get("organizationSlug") ??
      parsedUrl.searchParams.get("orgSlug") ??
      parsedUrl.searchParams.get("company");
    if (organizationSlug) {
      return {
        connectorName: "ashby",
        token: organizationSlug.toLowerCase(),
      };
    }
  }

  if (
    (hostname === "boards.greenhouse.io" ||
      hostname === "job-boards.greenhouse.io") &&
    pathSegments[0] &&
    pathSegments[0] !== "embed"
  ) {
    return {
      connectorName: "greenhouse",
      token: pathSegments[0].toLowerCase(),
    };
  }

  if (
    (hostname === "boards.greenhouse.io" ||
      hostname === "job-boards.greenhouse.io") &&
    pathSegments[0] === "embed"
  ) {
    const boardToken = parsedUrl.searchParams.get("for");
    if (boardToken) {
      return { connectorName: "greenhouse", token: boardToken.toLowerCase() };
    }
  }

  if (
    hostname === "boards-api.greenhouse.io" &&
    pathSegments[0] === "v1" &&
    pathSegments[1] === "boards" &&
    pathSegments[2]
  ) {
    return {
      connectorName: "greenhouse",
      token: pathSegments[2].toLowerCase(),
    };
  }

  if (hostname === "jobs.lever.co" && pathSegments[0]) {
    return { connectorName: "lever", token: pathSegments[0].toLowerCase() };
  }

  if (
    hostname === "api.lever.co" &&
    pathSegments[0] === "v0" &&
    pathSegments[1] === "postings" &&
    pathSegments[2]
  ) {
    return { connectorName: "lever", token: pathSegments[2].toLowerCase() };
  }

  const recruiteeMatch = hostname.match(/^([a-z0-9-]+)\.recruitee\.com$/i);
  if (recruiteeMatch?.[1]) {
    return {
      connectorName: "recruitee",
      token: recruiteeMatch[1].toLowerCase(),
    };
  }

  if (hostname === "jobs.smartrecruiters.com" && pathSegments[0]) {
    return {
      connectorName: "smartrecruiters",
      token: pathSegments[0].toLowerCase(),
    };
  }

  if (hostname === "careers.smartrecruiters.com" && pathSegments[0]) {
    return {
      connectorName: "smartrecruiters",
      token: pathSegments[0].toLowerCase(),
    };
  }

  if (
    hostname === "api.smartrecruiters.com" &&
    pathSegments[0] === "v1" &&
    pathSegments[1] === "companies" &&
    pathSegments[2]
  ) {
    return {
      connectorName: "smartrecruiters",
      token: pathSegments[2].toLowerCase(),
    };
  }

  if (hostname === "apply.workable.com" && pathSegments[0]) {
    return {
      connectorName: "workable",
      token: pathSegments[0].toLowerCase(),
    };
  }

  if (
    hostname === "jobs.jobvite.com" &&
    pathSegments[0] &&
    (pathSegments.length === 1 ||
      pathSegments[1] === "jobs" ||
      pathSegments[1] === "job")
  ) {
    const token = pathSegments[0].toLowerCase();
    if (GENERIC_JOBVITE_TOKENS.has(token)) {
      return null;
    }
    return {
      connectorName: "jobvite",
      token,
    };
  }

  const teamtailorMatch = hostname.match(/^([a-z0-9-]+)\.teamtailor\.com$/i);
  if (
    teamtailorMatch?.[1] &&
    pathSegments[0] === "jobs" &&
    (pathSegments.length === 1 || pathSegments[1])
  ) {
    return {
      connectorName: "teamtailor",
      token: teamtailorMatch[1].toLowerCase(),
    };
  }

  if (
    hostname === "www.workable.com" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "accounts" &&
    pathSegments[2]
  ) {
    return {
      connectorName: "workable",
      token: pathSegments[2].toLowerCase(),
    };
  }

  // Taleo: {tenant}.taleo.net/careersection/{section}/...
  const taleoMatch = hostname.match(/^([a-z0-9-]+)\.taleo\.net$/i);
  if (taleoMatch?.[1] && pathSegments[0] === "careersection" && pathSegments[1]) {
    const section = pathSegments[1].toLowerCase();
    // Skip generic paths like "sitemap.jss"
    if (section !== "sitemap.jss" && section !== "rest") {
      return {
        connectorName: "taleo",
        token: `${taleoMatch[1].toLowerCase()}/${section}`,
      };
    }
  }

  // iCIMS: {prefix}.icims.com/jobs/...
  const icimsMatch = hostname.match(/^([a-z0-9-]+)\.icims\.com$/i);
  if (icimsMatch?.[1] && (pathSegments[0] === "jobs" || pathSegments.length === 0)) {
    return {
      connectorName: "icims",
      token: icimsMatch[1].toLowerCase(),
    };
  }

  const workdayMatch = hostname.match(
    /^([a-z0-9-]+)\.(wd\d+)\.(?:myworkdayjobs|myworkdaysite)\.com$/i
  );
  if (workdayMatch) {
    if (
      pathSegments[0] === "wday" &&
      pathSegments[1] === "cxs" &&
      pathSegments[2] &&
      pathSegments[3] &&
      pathSegments[4] === "jobs"
    ) {
      return {
        connectorName: "workday",
        token: buildWorkdaySourceToken({
          host: hostname,
          tenant: pathSegments[2],
          site: pathSegments[3],
        }),
      };
    }

    if (
      pathSegments[0] === "wday" &&
      pathSegments[1] === "apply" &&
      pathSegments[2] &&
      pathSegments[3]
    ) {
      return {
        connectorName: "workday",
        token: buildWorkdaySourceToken({
          host: hostname,
          tenant: pathSegments[2],
          site: pathSegments[3],
        }),
      };
    }

    const localeOffset =
      pathSegments[0]?.match(/^[a-z]{2}(?:-[a-z]{2})?$/i) ? 1 : 0;
    const siteSegment = pathSegments[localeOffset];

    if (
      siteSegment &&
      (pathSegments[localeOffset + 1] === "job" ||
        pathSegments.length === localeOffset + 1)
    ) {
      return {
        connectorName: "workday",
        token: buildWorkdaySourceToken({
          host: hostname,
          tenant: workdayMatch[1],
          site: siteSegment,
        }),
      };
    }
  }

  return null;
}

export function createConnectorForCandidate(candidate: DiscoveredSourceCandidate) {
  switch (candidate.connectorName) {
    case "ashby":
      return createAshbyConnector({ orgSlug: candidate.token });
    case "greenhouse":
      return createGreenhouseConnector({ boardToken: candidate.token });
    case "lever":
      return createLeverConnector({ siteToken: candidate.token });
    case "recruitee":
      return createRecruiteeConnector({ companyIdentifier: candidate.token });
    case "rippling":
      return createRipplingConnector({ boardSlug: candidate.token });
    case "successfactors":
      return createSuccessFactorsConnector({ sourceToken: candidate.token });
    case "smartrecruiters":
      return createSmartRecruitersConnector({
        companyIdentifier: candidate.token,
      });
    case "workday":
      return createWorkdayConnector({
        sourceToken: candidate.token,
      });
    case "workable":
      return createWorkableConnector({ accountToken: candidate.token });
    case "jobvite":
      return createJobviteConnector({ companyToken: candidate.token });
    case "teamtailor":
      return createTeamtailorConnector({ companyToken: candidate.token });
    case "icims":
      return createIcimsConnector({ portalSubdomain: candidate.token });
    case "taleo":
      return createTaleoConnector({ sourceToken: candidate.token });
    case "adzuna":
      return createAdzunaConnector({ country: candidate.token });
    case "remoteok":
      return createRemoteOkConnector();
    case "usajobs":
      return createUsaJobsConnector({ keyword: candidate.token });
    case "himalayas":
      return createHimalayasConnector();
    case "jobicy":
      return createJobicyConnector();
    case "remotive":
      return createRemotiveConnector();
    case "themuse":
      return createMuseConnector();
    default:
      throw new Error(
        `Unsupported discovered source connector: ${candidate.connectorName}`
      );
  }
}

async function getExistingSourceStats(
  candidate: DiscoveredSourceCandidate
): Promise<ExistingSourceStats> {
  return getExistingSourceStatsForSourceName(candidate.sourceName);
}

export async function getExistingSourceStatsForSourceName(
  sourceName: string
): Promise<ExistingSourceStats> {

  const [rawCount, activeMappingCount, liveCanonicalCount] = await Promise.all([
    prisma.jobRaw.count({
      where: { sourceName },
    }),
    prisma.jobSourceMapping.count({
      where: {
        sourceName,
        removedAt: null,
      },
    }),
    prisma.jobCanonical.count({
      where: {
        status: { in: ["LIVE", "AGING"] },
        sourceMappings: {
          some: {
            sourceName,
            removedAt: null,
          },
        },
      },
    }),
  ]);

  return {
    rawCount,
    activeMappingCount,
    liveCanonicalCount,
  };
}

export async function fetchBingRssLinks(query: string, maxLinks: number) {
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

async function fetchBoardTitle(boardUrl: string) {
  const html = await fetchPageText(boardUrl, "text/html");
  return html.match(TITLE_RE)?.[1]?.trim() ?? null;
}

async function fetchPageText(url: string, accept: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DISCOVERY_FETCH_TIMEOUT_MS),
    headers: {
      Accept: accept,
      "User-Agent": "Mozilla/5.0 (compatible; autoapplication-source-discovery/1.0)",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
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
