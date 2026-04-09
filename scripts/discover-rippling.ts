import "dotenv/config";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import {
  discoverRipplingCandidatesFromPageUrls,
  discoverRipplingCandidatesFromSearchQueries,
  discoverRipplingCandidatesFromUrls,
  extractRipplingUrlsFromText,
  extractUrlsFromText,
  normalizeRipplingCandidates,
  previewRipplingCandidates,
  RIPPLING_DISCOVERY_DEFAULT_QUERIES,
  RIPPLING_DISCOVERY_THRESHOLD,
  type RipplingDiscoveryResult,
  type RipplingSourcePageReport,
  type RipplingSearchQueryReport,
} from "../src/lib/ingestion/discovery/rippling";

type DiscoveryStatus = "pending" | "rejected" | "promoted";

type DiscoverySourceRecord = {
  type:
    | "manual_slug"
    | "manual_url"
    | "dataset"
    | "search_query"
    | "external_page"
    | "internal";
  value: string;
  query?: string;
  sourcePageUrl?: string;
  discoveredAt: string;
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
  sampleTitles: string[];
  sampleLocations: string[];
  error?: string;
};

type DiscoveryStoreEntry = {
  boardSlug: string;
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

type DiscoveryStore = {
  updatedAt: string;
  entries: DiscoveryStoreEntry[];
  queryReports: Array<RipplingSearchQueryReport & { searchedAt: string }>;
  pageReports: Array<RipplingSourcePageReport & { fetchedAt: string }>;
};

type DatasetLoadReport = {
  datasetPath: string;
  entryType: "file" | "directory";
  format: "json" | "jsonl" | "csv" | "tsv" | "text";
  recordsScanned: number;
  urlsExtracted: number;
  uniqueUrls: number;
};

const DEFAULT_STORE_PATH = "data/discovery/rippling-slugs.json";
const RIPPLING_DEFAULT_BOARD_TOKENS = [
  "rippling",
  "anaconda",
  "tixr",
  "n3xt-jobs",
  "exacare-inc",
  "inrule",
  "patientnow",
  "vouch-inc",
  "heads-up-technologies",
] as const;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const storePath = path.resolve(args.store ?? DEFAULT_STORE_PATH);
  const store = await loadStore(storePath);
  bootstrapPromotedEntries(store, now);
  const fileEntries = args.file
    ? await loadEntriesFromFile(args.file)
    : { slugs: [], urls: [], sourcePages: [] };
  const datasetInput = args.dataset
    ? await loadDatasetInputs(splitArg(args.dataset))
    : { urls: [], reports: [] };
  const manualSlugCandidates = normalizeRipplingCandidates({
    slugs: [...splitArg(args.slugs), ...fileEntries.slugs],
  });
  const urlDiscovery = await discoverRipplingCandidatesFromUrls([
    ...splitArg(args.urls),
    ...fileEntries.urls,
  ]);
  const datasetDiscovery = await discoverRipplingCandidatesFromUrls(
    datasetInput.urls
  );
  const internalCandidates = normalizeRipplingCandidates({
    urls: await loadInternalRipplingUrls(),
  });
  const sourcePages = [
    ...splitArg(args.sourcePages),
    ...fileEntries.sourcePages,
  ];
  const pageDiscovery = await discoverRipplingCandidatesFromPageUrls(sourcePages);
  const searchQueries = resolveQueries(args.queries, args.query);
  const searchDiscovery =
    args.search === false
      ? { candidates: [], reports: [], sourceMap: new Map() }
      : await discoverRipplingCandidatesFromSearchQueries(searchQueries, {
          maxResultUrlsPerQuery: args.maxSearchResults ?? 8,
        });

  const mergedCandidates = normalizeRipplingCandidates({
    slugs: [
      ...manualSlugCandidates
        .filter((candidate) => candidate.source === "slug")
        .map((candidate) => candidate.boardSlug),
    ],
    urls: [
      ...urlDiscovery.candidates.map((candidate) => candidate.boardUrl),
      ...datasetDiscovery.candidates.map((candidate) => candidate.boardUrl),
      ...internalCandidates.map((candidate) => candidate.boardUrl),
      ...pageDiscovery.candidates.map((candidate) => candidate.boardUrl),
      ...searchDiscovery.candidates.map((candidate) => candidate.boardUrl),
    ],
  });

  if (mergedCandidates.length === 0) {
    throw new Error(
      "No Rippling candidates discovered. Pass --slugs=foo,bar, --urls=https://ats.rippling.com/foo/jobs/... or enable search discovery."
    );
  }

  const entryMap = new Map(store.entries.map((entry) => [entry.boardSlug, entry]));
  const discoveredThisRun = new Set<string>();
  const existingBeforeRun = new Set(store.entries.map((entry) => entry.boardSlug));

  for (const candidate of mergedCandidates) {
    discoveredThisRun.add(candidate.boardSlug);
    const existing = entryMap.get(candidate.boardSlug);
    const entry = existing ?? {
      boardSlug: candidate.boardSlug,
      boardUrl: candidate.boardUrl,
      status: "pending" as const,
      firstDiscoveredAt: now.toISOString(),
      lastDiscoveredAt: now.toISOString(),
      discoveredFrom: [],
      decisionReason: null,
    };

    entry.boardUrl = candidate.boardUrl;
    entry.lastDiscoveredAt = now.toISOString();
    if (!existing) {
      store.entries.push(entry);
      entryMap.set(entry.boardSlug, entry);
    }
  }

  annotateManualSources(entryMap, manualSlugCandidates, now);
  annotateUrlSources(entryMap, urlDiscovery.sourceMap, "manual_url", now);
  annotateUrlSources(entryMap, datasetDiscovery.sourceMap, "dataset", now);
  annotateInternalSources(entryMap, internalCandidates, now);
  annotatePageSources(entryMap, pageDiscovery.sourceMap, now);
  annotateSearchSources(entryMap, searchDiscovery.sourceMap, now);

  const explicitSlugs = new Set([
    ...manualSlugCandidates.map((candidate) => candidate.boardSlug),
    ...urlDiscovery.candidates.map((candidate) => candidate.boardSlug),
  ]);
  const candidateSlugsForValidation = mergedCandidates
    .map((candidate) => candidate.boardSlug)
    .filter((slug, index, items) => items.indexOf(slug) === index)
    .filter((slug) => {
      const entry = entryMap.get(slug);
      if (!entry) return false;
      if (args.retest) return true;
      if (explicitSlugs.has(slug)) return true;
      return entry.status === "pending" || entry.status === undefined;
    });

  const results =
    candidateSlugsForValidation.length === 0
      ? []
      : await previewRipplingCandidates(
          candidateSlugsForValidation.map((slug) => {
            const entry = entryMap.get(slug);
            if (!entry) {
              throw new Error(`Missing discovery entry for ${slug}`);
            }
            return {
              input: entry.boardSlug,
              boardSlug: entry.boardSlug,
              boardUrl: entry.boardUrl,
              source: "slug" as const,
            };
          }),
          args.limit
        );

  const promoteSet = new Set(splitArg(args.promote));
  for (const result of results) {
    applyPreviewResult(entryMap.get(result.boardSlug), result, now, args.threshold);
  }
  for (const slug of promoteSet) {
    const entry = entryMap.get(slug);
    if (!entry) continue;
    entry.status = "promoted";
    entry.promotedAt = now.toISOString();
    entry.decisionReason = "manually_promoted";
  }

  store.queryReports = [
    ...(store.queryReports ?? []),
    ...searchDiscovery.reports.map((report) => ({
      ...report,
      searchedAt: now.toISOString(),
    })),
  ].slice(-200);
  store.pageReports = [
    ...(store.pageReports ?? []),
    ...pageDiscovery.reports.map((report) => ({
      ...report,
      fetchedAt: now.toISOString(),
    })),
  ].slice(-200);
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
  const pendingPromotionCandidates = store.entries
    .filter(
      (entry) =>
        entry.status === "pending" && entry.validation?.recommendedPromotion
    )
    .sort(
      (left, right) =>
        (right.validation?.previewCreatedCount ?? 0) -
        (left.validation?.previewCreatedCount ?? 0)
    );
  const datasetCandidateSlugs = new Set(
    datasetDiscovery.candidates.map((candidate) => candidate.boardSlug)
  );
  const datasetPreviewedSlugs = new Set(
    results
      .filter((result) => datasetCandidateSlugs.has(result.boardSlug))
      .map((result) => result.boardSlug)
  );
  const datasetDiscoveredSlugs = [...datasetCandidateSlugs];
  const datasetKnownSlugs = datasetDiscoveredSlugs.filter((slug) =>
    existingBeforeRun.has(slug)
  );
  const datasetNewSlugs = datasetDiscoveredSlugs.filter(
    (slug) => !existingBeforeRun.has(slug)
  );
  const datasetPendingSlugs = datasetDiscoveredSlugs.filter(
    (slug) => entryMap.get(slug)?.status === "pending"
  );
  const datasetPromotedSlugs = datasetDiscoveredSlugs.filter(
    (slug) => entryMap.get(slug)?.status === "promoted"
  );
  const datasetRejectedSlugs = datasetDiscoveredSlugs.filter(
    (slug) => entryMap.get(slug)?.status === "rejected"
  );

  console.log(
    JSON.stringify(
      {
        storePath,
        threshold: args.threshold,
        discoveredCandidateCount: mergedCandidates.length,
        discoveredThisRun: discoveredThisRun.size,
        validatedThisRun: results.length,
        limit: args.limit ?? null,
        searchQueries,
        searchReports: searchDiscovery.reports,
        datasetReports: datasetInput.reports,
        datasetSummary: {
          datasetsScanned: datasetInput.reports.length,
          urlsScanned: datasetInput.urls.length,
          ripplingUrlsFound: datasetDiscovery.reports.reduce(
            (sum, report) => sum + report.ripplingUrlsDiscovered,
            0
          ),
          slugsExtracted: datasetDiscoveredSlugs.length,
          newSlugs: datasetNewSlugs.length,
          alreadyKnownSlugs: datasetKnownSlugs.length,
          previewedSlugs: datasetPreviewedSlugs.size,
          skippedKnownSlugs:
            datasetDiscoveredSlugs.length - datasetPreviewedSlugs.size,
          pendingSlugs: datasetPendingSlugs.length,
          promotedSlugs: datasetPromotedSlugs.length,
          rejectedSlugs: datasetRejectedSlugs.length,
        },
        statusCounts,
        pendingPromotionCandidates: pendingPromotionCandidates.map((entry) => ({
          boardSlug: entry.boardSlug,
          boardUrl: entry.boardUrl,
          previewCreatedCount: entry.validation?.previewCreatedCount ?? 0,
          acceptedCount: entry.validation?.acceptedCount ?? 0,
          sampleTitles: entry.validation?.sampleTitles ?? [],
        })),
        newDiscoveriesBySource: {
          internal: countNewDiscoveriesBySource(
            entryMap,
            existingBeforeRun,
            "internal"
          ),
          dataset: countNewDiscoveriesBySource(
            entryMap,
            existingBeforeRun,
            "dataset"
          ),
          manualUrl: countNewDiscoveriesBySource(
            entryMap,
            existingBeforeRun,
            "manual_url"
          ),
          externalPage: countNewDiscoveriesBySource(
            entryMap,
            existingBeforeRun,
            "external_page"
          ),
          searchQuery: countNewDiscoveriesBySource(
            entryMap,
            existingBeforeRun,
            "search_query"
          ),
        },
        promotedBoards: store.entries
          .filter((entry) => entry.status === "promoted")
          .map((entry) => entry.boardSlug),
        previewCreatedCountsBySlug: Object.fromEntries(
          results.map((result) => [result.boardSlug, result.previewCreatedCount])
        ),
        results,
      },
      null,
      2
    )
  );
}

