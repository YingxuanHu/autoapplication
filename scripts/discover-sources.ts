import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import {
  SOURCE_DISCOVERY_PROMOTION_THRESHOLD,
  buildDiscoveredSourceKey,
  buildDiscoveredSourceName,
  buildDiscoveredSourceUrl,
  discoverSourceCandidatesFromDataset,
  discoverSourceCandidatesFromPageUrls,
  discoverSourceCandidatesFromSearch,
  discoverSourceCandidatesFromUrls,
  getExistingSourceStatsForSourceName,
  isKnownAtsHost,
  previewSourceCandidates,
  type DatasetDiscoveryReport,
  type SearchDiscoveryReport,
  type SourceDiscoveryPreviewResult,
} from "../src/lib/ingestion/discovery/sources";
import { getScheduledConnectors, type SupportedConnectorName } from "../src/lib/ingestion/registry";

type DiscoveryStatus = "pending" | "rejected" | "promoted";

type DiscoverySourceRecord = {
  type:
    | "scheduled_coverage"
    | "internal_url"
    | "internal_page"
    | "manual_url"
    | "manual_page"
    | "search_query"
    | "dataset"
    | "rippling_registry_import";
  value: string;
  discoveredAt: string;
  sourcePageUrl?: string;
  query?: string;
  filePath?: string;
};

