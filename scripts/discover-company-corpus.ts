import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import {
  buildCompanyDiscoveryCorpus,
  buildCompanyKey,
  type CompanyDiscoveryCorpusEntry,
} from "../src/lib/ingestion/discovery/company-corpus";
import {
  discoverEnterpriseCareerPageCandidates,
  type CareerPageDiscoveryRecord,
} from "../src/lib/ingestion/discovery/career-pages";
import {
  buildDiscoveredSourceName,
  createConnectorForCandidate,
  fetchBingRssLinks,
  isKnownAtsHost,
  previewSourceCandidates,
  type DiscoveredSourceCandidate,
  type SourceDiscoveryPreviewResult,
} from "../src/lib/ingestion/discovery/sources";
import { ingestConnector } from "../src/lib/ingestion/pipeline";
import type {
  EnterpriseCompanyRecord,
} from "../src/lib/ingestion/discovery/enterprise-catalog";
import type { SupportedConnectorName } from "../src/lib/ingestion/registry";

type KnownStatus = "pending" | "rejected" | "promoted";

type CliArgs = {
  limit: number;
  offset: number;
  "corpus-limit": number;
  "preview-limit": number;
  "ingest-limit": number;
  "min-canada-count": number;
  "min-live-count": number;
  out?: string;
  cache?: string;
  "store-path"?: string;
  "no-ingest"?: boolean;
};

type DomainResolutionCacheEntry = {
  companyKey: string;
  displayName: string;
  domains: string[];
  seedPageUrls: string[];
  query: string | null;
  resultUrls: string[];
  resolvedAt: string;
  resolutionSource: "catalog" | "search" | "unresolved";
};

type DomainResolutionCache = {
  updatedAt: string;
  entries: DomainResolutionCacheEntry[];
};

type DiscoveryStore = {
  updatedAt: string;
  entries: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
};

type CompanyResolutionResult = {
  companyKey: string;
  displayName: string;
  resolvedFrom: "catalog" | "cache" | "search" | "unresolved";
  query: string | null;
  domains: string[];
  seedPageUrls: string[];
  resultUrls: string[];
  company: EnterpriseCompanyRecord;
};

type EnrichedCareerRecord = CareerPageDiscoveryRecord & {
  preview: SourceDiscoveryPreviewResult | null;
  recommendedPromotion: boolean;
  promotionReason: string | null;
};

const DEFAULT_CACHE_PATH = "data/discovery/company-domain-cache.json";
const DEFAULT_STORE_PATH = "data/discovery/source-candidates.json";
const DOMAIN_RESOLUTION_CONCURRENCY = 6;
const INGEST_CONCURRENCY = 3;
const EXCLUDED_RESULT_HOST_RE =
  /(?:linkedin|glassdoor|indeed|ziprecruiter|monster|welcometothejungle|wellfound|levels\.fyi|wikipedia|crunchbase|pitchbook|rocketreach|bloomberg|news|facebook|instagram|x\.com|twitter|youtube|tiktok|reddit|github|stackoverflow|simplyhired)\./i;
const CAREERISH_PATH_RE =
  /\/(?:careers?|jobs?|join-us|work-with-us|about\/careers?|company\/careers?)/i;

const args = parseArgs(process.argv.slice(2));