function parseArgs(rawArgs: string[]) {
  const parsedArgs: {
    file?: string;
    dataset?: string;
    slugs?: string;
    urls?: string;
    limit?: number;
    store?: string;
    query?: string;
    queries?: string;
    sourcePages?: string;
    threshold: number;
    promote?: string;
    retest?: boolean;
    search?: boolean;
    maxSearchResults?: number;
  } = {
    threshold: RIPPLING_DISCOVERY_THRESHOLD,
    search: true,
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

    if (key === "no-search") {
      parsedArgs.search = false;
      continue;
    }

    if (value === undefined) continue;

    if (key === "file") parsedArgs.file = value;
    if (key === "dataset") parsedArgs.dataset = value;
    if (key === "slugs") parsedArgs.slugs = value;
    if (key === "urls") parsedArgs.urls = value;
    if (key === "source-pages") parsedArgs.sourcePages = value;
    if (key === "limit") parsedArgs.limit = Number.parseInt(value, 10);
    if (key === "store") parsedArgs.store = value;
    if (key === "query") parsedArgs.query = value;
    if (key === "queries") parsedArgs.queries = value;
    if (key === "threshold") parsedArgs.threshold = Number.parseInt(value, 10);
    if (key === "promote") parsedArgs.promote = value;
    if (key === "max-search-results") {
      parsedArgs.maxSearchResults = Number.parseInt(value, 10);
    }
  }

  if (
    parsedArgs.limit !== undefined &&
    Number.isNaN(parsedArgs.limit)
  ) {
    throw new Error(`Invalid --limit value "${String(parsedArgs.limit)}"`);
  }
  if (Number.isNaN(parsedArgs.threshold)) {
    throw new Error(`Invalid --threshold value "${String(parsedArgs.threshold)}"`);
  }
  if (
    parsedArgs.maxSearchResults !== undefined &&
    Number.isNaN(parsedArgs.maxSearchResults)
  ) {
    throw new Error(
      `Invalid --max-search-results value "${String(parsedArgs.maxSearchResults)}"`
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

async function loadEntriesFromFile(filePath: string) {
  const content = await readFile(filePath, "utf8");
  const entries = content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    slugs: entries.filter((entry) => !entry.startsWith("http")),
    urls: entries.filter(
      (entry) =>
        entry.startsWith("http") && entry.includes("ats.rippling.com/")
    ),
    sourcePages: entries.filter(
      (entry) =>
        entry.startsWith("http") && !entry.includes("ats.rippling.com/")
    ),
  };
}

async function loadDatasetInputs(filePaths: string[]) {
  const urls = new Set<string>();
  const reports: DatasetLoadReport[] = [];

  for (const entryPath of filePaths) {
    for (const filePath of await resolveDatasetFiles(entryPath)) {
      const report = await loadDatasetInput(filePath);
      reports.push(report.report);
      for (const url of report.urls) {
        urls.add(url);
      }
    }
  }

  return {
    urls: [...urls],
    reports,
  };
}

async function loadDatasetInput(filePath: string) {
  const content = await readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const extractedUrls: string[] = [];
  let recordsScanned = 0;
  let format: DatasetLoadReport["format"] = "text";

  if (ext === ".json") {
    format = "json";
    const parsed = JSON.parse(content);
    recordsScanned = estimateRecordCount(parsed);
    collectUrlsFromUnknown(parsed, extractedUrls);
  } else if (ext === ".jsonl") {
    format = "jsonl";
    const lines = content.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    recordsScanned = lines.length;
    for (const line of lines) {
      collectUrlsFromUnknown(JSON.parse(line), extractedUrls);
    }
  } else if (ext === ".csv" || ext === ".tsv") {
    format = ext === ".tsv" ? "tsv" : "csv";
    const delimiter = ext === ".tsv" ? "\t" : ",";
    const lines = content.split(/\r?\n/).filter(Boolean);
    recordsScanned = lines.length;
    for (const line of lines) {
      for (const cell of line.split(delimiter)) {
        extractedUrls.push(...extractUrlsFromText(cell));
      }
    }
  } else {
    format = "text";
    const lines = content.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    recordsScanned = lines.length;
    extractedUrls.push(...extractUrlsFromText(content));
  }

  const uniqueUrls = [...new Set(extractedUrls)];

  return {
    urls: uniqueUrls,
    report: {
      datasetPath: filePath,
      entryType: "file",
      format,
      recordsScanned,
      urlsExtracted: extractedUrls.length,
      uniqueUrls: uniqueUrls.length,
    } satisfies DatasetLoadReport,
  };
}

async function resolveDatasetFiles(entryPath: string) {
  const resolvedPath = path.resolve(entryPath);
  const fileStat = await stat(resolvedPath);

  if (!fileStat.isDirectory()) {
    return [resolvedPath];
  }

  const files: string[] = [];
  await collectDatasetFiles(resolvedPath, files);
  return files.sort();
}

async function collectDatasetFiles(directoryPath: string, files: string[]) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await collectDatasetFiles(absolutePath, files);
      continue;
    }

    if (isSupportedDatasetFile(absolutePath)) {
      files.push(absolutePath);
    }
  }
}