type DiscoveryValidation = {
  valid: boolean;
  threshold: number;
  recommendedPromotion: boolean;
  pageTitle: string | null;
  fetchedCount: number;
  acceptedCount: number;
  previewCreatedCount: number;
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

type DiscoveryStoreEntry = {
  connectorName: SupportedConnectorName;
  token: string;
  sourceKey: string;
  sourceName: string;
  boardUrl: string;
  status: DiscoveryStatus;
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  discoveredFrom: DiscoverySourceRecord[];
  lastValidatedAt?: string;
  validation?: DiscoveryValidation;
  decisionReason?: string | null;
  promotedAt?: string | null;
  rejectedAt?: string | null;
};

type DiscoveryRunReport = {
  ranAt: string;
  internalUrlCount: number;
  internalPageUrlCount: number;
  internalCandidateCount: number;
  previewedCount: number;
  topUnknownHosts: Array<{ host: string; count: number }>;
};

type DiscoveryStore = {
  updatedAt: string;
  entries: DiscoveryStoreEntry[];
  runs: DiscoveryRunReport[];
};

type RipplingStoreEntry = {
  boardSlug: string;
  boardUrl: string;
  status: DiscoveryStatus;
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  discoveredFrom?: Array<{
    type: string;
    value: string;
    discoveredAt: string;
    sourcePageUrl?: string;
  }>;
  lastValidatedAt?: string;
  validation?: DiscoveryValidation;
  decisionReason?: string | null;
  promotedAt?: string | null;
  rejectedAt?: string | null;
};

type RipplingStore = {
  entries: RipplingStoreEntry[];
};

const DEFAULT_STORE_PATH = "data/discovery/source-candidates.json";
const DEFAULT_RIPPLING_STORE_PATH = "data/discovery/rippling-slugs.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const storePath = path.resolve(args.store ?? DEFAULT_STORE_PATH);
  const store = await loadStore(storePath);

  bootstrapScheduledCoverage(store, now);
  await importRipplingRegistry(store, now, path.resolve(DEFAULT_RIPPLING_STORE_PATH));

  const entryMap = new Map(store.entries.map((entry) => [entry.sourceKey, entry]));
  const existingBeforeRun = new Set(store.entries.map((entry) => entry.sourceKey));

  const manualUrls = splitArg(args.urls);
  const manualPageUrls = splitArg(args.sourcePages);
  const datasetPaths = splitArg(args.dataset);
  const searchQueries = splitArg(args.queries);
  const searchFamilies = splitArg(args.families) as SupportedConnectorName[];
  const internalScan = args.internal === false
    ? {
        urls: [] as string[],
        pageUrls: [] as string[],
        topUnknownHosts: [] as Array<{ host: string; count: number }>,
      }
    : await loadInternalDiscoveryInputs(args.maxInternalPages ?? 50);

  const manualUrlDiscovery = await discoverSourceCandidatesFromUrls(manualUrls);
  const manualPageDiscovery = await discoverSourceCandidatesFromPageUrls(manualPageUrls);
  const internalUrlDiscovery = await discoverSourceCandidatesFromUrls(
    internalScan.urls
  );
  const internalPageDiscovery = await discoverSourceCandidatesFromPageUrls(
    internalScan.pageUrls
  );

  // Search-based discovery (Bing RSS)
  const searchDiscovery = args.search
    ? await discoverSourceCandidatesFromSearch({
        families: searchFamilies.length > 0 ? searchFamilies : undefined,
        queries: searchQueries.length > 0 ? searchQueries : undefined,
        maxResultUrlsPerQuery: args.maxSearchResults,
      })
    : { candidates: [], reports: [] as SearchDiscoveryReport[], sourceMap: new Map() as Map<string, Array<{ type: "search_query"; value: string; query: string; sourcePageUrl?: string }>> };

  // Dataset file ingestion
  const datasetDiscovery = datasetPaths.length > 0
    ? await discoverSourceCandidatesFromDataset(datasetPaths)
    : { candidates: [], reports: [] as DatasetDiscoveryReport[], sourceMap: new Map() as Map<string, Array<{ type: "dataset"; value: string; filePath: string }>> };

  const mergedCandidateMap = new Map<
    string,
    ReturnType<typeof mergeCandidateSource>
  >();

  for (const candidate of [
    ...internalUrlDiscovery.candidates,
    ...internalPageDiscovery.candidates,
    ...manualUrlDiscovery.candidates,
    ...manualPageDiscovery.candidates,
    ...searchDiscovery.candidates,
    ...datasetDiscovery.candidates,
  ]) {
    mergedCandidateMap.set(candidate.sourceKey, mergeCandidateSource(candidate));
  }

  const mergedCandidates = [...mergedCandidateMap.values()];

  for (const candidate of mergedCandidates) {
    const existing = entryMap.get(candidate.sourceKey);
    const entry = existing ?? {
      connectorName: candidate.connectorName,
      token: candidate.token,
      sourceKey: candidate.sourceKey,
      sourceName: candidate.sourceName,
      boardUrl: candidate.boardUrl,
      status: "pending" as const,
      firstDiscoveredAt: now.toISOString(),
      lastDiscoveredAt: now.toISOString(),
      discoveredFrom: [],
      decisionReason: null,
    };

    entry.connectorName = candidate.connectorName;
    entry.token = candidate.token;
    entry.sourceName = candidate.sourceName;
    entry.boardUrl = candidate.boardUrl;
    entry.lastDiscoveredAt = now.toISOString();

    if (!existing) {
      store.entries.push(entry);
      entryMap.set(entry.sourceKey, entry);
    }
  }

  annotateSources(
    entryMap,
    internalUrlDiscovery.sourceMap,
    "internal_url",
    now
  );
  annotateSources(
    entryMap,
    internalPageDiscovery.sourceMap,
    "internal_page",
    now
  );
  annotateSources(
    entryMap,
    manualUrlDiscovery.sourceMap,
    "manual_url",
    now
  );
  annotateSources(
    entryMap,
    manualPageDiscovery.sourceMap,
    "manual_page",
    now
  );
  annotateSearchSources(entryMap, searchDiscovery.sourceMap, now);
  annotateDatasetSources(entryMap, datasetDiscovery.sourceMap, now);

  const existingStatsBySourceKey = new Map<
    string,
    Awaited<ReturnType<typeof getExistingSourceStatsForSourceName>>
  >();
  for (const candidate of mergedCandidates) {
    const entry = entryMap.get(candidate.sourceKey);
    if (!entry) continue;
    existingStatsBySourceKey.set(
      candidate.sourceKey,
      await getExistingSourceStatsForSourceName(entry.sourceName)
    );
  }
  for (const [sourceKey, existingStats] of existingStatsBySourceKey.entries()) {
    const entry = entryMap.get(sourceKey);
    if (!entry || entry.lastValidatedAt) continue;
    applyExistingSourceStats(entry, existingStats, now, args.threshold);
  }

  const explicitSourceKeys = new Set([
    ...manualUrlDiscovery.candidates.map((candidate) => candidate.sourceKey),
    ...manualPageDiscovery.candidates.map((candidate) => candidate.sourceKey),
    ...searchDiscovery.candidates.map((candidate) => candidate.sourceKey),
    ...datasetDiscovery.candidates.map((candidate) => candidate.sourceKey),
  ]);

  const candidateSourceKeysForValidation = mergedCandidates
    .map((candidate) => candidate.sourceKey)
    .filter((sourceKey, index, items) => items.indexOf(sourceKey) === index)
    .filter((sourceKey) => {
      const entry = entryMap.get(sourceKey);
      if (!entry) return false;
      if (args.retest) return true;
      if (explicitSourceKeys.has(sourceKey)) return true;
      const existingStats = existingStatsBySourceKey.get(sourceKey);
      if (
        existingStats &&
        (existingStats.rawCount > 0 || existingStats.liveCanonicalCount > 0)
      ) {
        return false;
      }
      return !entry.lastValidatedAt;
    });

  const results =
    candidateSourceKeysForValidation.length === 0
      ? []
      : await previewSourceCandidates(
          candidateSourceKeysForValidation.map((sourceKey) => {
            const entry = entryMap.get(sourceKey);
            if (!entry) {
              throw new Error(`Missing discovery entry for ${sourceKey}`);
            }
            return {
              input: entry.boardUrl,
              connectorName: entry.connectorName,
              token: entry.token,
              sourceKey: entry.sourceKey,
              sourceName: entry.sourceName,
              boardUrl: entry.boardUrl,
              source: "token" as const,
            };
          }),
          args.limit
        );

  for (const result of results) {
    applyPreviewResult(entryMap.get(result.sourceKey), result, now, args.threshold);
  }

  const promoteSet = new Set(splitArg(args.promote));
  for (const sourceKey of promoteSet) {
    const normalizedSourceKey = normalizeSourceKey(sourceKey);
    const entry = entryMap.get(normalizedSourceKey);
    if (!entry) continue;
    entry.status = "promoted";
    entry.promotedAt = now.toISOString();
    entry.rejectedAt = null;
    entry.decisionReason = "manually_promoted";
  }

  store.entries = store.entries.sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey)
  );
  store.runs = [
    ...(store.runs ?? []),
    {
      ranAt: now.toISOString(),
      internalUrlCount: internalScan.urls.length,
      internalPageUrlCount: internalScan.pageUrls.length,
      internalCandidateCount:
        internalUrlDiscovery.candidates.length + internalPageDiscovery.candidates.length,
      previewedCount: results.length,
      topUnknownHosts: internalScan.topUnknownHosts.slice(0, 20),
    },
  ].slice(-100);
  store.updatedAt = now.toISOString();

  await saveStore(storePath, store);

  const statusCounts = store.entries.reduce(
    (counts, entry) => {
      counts[entry.status] += 1;
      return counts;
    },
    {
      pending: 0,
      rejected: 0,
      promoted: 0,
    }
  );
  const connectorCounts = store.entries.reduce<Record<string, number>>(
    (counts, entry) => {
      counts[entry.connectorName] = (counts[entry.connectorName] ?? 0) + 1;
      return counts;
    },
    {}
  );
  const strongCandidates = store.entries
    .filter(
      (entry) =>
        entry.status === "pending" && entry.validation?.recommendedPromotion
    )
    .sort((left, right) => {
      const leftStrength = Math.max(
        left.validation?.previewCreatedCount ?? 0,
        left.validation?.existingLiveCanonicalCount ?? 0
      );
      const rightStrength = Math.max(
        right.validation?.previewCreatedCount ?? 0,
        right.validation?.existingLiveCanonicalCount ?? 0
      );
      return rightStrength - leftStrength;
    })
    .slice(0, 20)
    .map((entry) => ({
      sourceKey: entry.sourceKey,
      boardUrl: entry.boardUrl,
      previewCreatedCount: entry.validation?.previewCreatedCount ?? 0,
      acceptedCount: entry.validation?.acceptedCount ?? 0,
      existingLiveCanonicalCount:
        entry.validation?.existingLiveCanonicalCount ?? 0,
      sampleTitles: entry.validation?.sampleTitles ?? [],
    }));
  const discoveredThisRun = store.entries.filter(
    (entry) =>
      entry.firstDiscoveredAt === now.toISOString() ||
      !existingBeforeRun.has(entry.sourceKey)
  );

  console.log(
    JSON.stringify(
      {
        storePath,
        threshold: args.threshold,
        discoveredCandidateCount: mergedCandidates.length,
        newCandidateCount: discoveredThisRun.length,
        validatedThisRun: results.length,
        limit: args.limit ?? null,
        internalScan: {
          urlsScanned: internalScan.urls.length,
          pageUrlsScanned: internalScan.pageUrls.length,
          urlCandidates: internalUrlDiscovery.candidates.length,
          pageCandidates: internalPageDiscovery.candidates.length,
          unknownHosts: internalScan.topUnknownHosts,
        },
        manualInputs: {
          urls: manualUrls.length,
          pageUrls: manualPageUrls.length,
          urlCandidates: manualUrlDiscovery.candidates.length,
          pageCandidates: manualPageDiscovery.candidates.length,
        },
        searchDiscovery: args.search
          ? {
              queriesRun: searchDiscovery.reports.length,
              candidatesFound: searchDiscovery.candidates.length,
              reports: searchDiscovery.reports,
            }
          : null,
        datasetDiscovery: datasetPaths.length > 0
          ? {
              filesProcessed: datasetDiscovery.reports.length,
              candidatesFound: datasetDiscovery.candidates.length,
              reports: datasetDiscovery.reports,
            }
          : null,
        candidatesByFamily: buildFamilyCounts(discoveredThisRun),
        statusCounts,
        connectorCounts,
        promotedSources: store.entries
          .filter((entry) => entry.status === "promoted")
          .map((entry) => entry.sourceKey),
        strongCandidates,
        results,
      },
      null,
      2
    )
  );
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs: {
    urls?: string;
    sourcePages?: string;
    dataset?: string;
    store?: string;
    promote?: string;
    queries?: string;
    families?: string;
    limit?: number;
    threshold: number;
    retest?: boolean;
    internal?: boolean;
    search?: boolean;
    maxInternalPages?: number;
    maxSearchResults?: number;
  } = {
    threshold: SOURCE_DISCOVERY_PROMOTION_THRESHOLD,
    internal: true,
  };

  for (const rawArg of rawArgs) {
    const normalizedArg = rawArg.replace(/^--/, "");
    const separatorIndex = normalizedArg.indexOf("=");
    const key =
      separatorIndex === -1
        ? normalizedArg
        : normalizedArg.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? undefined
        : normalizedArg.slice(separatorIndex + 1);
    if (!key) continue;

    if (key === "retest") {
      parsedArgs.retest = true;
      continue;
    }

    if (key === "no-internal") {
      parsedArgs.internal = false;
      continue;
    }

    if (key === "search") {
      parsedArgs.search = true;
      continue;
    }

    if (value === undefined) continue;

    if (key === "urls") parsedArgs.urls = value;
    if (key === "source-pages") parsedArgs.sourcePages = value;
    if (key === "dataset") parsedArgs.dataset = value;
    if (key === "store") parsedArgs.store = value;
    if (key === "promote") parsedArgs.promote = value;
    if (key === "queries") parsedArgs.queries = value;
    if (key === "families") parsedArgs.families = value;
    if (key === "limit") parsedArgs.limit = Number.parseInt(value, 10);
    if (key === "threshold") parsedArgs.threshold = Number.parseInt(value, 10);
    if (key === "max-internal-pages") {
      parsedArgs.maxInternalPages = Number.parseInt(value, 10);
    }
    if (key === "max-search-results") {
      parsedArgs.maxSearchResults = Number.parseInt(value, 10);
    }
  }

  if (parsedArgs.limit !== undefined && Number.isNaN(parsedArgs.limit)) {
    throw new Error(`Invalid --limit value "${String(parsedArgs.limit)}"`);
  }
  if (Number.isNaN(parsedArgs.threshold)) {
    throw new Error(`Invalid --threshold value "${String(parsedArgs.threshold)}"`);
  }
  if (
    parsedArgs.maxInternalPages !== undefined &&
    Number.isNaN(parsedArgs.maxInternalPages)
  ) {
    throw new Error(
      `Invalid --max-internal-pages value "${String(parsedArgs.maxInternalPages)}"`
    );
  }

  return parsedArgs;
}