async function main() {
  const outputPath = path.resolve(
    args.out ??
      `data/discovery/seeds/company-corpus-official-${String(args.offset).padStart(
        4,
        "0"
      )}-${String(args.limit).padStart(4, "0")}.json`
  );
  const reportPath = outputPath.replace(/\.json$/i, ".report.json");
  const corpusPath = outputPath.replace(/\.json$/i, ".corpus.json");
  const cachePath = path.resolve(args.cache ?? DEFAULT_CACHE_PATH);
  const storePath = path.resolve(args["store-path"] ?? DEFAULT_STORE_PATH);

  const corpus = await buildCompanyDiscoveryCorpus({
    limit: args["corpus-limit"],
    minCanadaRelevantCount: args["min-canada-count"],
    minTotalLiveCount: args["min-live-count"],
  });
  const batch = corpus.slice(args.offset, args.offset + args.limit);

  const knownStatuses = await loadKnownSourceStatuses(storePath);
  const cache = await loadDomainResolutionCache(cachePath);
  const resolutions = await resolveCompanyBatch(batch, cache);
  await saveDomainResolutionCache(cachePath, cache);

  const resolvedCompanies = resolutions
    .filter((resolution) => resolution.domains.length > 0 || resolution.seedPageUrls.length > 0)
    .map((resolution) => resolution.company);

  const careerDiscovery = await discoverEnterpriseCareerPageCandidates({
    companies: resolvedCompanies,
    knownStatuses,
  });

  const candidates = careerDiscovery.records.map<DiscoveredSourceCandidate>((record) => ({
    input: record.boardUrl,
    connectorName: record.connectorName as SupportedConnectorName,
    token: record.token,
    sourceKey: record.sourceKey,
    sourceName: buildDiscoveredSourceName(
      record.connectorName as SupportedConnectorName,
      record.token
    ),
    boardUrl: record.boardUrl,
    source: "token",
  }));

  const previewResults = await previewSourceCandidates(candidates, args["preview-limit"]);
  const previewBySourceKey = new Map(
    previewResults.map((result) => [result.sourceKey, result])
  );

  const enrichedRecords = careerDiscovery.records
    .map((record) => {
      const preview = previewBySourceKey.get(record.sourceKey) ?? null;
      const decision = decidePromotion(preview);

      return {
        ...record,
        preview,
        recommendedPromotion: decision.recommendedPromotion,
        promotionReason: decision.reason,
      } satisfies EnrichedCareerRecord;
    })
    .sort((left, right) => {
      const leftCanada = left.preview?.previewCreatedCanadaCount ?? 0;
      const rightCanada = right.preview?.previewCreatedCanadaCount ?? 0;
      if (rightCanada !== leftCanada) return rightCanada - leftCanada;
      const leftCreated = left.preview?.previewCreatedCount ?? 0;
      const rightCreated = right.preview?.previewCreatedCount ?? 0;
      if (rightCreated !== leftCreated) return rightCreated - leftCreated;
      return left.sourceKey.localeCompare(right.sourceKey);
    });

  const promotedRecords = enrichedRecords.filter((record) => record.recommendedPromotion);
  const rejectedRecords = enrichedRecords.filter(
    (record) =>
      !record.recommendedPromotion &&
      (record.preview?.error ||
        ((record.preview?.previewCreatedCount ?? 0) === 0 &&
          (record.preview?.acceptedCanadaCount ?? 0) === 0))
  );

  await upsertDiscoveryStoreEntries(
    storePath,
    enrichedRecords,
    previewBySourceKey,
    resolutions
  );

  const ingestSummaries =
    args["no-ingest"] === true
      ? []
      : await ingestPromotedRecords(promotedRecords, args["ingest-limit"]);

  const summary = {
    generatedAt: new Date().toISOString(),
    corpusCount: corpus.length,
    batchOffset: args.offset,
    batchLimit: args.limit,
    companiesProcessed: batch.length,
    companiesResolved: resolvedCompanies.length,
    companiesUnresolved: batch.length - resolvedCompanies.length,
    domainsSeeded: careerDiscovery.summary.domainsSeeded,
    careerPagesDetected: careerDiscovery.summary.careerPagesDetected,
    directAtsUrlsDetected: careerDiscovery.summary.directAtsUrlsDetected,
    candidatesDiscovered: careerDiscovery.summary.candidatesDiscovered,
    newCandidates: careerDiscovery.summary.newCandidates,
    skippedKnownCandidates: careerDiscovery.summary.skippedKnownCandidates,
    promotedSources: promotedRecords.map((record) => ({
      sourceKey: record.sourceKey,
      connectorName: record.connectorName,
      companyNames: record.companyNames,
      previewCreatedCount: record.preview?.previewCreatedCount ?? 0,
      previewCreatedCanadaCount: record.preview?.previewCreatedCanadaCount ?? 0,
      acceptedCount: record.preview?.acceptedCount ?? 0,
      acceptedCanadaCount: record.preview?.acceptedCanadaCount ?? 0,
      boardUrl: record.boardUrl,
      promotionReason: record.promotionReason,
    })),
    rejectedSources: rejectedRecords.slice(0, 50).map((record) => ({
      sourceKey: record.sourceKey,
      connectorName: record.connectorName,
      companyNames: record.companyNames,
      boardUrl: record.boardUrl,
      error: record.preview?.error ?? null,
      previewCreatedCount: record.preview?.previewCreatedCount ?? 0,
      acceptedCanadaCount: record.preview?.acceptedCanadaCount ?? 0,
    })),
    ingestSummaries,
    resolutionSummary: {
      catalog: resolutions.filter((resolution) => resolution.resolvedFrom === "catalog")
        .length,
      cache: resolutions.filter((resolution) => resolution.resolvedFrom === "cache").length,
      search: resolutions.filter((resolution) => resolution.resolvedFrom === "search").length,
      unresolved: resolutions.filter((resolution) => resolution.resolvedFrom === "unresolved")
        .length,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(enrichedRecords, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(
    corpusPath,
    `${JSON.stringify(
      batch.map((entry) => ({
        displayName: entry.displayName,
        aliases: entry.aliases,
        totalLiveCount: entry.totalLiveCount,
        canadaRelevantCount: entry.canadaRelevantCount,
        canadaRemoteCount: entry.canadaRemoteCount,
        matchedCatalogName: entry.matchedCatalogName,
        score: entry.score,
      })),
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(JSON.stringify(summary, null, 2));
}

async function resolveCompanyBatch(
  batch: CompanyDiscoveryCorpusEntry[],
  cache: DomainResolutionCache
) {
  const results = new Array<CompanyResolutionResult>(batch.length);
  let cursor = 0;

  async function worker() {
    while (cursor < batch.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await resolveCompany(batch[index]!, cache);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DOMAIN_RESOLUTION_CONCURRENCY, batch.length) },
      () => worker()
    )
  );

  return results.filter(Boolean);
}

async function resolveCompany(
  entry: CompanyDiscoveryCorpusEntry,
  cache: DomainResolutionCache
): Promise<CompanyResolutionResult> {
  if ((entry.record.domains?.length ?? 0) > 0 || (entry.record.seedPageUrls?.length ?? 0) > 0) {
    return {
      companyKey: entry.companyKey,
      displayName: entry.displayName,
      resolvedFrom: "catalog",
      query: null,
      domains: [...(entry.record.domains ?? [])],
      seedPageUrls: [...(entry.record.seedPageUrls ?? [])],
      resultUrls: [...(entry.record.seedPageUrls ?? [])],
      company: entry.record,
    };
  }

  const cached = cache.entries.find((item) => item.companyKey === entry.companyKey);
  if (cached) {
    return {
      companyKey: entry.companyKey,
      displayName: entry.displayName,
      resolvedFrom: cached.resolutionSource === "search" ? "cache" : cached.resolutionSource,
      query: cached.query,
      domains: cached.domains,
      seedPageUrls: cached.seedPageUrls,
      resultUrls: cached.resultUrls,
      company: mergeResolutionIntoRecord(entry.record, cached.domains, cached.seedPageUrls),
    };
  }

  const queryCandidates = [
    `"${entry.displayName}" careers`,
    `"${entry.displayName}" official site`,
  ];

  let chosen: DomainResolutionCacheEntry | null = null;

  for (const query of queryCandidates) {
    const resultUrls = await fetchBingRssLinks(query, 6).catch(() => []);
    const resolution = resolveOfficialUrls(entry, resultUrls);
    if (!resolution) continue;
    chosen = {
      companyKey: entry.companyKey,
      displayName: entry.displayName,
      domains: resolution.domains,
      seedPageUrls: resolution.seedPageUrls,
      query,
      resultUrls,
      resolvedAt: new Date().toISOString(),
      resolutionSource: "search",
    };
    break;
  }

  if (!chosen) {
    chosen = {
      companyKey: entry.companyKey,
      displayName: entry.displayName,
      domains: [],
      seedPageUrls: [],
      query: null,
      resultUrls: [],
      resolvedAt: new Date().toISOString(),
      resolutionSource: "unresolved",
    };
  }

  upsertDomainResolutionCacheEntry(cache, chosen);

  return {
    companyKey: entry.companyKey,
    displayName: entry.displayName,
    resolvedFrom: chosen.resolutionSource,
    query: chosen.query,
    domains: chosen.domains,
    seedPageUrls: chosen.seedPageUrls,
    resultUrls: chosen.resultUrls,
    company: mergeResolutionIntoRecord(entry.record, chosen.domains, chosen.seedPageUrls),
  };
}

function resolveOfficialUrls(
  entry: CompanyDiscoveryCorpusEntry,
  resultUrls: string[]
) {
  const companyKey = buildCompanyKey(entry.displayName);
  const candidates = resultUrls
    .map((url) => {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const baseDomain = toBaseDomain(hostname);
        if (
          !baseDomain ||
          isKnownAtsHost(hostname) ||
          EXCLUDED_RESULT_HOST_RE.test(hostname)
        ) {
          return null;
        }

        let score = 0;
        const baseKey = buildCompanyKey(baseDomain.split(".")[0] ?? "");
        if (baseKey && companyKey.includes(baseKey)) score += 6;
        if (companyKey && baseKey && baseKey.includes(companyKey.slice(0, 8))) score += 4;
        if (CAREERISH_PATH_RE.test(parsed.pathname)) score += 8;
        if (parsed.pathname === "/" || parsed.pathname === "") score += 2;

        return {
          url,
          hostname,
          baseDomain,
          score,
        };
      } catch {
        return null;
      }
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => right.score - left.score);

  if (candidates.length === 0) return null;

  const bestDomain = candidates[0]!.baseDomain;
  const seedPageUrls = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.baseDomain === bestDomain)
        .map((candidate) => candidate.url)
        .filter((url) => CAREERISH_PATH_RE.test(url))
    ),
  ];

  return {
    domains: [bestDomain],
    seedPageUrls,
  };
}

function decidePromotion(preview: SourceDiscoveryPreviewResult | null) {
  if (!preview) {
    return { recommendedPromotion: false, reason: "no_preview" };
  }

  if (preview.error) {
    return { recommendedPromotion: false, reason: preview.error };
  }

  const acceptedCanadaRatio =
    preview.acceptedCount > 0
      ? preview.acceptedCanadaCount / preview.acceptedCount
      : 0;
  const createdCanadaRatio =
    preview.previewCreatedCount > 0
      ? preview.previewCreatedCanadaCount / preview.previewCreatedCount
      : 0;

  if (preview.previewCreatedCanadaCount >= 3) {
    return { recommendedPromotion: true, reason: "canada_heavy_created_volume" };
  }

  if (
    preview.previewCreatedCount >= 12 &&
    preview.previewCreatedCanadaCount >= 4 &&
    acceptedCanadaRatio >= 0.2
  ) {
    return { recommendedPromotion: true, reason: "broad_board_with_real_canada_slice" };
  }

  if (
    preview.previewCreatedCount >= 6 &&
    preview.previewCreatedCanadaCount >= 2 &&
    acceptedCanadaRatio >= 0.25
  ) {
    return { recommendedPromotion: true, reason: "strong_created_volume" };
  }

  if (
    preview.previewCreatedCount >= 1 &&
    preview.previewCreatedCanadaCount >= 1 &&
    (createdCanadaRatio >= 0.5 || acceptedCanadaRatio >= 0.6)
  ) {
    return { recommendedPromotion: true, reason: "canada_dense_small_board" };
  }

  if (
    preview.acceptedCount > 0 &&
    preview.acceptedCount === preview.acceptedCanadaCount &&
    preview.previewCreatedCount >= 1
  ) {
    return { recommendedPromotion: true, reason: "fully_canada_aligned" };
  }

  return { recommendedPromotion: false, reason: "insufficient_canada_weighted_yield" };
}

async function ingestPromotedRecords(
  records: EnrichedCareerRecord[],
  ingestLimit: number
) {
  const results = new Array<{
    sourceKey: string;
    connectorKey: string;
    sourceName: string;
    fetchedCount: number;
    acceptedCount: number;
    canonicalCreatedCount: number;
    canonicalUpdatedCount: number;
    dedupedCount: number;
    canonicalCreatedCanadaCount: number;
    canonicalCreatedCanadaRemoteCount: number;
  } | null>(records.length).fill(null);

  let cursor = 0;

  async function worker() {
    while (cursor < records.length) {
      const index = cursor;
      cursor += 1;
      const record = records[index]!;
      const candidate: DiscoveredSourceCandidate = {
        input: record.boardUrl,
        connectorName: record.connectorName as SupportedConnectorName,
        token: record.token,
        sourceKey: record.sourceKey,
        sourceName: buildDiscoveredSourceName(
          record.connectorName as SupportedConnectorName,
          record.token
        ),
        boardUrl: record.boardUrl,
        source: "token",
      };
      const connector = createConnectorForCandidate(candidate);
      const summary = await ingestConnector(connector, {
        limit: ingestLimit,
        triggerLabel: "company_corpus_official_discovery",
      });
      results[index] = {
        sourceKey: record.sourceKey,
        connectorKey: summary.connectorKey,
        sourceName: summary.sourceName,
        fetchedCount: summary.fetchedCount,
        acceptedCount: summary.acceptedCount,
        canonicalCreatedCount: summary.canonicalCreatedCount,
        canonicalUpdatedCount: summary.canonicalUpdatedCount,
        dedupedCount: summary.dedupedCount,
        canonicalCreatedCanadaCount: summary.canonicalCreatedCanadaCount,
        canonicalCreatedCanadaRemoteCount:
          summary.canonicalCreatedCanadaRemoteCount,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(INGEST_CONCURRENCY, records.length) }, () => worker())
  );

  return results.filter(Boolean);
}

async function upsertDiscoveryStoreEntries(
  storePath: string,
  records: EnrichedCareerRecord[],
  previewBySourceKey: Map<string, SourceDiscoveryPreviewResult>,
  resolutions: CompanyResolutionResult[]
) {
  const store = await loadDiscoveryStore(storePath);
  const entryMap = new Map(
    store.entries.map((entry) => [String(entry.sourceKey ?? ""), entry])
  );
  const now = new Date().toISOString();
  const companyByName = new Map(
    resolutions.map((resolution) => [resolution.displayName, resolution])
  );

  for (const record of records) {
    const preview = previewBySourceKey.get(record.sourceKey);
    if (!preview) continue;

    const entry = entryMap.get(record.sourceKey) ?? {
      connectorName: record.connectorName,
      token: record.token,
      sourceKey: record.sourceKey,
      sourceName: buildDiscoveredSourceName(
        record.connectorName as SupportedConnectorName,
        record.token
      ),
      boardUrl: record.boardUrl,
      status: "pending",
      firstDiscoveredAt: now,
      discoveredFrom: [],
    };

    entry.connectorName = record.connectorName;
    entry.token = record.token;
    entry.sourceKey = record.sourceKey;
    entry.sourceName = buildDiscoveredSourceName(
      record.connectorName as SupportedConnectorName,
      record.token
    );
    entry.boardUrl = record.boardUrl;
    entry.status = record.recommendedPromotion
      ? "promoted"
      : preview.error ||
          (preview.previewCreatedCount === 0 && preview.acceptedCanadaCount === 0)
        ? "rejected"
        : "pending";
    entry.lastDiscoveredAt = now;
    entry.lastValidatedAt = now;
    entry.promotedAt = record.recommendedPromotion ? now : null;
    entry.rejectedAt = entry.status === "rejected" ? now : null;
    entry.decisionReason = record.promotionReason;
    entry.validation = {
      valid: !preview.error,
      threshold: 1,
      recommendedPromotion: record.recommendedPromotion,
      pageTitle: preview.pageTitle,
      fetchedCount: preview.fetchedCount,
      acceptedCount: preview.acceptedCount,
      previewCreatedCount: preview.previewCreatedCount,
      previewUpdatedCount: preview.previewUpdatedCount,
      dedupedCount: preview.dedupedCount,
      rejectedCount: preview.rejectedCount,
      existingRawCount: preview.existingRawCount,
      existingActiveMappingCount: preview.existingActiveMappingCount,
      existingLiveCanonicalCount: preview.existingLiveCanonicalCount,
      sampleTitles: preview.sampleTitles,
      sampleLocations: preview.sampleLocations,
      acceptedCanadaCount: preview.acceptedCanadaCount,
      acceptedCanadaRemoteCount: preview.acceptedCanadaRemoteCount,
      previewCreatedCanadaCount: preview.previewCreatedCanadaCount,
      previewCreatedCanadaRemoteCount: preview.previewCreatedCanadaRemoteCount,
    };

    const discoveredFrom = Array.isArray(entry.discoveredFrom) ? entry.discoveredFrom : [];
    for (const companyName of record.companyNames) {
      const resolution = companyByName.get(companyName);
      discoveredFrom.push({
        type: "company_corpus_careers",
        value: companyName,
        discoveredAt: now,
        sourcePageUrl: resolution?.seedPageUrls[0] ?? record.careerPageUrls[0] ?? null,
      });
    }
    entry.discoveredFrom = dedupeDiscoverySources(discoveredFrom);

    if (!entryMap.has(record.sourceKey)) {
      store.entries.push(entry);
      entryMap.set(record.sourceKey, entry);
    }
  }

  store.updatedAt = now;
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function dedupeDiscoverySources(sources: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    const key = JSON.stringify([
      source.type,
      source.value,
      source.sourcePageUrl ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

function mergeResolutionIntoRecord(
  record: EnterpriseCompanyRecord,
  domains: string[],
  seedPageUrls: string[]
) {
  return {
    ...record,
    domains: [...new Set([...(record.domains ?? []), ...domains])],
    seedPageUrls: [...new Set([...(record.seedPageUrls ?? []), ...seedPageUrls])],
  };
}

function upsertDomainResolutionCacheEntry(
  cache: DomainResolutionCache,
  entry: DomainResolutionCacheEntry
) {
  const existingIndex = cache.entries.findIndex(
    (item) => item.companyKey === entry.companyKey
  );
  if (existingIndex === -1) {
    cache.entries.push(entry);
  } else {
    cache.entries[existingIndex] = entry;
  }
  cache.updatedAt = new Date().toISOString();
}

function toBaseDomain(hostname: string) {
  const normalized = hostname.replace(/^www\./, "").toLowerCase();
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) return normalized;

  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");

  if (/\.(?:co|com|org|net)\.[a-z]{2}$/i.test(lastThree)) {
    return lastThree;
  }

  return lastTwo;
}

function parseArgs(argv: string[]) {
  const parsed: CliArgs = {
    limit: 250,
    offset: 0,
    "corpus-limit": 1000,
    "preview-limit": 100,
    "ingest-limit": 200,
    "min-canada-count": 1,
    "min-live-count": 1,
  };

  for (const rawArg of argv) {
    const normalizedArg = rawArg.replace(/^--/, "");
    const separatorIndex = normalizedArg.indexOf("=");
    const key =
      separatorIndex === -1
        ? normalizedArg
        : normalizedArg.slice(0, separatorIndex);
    const value =
      separatorIndex === -1 ? true : normalizedArg.slice(separatorIndex + 1);

    if (!key) continue;
    if (
      key === "limit" ||
      key === "offset" ||
      key === "corpus-limit" ||
      key === "preview-limit" ||
      key === "ingest-limit" ||
      key === "min-canada-count" ||
      key === "min-live-count"
    ) {
      (parsed as Record<string, number | string | boolean | undefined>)[key] =
        Number.parseInt(String(value), 10);
    } else {
      (parsed as Record<string, number | string | boolean | undefined>)[key] = value;
    }
  }

  return parsed;
}

async function loadKnownSourceStatuses(storePath: string) {
  try {
    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      entries?: Array<{ sourceKey: string; status: KnownStatus }>;
    };
    return new Map(
      (store.entries ?? []).map((entry) => [entry.sourceKey, entry.status])
    );
  } catch {
    return new Map<string, KnownStatus>();
  }
}

async function loadDomainResolutionCache(cachePath: string): Promise<DomainResolutionCache> {
  try {
    return JSON.parse(await readFile(cachePath, "utf8")) as DomainResolutionCache;
  } catch {
    return {
      updatedAt: new Date(0).toISOString(),
      entries: [],
    };
  }
}

async function saveDomainResolutionCache(
  cachePath: string,
  cache: DomainResolutionCache
) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function loadDiscoveryStore(storePath: string): Promise<DiscoveryStore> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as DiscoveryStore;
  } catch {
    return {
      updatedAt: new Date(0).toISOString(),
      entries: [],
      runs: [],
    };
  }
}

main()
  .catch((error) => {
    console.error("Company corpus discovery failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