function isSupportedDatasetFile(filePath: string) {
  return [".json", ".jsonl", ".csv", ".tsv", ".txt"].includes(
    path.extname(filePath).toLowerCase()
  );
}

async function loadStore(storePath: string): Promise<DiscoveryStore> {
  try {
    const content = await readFile(storePath, "utf8");
    return JSON.parse(content) as DiscoveryStore;
  } catch {
    return {
      updatedAt: new Date(0).toISOString(),
      entries: [],
      queryReports: [],
      pageReports: [],
    };
  }
}

async function saveStore(storePath: string, store: DiscoveryStore) {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}

function bootstrapPromotedEntries(store: DiscoveryStore, now: Date) {
  const entryMap = new Map(store.entries.map((entry) => [entry.boardSlug, entry]));

  for (const boardSlug of RIPPLING_DEFAULT_BOARD_TOKENS) {
    const entry =
      entryMap.get(boardSlug) ??
      ({
        boardSlug,
        boardUrl: `https://ats.rippling.com/${boardSlug}/jobs`,
        status: "promoted",
        firstDiscoveredAt: now.toISOString(),
        lastDiscoveredAt: now.toISOString(),
        discoveredFrom: [],
        decisionReason: "scheduled_default_coverage",
        promotedAt: now.toISOString(),
      } satisfies DiscoveryStoreEntry);

    entry.status = "promoted";
    entry.decisionReason = entry.decisionReason ?? "scheduled_default_coverage";
    entry.promotedAt = entry.promotedAt ?? now.toISOString();

    if (!entryMap.has(boardSlug)) {
      store.entries.push(entry);
      entryMap.set(boardSlug, entry);
    }
  }
}

function annotateManualSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  candidates: ReturnType<typeof normalizeRipplingCandidates>,
  now: Date
) {
  for (const candidate of candidates) {
    const entry = entryMap.get(candidate.boardSlug);
    if (!entry) continue;
    appendSource(entry, {
      type: candidate.source === "url" ? "manual_url" : "manual_slug",
      value: candidate.input,
      discoveredAt: now.toISOString(),
    });
  }
}

function annotateUrlSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  sourceMap: Map<
    string,
    Array<{
      type: "url";
      value: string;
      inputUrl: string;
    }>
  >,
  sourceType: "manual_url" | "dataset",
  now: Date
) {
  for (const [slug, sources] of sourceMap.entries()) {
    const entry = entryMap.get(slug);
    if (!entry) continue;
    for (const source of sources) {
      appendSource(entry, {
        type: sourceType,
        value: source.value,
        sourcePageUrl: source.inputUrl,
        discoveredAt: now.toISOString(),
      });
    }
  }
}

function annotateInternalSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  candidates: ReturnType<typeof normalizeRipplingCandidates>,
  now: Date
) {
  for (const candidate of candidates) {
    const entry = entryMap.get(candidate.boardSlug);
    if (!entry) continue;
    appendSource(entry, {
      type: "internal",
      value: candidate.boardUrl,
      discoveredAt: now.toISOString(),
    });
  }
}