function splitArg(rawValue: string | undefined) {
  return (rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function loadStore(storePath: string): Promise<DiscoveryStore> {
  try {
    const rawStore = await readFile(storePath, "utf8");
    const parsedStore = JSON.parse(rawStore) as DiscoveryStore;
    return {
      updatedAt: parsedStore.updatedAt ?? new Date(0).toISOString(),
      entries: parsedStore.entries ?? [],
      runs: parsedStore.runs ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        updatedAt: new Date(0).toISOString(),
        entries: [],
        runs: [],
      };
    }

    throw error;
  }
}

async function saveStore(storePath: string, store: DiscoveryStore) {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function bootstrapScheduledCoverage(store: DiscoveryStore, now: Date) {
  const entryMap = new Map(store.entries.map((entry) => [entry.sourceKey, entry]));

  for (const definition of getScheduledConnectors()) {
    const [connectorName, token] = splitConnectorKey(definition.connector.key);
    const sourceKey = buildDiscoveredSourceKey(connectorName, token);
    const existing = entryMap.get(sourceKey);
    const entry = existing ?? {
      connectorName,
      token,
      sourceKey,
      sourceName: buildDiscoveredSourceName(connectorName, token),
      boardUrl: buildDiscoveredSourceUrl(connectorName, token),
      status: "promoted" as const,
      firstDiscoveredAt: now.toISOString(),
      lastDiscoveredAt: now.toISOString(),
      discoveredFrom: [],
      decisionReason: "scheduled_coverage",
      promotedAt: now.toISOString(),
    };

    entry.status = "promoted";
    entry.connectorName = connectorName;
    entry.token = token;
    entry.sourceName = buildDiscoveredSourceName(connectorName, token);
    entry.boardUrl = buildDiscoveredSourceUrl(connectorName, token);
    entry.lastDiscoveredAt = now.toISOString();
    entry.decisionReason = "scheduled_coverage";
    entry.promotedAt = entry.promotedAt ?? now.toISOString();
    pushDiscoverySource(entry, {
      type: "scheduled_coverage",
      value: definition.connector.key,
      discoveredAt: now.toISOString(),
    });

    if (!existing) {
      store.entries.push(entry);
      entryMap.set(sourceKey, entry);
    }
  }
}

async function importRipplingRegistry(
  store: DiscoveryStore,
  now: Date,
  ripplingStorePath: string
) {
  let ripplingStore: RipplingStore | null = null;
  try {
    ripplingStore = JSON.parse(await readFile(ripplingStorePath, "utf8")) as RipplingStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const entryMap = new Map(store.entries.map((entry) => [entry.sourceKey, entry]));

  for (const ripplingEntry of ripplingStore.entries ?? []) {
    const sourceKey = buildDiscoveredSourceKey("rippling", ripplingEntry.boardSlug);
    const existing = entryMap.get(sourceKey);
    const entry = existing ?? {
      connectorName: "rippling" as const,
      token: ripplingEntry.boardSlug,
      sourceKey,
      sourceName: buildDiscoveredSourceName("rippling", ripplingEntry.boardSlug),
      boardUrl:
        ripplingEntry.boardUrl ??
        buildDiscoveredSourceUrl("rippling", ripplingEntry.boardSlug),
      status: ripplingEntry.status,
      firstDiscoveredAt: ripplingEntry.firstDiscoveredAt,
      lastDiscoveredAt: ripplingEntry.lastDiscoveredAt,
      discoveredFrom: [],
      decisionReason: ripplingEntry.decisionReason ?? null,
      promotedAt: ripplingEntry.promotedAt ?? null,
      rejectedAt: ripplingEntry.rejectedAt ?? null,
      lastValidatedAt: ripplingEntry.lastValidatedAt,
      validation: ripplingEntry.validation,
    };

    if (
      !existing ||
      existing.status !== "promoted" ||
      ripplingEntry.status === "rejected"
    ) {
      entry.status = existing?.status === "promoted" ? "promoted" : ripplingEntry.status;
      entry.lastValidatedAt = ripplingEntry.lastValidatedAt;
      entry.validation = ripplingEntry.validation;
      entry.decisionReason =
        existing?.status === "promoted" ? existing.decisionReason : ripplingEntry.decisionReason;
      entry.rejectedAt = ripplingEntry.rejectedAt ?? existing?.rejectedAt ?? null;
      entry.promotedAt = existing?.promotedAt ?? ripplingEntry.promotedAt ?? null;
    }

    pushDiscoverySource(entry, {
      type: "rippling_registry_import",
      value: ripplingEntry.boardUrl,
      discoveredAt: ripplingEntry.lastDiscoveredAt ?? now.toISOString(),
    });

    if (!existing) {
      store.entries.push(entry);
      entryMap.set(sourceKey, entry);
    }
  }
}

async function loadInternalDiscoveryInputs(maxInternalPages: number) {
  const [canonicalUrls, mappingUrls] = await Promise.all([
    prisma.jobCanonical.findMany({
      select: {
        applyUrl: true,
      },
    }),
    prisma.jobSourceMapping.findMany({
      where: {
        removedAt: null,
        sourceUrl: {
          not: null,
        },
      },
      select: {
        sourceUrl: true,
      },
    }),
  ]);

  const urls = [...new Set([
    ...canonicalUrls
      .map((job) => job.applyUrl)
      .filter((value): value is string => Boolean(value)),
    ...mappingUrls
      .map((mapping) => mapping.sourceUrl)
      .filter((value): value is string => Boolean(value)),
  ])];

  const unknownHostCounts = new Map<string, number>();
  const candidatePageUrls = new Set<string>();

  for (const url of urls) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }

    const hostname = parsedUrl.hostname.trim().toLowerCase();
    if (isKnownAtsHost(hostname)) continue;

    unknownHostCounts.set(hostname, (unknownHostCounts.get(hostname) ?? 0) + 1);
    candidatePageUrls.add(parsedUrl.origin);
    candidatePageUrls.add(url);
  }

  const topUnknownHosts = [...unknownHostCounts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((left, right) => right.count - left.count);

  return {
    urls,
    pageUrls: [...candidatePageUrls].slice(0, maxInternalPages),
    topUnknownHosts,
  };
}

function annotateSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  sourceMap: Map<
    string,
    Array<{
      type: "url" | "page";
      value: string;
      inputUrl?: string;
      pageUrl?: string;
    }>
  >,
  discoveryType: DiscoverySourceRecord["type"],
  now: Date
) {
  for (const [sourceKey, sourceRecords] of sourceMap.entries()) {
    const entry = entryMap.get(sourceKey);
    if (!entry) continue;

    for (const sourceRecord of sourceRecords) {
      pushDiscoverySource(entry, {
        type: discoveryType,
        value: sourceRecord.value,
        sourcePageUrl: sourceRecord.pageUrl ?? sourceRecord.inputUrl,
        discoveredAt: now.toISOString(),
      });
    }
  }
}

function annotateSearchSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  sourceMap: Map<
    string,
    Array<{
      type: "search_query";
      value: string;
      query: string;
      sourcePageUrl?: string;
    }>
  >,
  now: Date
) {
  for (const [sourceKey, sourceRecords] of sourceMap.entries()) {
    const entry = entryMap.get(sourceKey);
    if (!entry) continue;
    for (const sourceRecord of sourceRecords) {
      pushDiscoverySource(entry, {
        type: "search_query",
        value: sourceRecord.value,
        query: sourceRecord.query,
        sourcePageUrl: sourceRecord.sourcePageUrl,
        discoveredAt: now.toISOString(),
      });
    }
  }
}

function annotateDatasetSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  sourceMap: Map<
    string,
    Array<{
      type: "dataset";
      value: string;
      filePath: string;
    }>
  >,
  now: Date
) {
  for (const [sourceKey, sourceRecords] of sourceMap.entries()) {
    const entry = entryMap.get(sourceKey);
    if (!entry) continue;
    for (const sourceRecord of sourceRecords) {
      pushDiscoverySource(entry, {
        type: "dataset",
        value: sourceRecord.value,
        filePath: sourceRecord.filePath,
        discoveredAt: now.toISOString(),
      });
    }
  }
}

function buildFamilyCounts(entries: DiscoveryStoreEntry[]) {
  const counts: Record<string, { total: number; promoted: number; pending: number; rejected: number }> = {};
  for (const entry of entries) {
    const family = entry.connectorName;
    if (!counts[family]) {
      counts[family] = { total: 0, promoted: 0, pending: 0, rejected: 0 };
    }
    counts[family].total += 1;
    counts[family][entry.status] += 1;
  }
  return counts;
}

function applyPreviewResult(
  entry: DiscoveryStoreEntry | undefined,
  result: SourceDiscoveryPreviewResult,
  now: Date,
  threshold: number
) {
  if (!entry) return;

  const valid =
    !result.error &&
    (result.acceptedCount > 0 || result.existingLiveCanonicalCount > 0);
  const recommendedPromotion =
    valid &&
    (result.previewCreatedCount >= threshold ||
      result.existingLiveCanonicalCount >= threshold);

  entry.lastValidatedAt = now.toISOString();
  entry.validation = {
    valid,
    threshold,
    recommendedPromotion,
    pageTitle: result.pageTitle,
    fetchedCount: result.fetchedCount,
    acceptedCount: result.acceptedCount,
    previewCreatedCount: result.previewCreatedCount,
    previewUpdatedCount: result.previewUpdatedCount,
    dedupedCount: result.dedupedCount,
    rejectedCount: result.rejectedCount,
    existingRawCount: result.existingRawCount,
    existingActiveMappingCount: result.existingActiveMappingCount,
    existingLiveCanonicalCount: result.existingLiveCanonicalCount,
    sampleTitles: result.sampleTitles,
    sampleLocations: result.sampleLocations,
    error: result.error,
  };

  if (entry.status === "promoted") {
    return;
  }

  if (result.error) {
    entry.status = "rejected";
    entry.rejectedAt = now.toISOString();
    entry.promotedAt = null;
    entry.decisionReason = classifyPreviewErrorReason(result.error);
    return;
  }

  if (!valid) {
    entry.status = "rejected";
    entry.rejectedAt = now.toISOString();
    entry.promotedAt = null;
    entry.decisionReason = "no_accepted_jobs";
    return;
  }

  entry.status = "pending";
  entry.rejectedAt = null;
  entry.promotedAt = null;
  entry.decisionReason = recommendedPromotion
    ? "recommended_promotion"
    : "needs_review_below_threshold";
}