function annotatePageSources(
  entryMap: Map<string, DiscoveryStoreEntry>,
  sourceMap: Map<
    string,
    Array<{
      type: "external_page";
      value: string;
      pageUrl: string;
    }>
  >,
  now: Date
) {
  for (const [slug, sources] of sourceMap.entries()) {
    const entry = entryMap.get(slug);
    if (!entry) continue;
    for (const source of sources) {
      appendSource(entry, {
        type: "external_page",
        value: source.value,
        sourcePageUrl: source.pageUrl,
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
      query: string;
      value: string;
      sourcePageUrl?: string;
    }>
  >,
  now: Date
) {
  for (const [slug, sources] of sourceMap.entries()) {
    const entry = entryMap.get(slug);
    if (!entry) continue;
    for (const source of sources) {
      appendSource(entry, {
        type: "search_query",
        value: source.value,
        query: source.query,
        sourcePageUrl: source.sourcePageUrl,
        discoveredAt: now.toISOString(),
      });
    }
  }
}

function appendSource(entry: DiscoveryStoreEntry, source: DiscoverySourceRecord) {
  const exists = entry.discoveredFrom.some(
    (existing) =>
      existing.type === source.type &&
      existing.value === source.value &&
      existing.query === source.query &&
      existing.sourcePageUrl === source.sourcePageUrl
  );
  if (!exists) {
    entry.discoveredFrom.push(source);
  }
}

function countNewDiscoveriesBySource(
  entryMap: Map<string, DiscoveryStoreEntry>,
  existingBeforeRun: Set<string>,
  sourceType: DiscoverySourceRecord["type"]
) {
  let count = 0;
  for (const [slug, entry] of entryMap.entries()) {
    if (existingBeforeRun.has(slug)) continue;
    if (entry.discoveredFrom.some((source) => source.type === sourceType)) {
      count += 1;
    }
  }
  return count;
}

function applyPreviewResult(
  entry: DiscoveryStoreEntry | undefined,
  result: RipplingDiscoveryResult,
  now: Date,
  threshold: number
) {
  if (!entry) return;

  const valid =
    !result.error &&
    result.fetchedCount > 0 &&
    result.acceptedCount > 0;
  const recommendedPromotion =
    valid && result.previewCreatedCount >= threshold;

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
    sampleTitles: result.sampleTitles,
    sampleLocations: result.sampleLocations,
    error: result.error,
  };

  if (entry.status === "promoted") {
    return;
  }

  if (recommendedPromotion) {
    entry.status = "pending";
    entry.decisionReason = "meets_preview_threshold";
    entry.rejectedAt = null;
    return;
  }

  entry.status = "rejected";
  entry.rejectedAt = now.toISOString();
  if (result.error) {
    entry.decisionReason = "preview_error";
  } else if (result.fetchedCount === 0) {
    entry.decisionReason = "empty_board";
  } else if (result.acceptedCount === 0) {
    entry.decisionReason = "no_accepted_jobs";
  } else {
    entry.decisionReason = "below_threshold";
  }
}

function resolveQueries(rawQueries: string | undefined, rawQuery: string | undefined) {
  const explicit = splitArg(rawQueries);
  if (rawQuery?.trim()) {
    explicit.push(rawQuery.trim());
  }

  return explicit.length > 0
    ? explicit
    : [...RIPPLING_DISCOVERY_DEFAULT_QUERIES];
}

function collectUrlsFromUnknown(input: unknown, urls: string[]) {
  if (typeof input === "string") {
    for (const url of extractUrlsFromText(input)) {
      urls.push(url);
    }
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      collectUrlsFromUnknown(item, urls);
    }
    return;
  }

  if (input && typeof input === "object") {
    for (const value of Object.values(input)) {
      collectUrlsFromUnknown(value, urls);
    }
  }
}

function estimateRecordCount(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  if (input && typeof input === "object") return 1;
  return 1;
}

async function loadInternalRipplingUrls() {
  const [sourceMappings, canonicalJobs, rawJobs] = await Promise.all([
    prisma.jobSourceMapping.findMany({
      where: {
        sourceUrl: { contains: "ats.rippling.com" },
      },
      select: { sourceUrl: true },
    }),
    prisma.jobCanonical.findMany({
      where: {
        applyUrl: { contains: "ats.rippling.com" },
      },
      select: { applyUrl: true },
    }),
    prisma.jobRaw.findMany({
      select: {
        rawPayload: true,
      },
    }),
  ]);

  const urls = new Set<string>();
  for (const mapping of sourceMappings) {
    if (mapping.sourceUrl) {
      urls.add(mapping.sourceUrl);
    }
  }
  for (const job of canonicalJobs) {
    if (job.applyUrl) urls.add(job.applyUrl);
  }
  for (const rawJob of rawJobs) {
    const rawText = JSON.stringify(rawJob.rawPayload);
    for (const url of extractRipplingUrlsFromText(rawText)) {
      urls.add(url);
    }
  }

  return [...urls];
}

main()
  .catch((error) => {
    console.error("Rippling discovery failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