function classifyPreviewErrorReason(error: string) {
  const normalizedError = error.trim().toLowerCase();
  if (normalizedError.startsWith("legacy_sap_webdynpro:")) {
    return "legacy_sap_webdynpro";
  }
  if (normalizedError.startsWith("bot_blocked:")) {
    return "bot_blocked";
  }
  if (normalizedError.startsWith("no_structured_listing:")) {
    return "no_structured_listing";
  }
  return "preview_error";
}

function applyExistingSourceStats(
  entry: DiscoveryStoreEntry,
  existingStats: Awaited<ReturnType<typeof getExistingSourceStatsForSourceName>>,
  now: Date,
  threshold: number
) {
  if (entry.status === "promoted") {
    return;
  }

  const valid = existingStats.liveCanonicalCount > 0;
  const recommendedPromotion = existingStats.liveCanonicalCount >= threshold;

  entry.lastValidatedAt = now.toISOString();
  entry.validation = {
    valid,
    threshold,
    recommendedPromotion,
    pageTitle: null,
    fetchedCount: 0,
    acceptedCount: 0,
    previewCreatedCount: 0,
    previewUpdatedCount: 0,
    dedupedCount: 0,
    rejectedCount: 0,
    existingRawCount: existingStats.rawCount,
    existingActiveMappingCount: existingStats.activeMappingCount,
    existingLiveCanonicalCount: existingStats.liveCanonicalCount,
    sampleTitles: [],
    sampleLocations: [],
  };

  if (!valid) {
    entry.status = "rejected";
    entry.rejectedAt = now.toISOString();
    entry.promotedAt = null;
    entry.decisionReason = "existing_source_without_live_jobs";
    return;
  }

  entry.status = "pending";
  entry.rejectedAt = null;
  entry.promotedAt = null;
  entry.decisionReason = recommendedPromotion
    ? "existing_live_source_recommended"
    : "existing_live_source_review";
}

function mergeCandidateSource<
  T extends {
    connectorName: SupportedConnectorName;
    token: string;
    sourceKey: string;
    sourceName: string;
    boardUrl: string;
  },
>(candidate: T) {
  return candidate;
}

function normalizeSourceKey(rawValue: string) {
  const trimmed = rawValue.trim().toLowerCase();
  if (!trimmed) return trimmed;
  if (trimmed.includes(":")) return trimmed;
  return buildDiscoveredSourceKey("rippling", trimmed);
}

function splitConnectorKey(connectorKey: string) {
  const separatorIndex = connectorKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Unexpected connector key format: ${connectorKey}`);
  }

  return [
    connectorKey.slice(0, separatorIndex) as SupportedConnectorName,
    connectorKey.slice(separatorIndex + 1),
  ] as const;
}

function pushDiscoverySource(
  entry: DiscoveryStoreEntry,
  record: DiscoverySourceRecord
) {
  entry.discoveredFrom = entry.discoveredFrom ?? [];

  const existing = entry.discoveredFrom.some(
    (discoveredRecord) =>
      discoveredRecord.type === record.type &&
      discoveredRecord.value === record.value &&
      discoveredRecord.sourcePageUrl === record.sourcePageUrl
  );

  if (!existing) {
    entry.discoveredFrom.push(record);
  }
}

main()
  .catch((error) => {
    console.error("Source discovery failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
