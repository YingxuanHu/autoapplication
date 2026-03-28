/**
 * preflight-enterprise.ts
 *
 * Enterprise source preflight with two discovery channels:
 * 1. Search-first ATS discovery
 * 2. Company-domain career-page ATS extraction
 *
 * Usage:
 *   npx tsx scripts/preflight-enterprise.ts --limit=50
 *   npx tsx scripts/preflight-enterprise.ts --family=workday --limit=50
 *   npx tsx scripts/preflight-enterprise.ts --family=successfactors --limit=25
 *   npx tsx scripts/preflight-enterprise.ts --companies=manulife,scotiabank
 *   npx tsx scripts/preflight-enterprise.ts --discovery=careers
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { previewSourceCandidates } from "../src/lib/ingestion/discovery/sources";
import { discoverEnterpriseSearchCandidates } from "../src/lib/ingestion/discovery/enterprise-search";
import {
  discoverEnterpriseCareerPageCandidates,
  type CareerPageDiscoveryRecord,
} from "../src/lib/ingestion/discovery/career-pages";
import { selectEnterpriseCompanies } from "../src/lib/ingestion/discovery/enterprise-catalog";
import type { SupportedConnectorName } from "../src/lib/ingestion/registry";

type CliArgs = {
  family?: "workday" | "successfactors" | "all";
  discovery?: "search" | "careers" | "all";
  companies?: string;
  out?: string;
  limit: number;
  threshold: number;
  "preview-limit": number;
  "max-search-results": number;
  "no-canada-weight"?: boolean;
  "include-known"?: boolean;
  "retest-search"?: boolean;
  cache?: string;
};

type KnownStatus = "pending" | "rejected" | "promoted";

const rawArgs = parseArgs(process.argv.slice(2));

async function main() {
  const families =
    rawArgs.family === "workday"
      ? ["workday"] as const
      : rawArgs.family === "successfactors"
        ? ["successfactors"] as const
        : (["workday", "successfactors"] as const);

  const discoveryMode = rawArgs.discovery ?? "all";
  const companies = selectEnterpriseCompanies({
    companies: splitArg(rawArgs.companies),
    families: [...families],
    limit: rawArgs.limit,
    canadaWeighted: rawArgs["no-canada-weight"] !== true,
  });
  const knownStatuses = await loadKnownSourceStatuses();

  const searchDiscovery =
    discoveryMode === "careers"
      ? null
      : await discoverEnterpriseSearchCandidates({
          companies: companies.map((company) => company.name),
          families: [...families],
          limitCompanies: rawArgs.limit,
          maxSearchResults: rawArgs["max-search-results"],
          canadaWeighted: rawArgs["no-canada-weight"] !== true,
          includeKnown: rawArgs["include-known"] === true,
          retestSearch: rawArgs["retest-search"] === true,
          cachePath: rawArgs["cache"],
        });

  const careerDiscovery =
    discoveryMode === "search"
      ? null
      : await discoverEnterpriseCareerPageCandidates({
          companies,
          knownStatuses,
        });

  const mergedRecords = mergeRecords(
    searchDiscovery?.records ?? [],
    careerDiscovery?.records ?? []
  );

  const previewResults = await previewSourceCandidates(
    mergedRecords.map((record) => ({
      input: record.boardUrl,
      connectorName: record.connectorName,
      token: record.token,
      sourceKey: record.sourceKey,
      sourceName: buildSourceName(record.connectorName, record.token),
      boardUrl: record.boardUrl,
      source: "token",
    })),
    rawArgs["preview-limit"] ?? 100
  );

  const previewBySourceKey = new Map(
    previewResults.map((result) => [result.sourceKey, result])
  );
  const threshold = rawArgs.threshold ?? 5;
  const enrichedRecords = mergedRecords
    .map((record) => {
      const preview = previewBySourceKey.get(record.sourceKey);
      const recommended =
        (preview?.previewCreatedCount ?? 0) >= threshold &&
        (preview?.acceptedCount ?? 0) > 0;
      return {
        ...record,
        preview: preview
          ? {
              fetchedCount: preview.fetchedCount,
              acceptedCount: preview.acceptedCount,
              previewCreatedCount: preview.previewCreatedCount,
              previewUpdatedCount: preview.previewUpdatedCount,
              dedupedCount: preview.dedupedCount,
              rejectedCount: preview.rejectedCount,
              sampleTitles: preview.sampleTitles,
              sampleLocations: preview.sampleLocations,
            }
          : null,
        recommendedPromotion: recommended,
      };
    })
    .sort((left, right) => {
      const leftCreated = left.preview?.previewCreatedCount ?? 0;
      const rightCreated = right.preview?.previewCreatedCount ?? 0;
      if (rightCreated !== leftCreated) return rightCreated - leftCreated;
      const leftAccepted = left.preview?.acceptedCount ?? 0;
      const rightAccepted = right.preview?.acceptedCount ?? 0;
      if (rightAccepted !== leftAccepted) return rightAccepted - leftAccepted;
      return left.sourceKey.localeCompare(right.sourceKey);
    });

  const outputFile = path.resolve(
    rawArgs.out ?? "data/discovery/seeds/enterprise-preflight-candidates.json"
  );
  const reportPath = outputFile.replace(/\.json$/i, ".report.json");

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(enrichedRecords, null, 2)}\n`, "utf8");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        families,
        discoveryMode,
        limitCompanies: rawArgs.limit,
        previewLimit: rawArgs["preview-limit"] ?? 100,
        threshold,
        searchSummary: searchDiscovery?.summary ?? null,
        careerPageSummary: careerDiscovery?.summary ?? null,
        previewedCount: previewResults.length,
        recommendedPromotions: enrichedRecords
          .filter((record) => record.recommendedPromotion)
          .map((record) => ({
            sourceKey: record.sourceKey,
            companyNames: record.companyNames,
            connectorName: record.connectorName,
            previewCreatedCount: record.preview?.previewCreatedCount ?? 0,
            acceptedCount: record.preview?.acceptedCount ?? 0,
            boardUrl: record.boardUrl,
            matchedReasons: record.matchedReasons,
          })),
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const datasetPath = outputFile.replace(/\.json$/i, ".dataset.json");
  const datasetReportPath = datasetPath.replace(/\.json$/i, ".report.json");
  const datasetSummary = {
    companiesSelected: companies.map((company) => company.name),
    queryCount: searchDiscovery?.summary.queryCount ?? 0,
    cacheHits: searchDiscovery?.summary.cacheHits ?? 0,
    cacheMisses: searchDiscovery?.summary.cacheMisses ?? 0,
    resultUrlsFetched: searchDiscovery?.summary.resultUrlsFetched ?? 0,
    uniqueResultUrls:
      (searchDiscovery?.summary.uniqueResultUrls ?? 0) +
      (careerDiscovery?.summary.initialUrls ?? 0),
    pageUrlsScanned:
      (searchDiscovery?.summary.pageUrlsScanned ?? 0) +
      (careerDiscovery?.summary.pagesFetched ?? 0),
    directSeedUrls: searchDiscovery?.summary.directSeedUrls ?? 0,
    candidatesDiscovered:
      (searchDiscovery?.summary.candidatesDiscovered ?? 0) +
      (careerDiscovery?.summary.candidatesDiscovered ?? 0),
    newCandidates: mergedRecords.length,
    skippedKnownCandidates:
      (searchDiscovery?.summary.skippedKnownCandidates ?? 0) +
      (careerDiscovery?.summary.skippedKnownCandidates ?? 0),
    candidatesByFamily: mergedRecords.reduce<Record<string, number>>((counts, record) => {
      counts[record.connectorName] = (counts[record.connectorName] ?? 0) + 1;
      return counts;
    }, {}),
    queryReports: searchDiscovery?.summary.queryReports ?? [],
  };
  await writeFile(
    datasetPath,
    `${JSON.stringify(
      mergedRecords.map((record) => ({
        ...record,
        url: record.boardUrl,
      })),
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    datasetReportPath,
    `${JSON.stringify(datasetSummary, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        families,
        discoveryMode,
        companyCount: companies.length,
        queryCount: searchDiscovery?.summary.queryCount ?? 0,
        cacheHits: searchDiscovery?.summary.cacheHits ?? 0,
        cacheMisses: searchDiscovery?.summary.cacheMisses ?? 0,
        resultUrlsFetched: searchDiscovery?.summary.resultUrlsFetched ?? 0,
        careerPagesFetched: careerDiscovery?.summary.pagesFetched ?? 0,
        careerPageDirectAtsUrls:
          careerDiscovery?.summary.directAtsUrlsDetected ?? 0,
        candidatesDiscovered:
          (searchDiscovery?.summary.candidatesDiscovered ?? 0) +
          (careerDiscovery?.summary.candidatesDiscovered ?? 0),
        newCandidates: mergedRecords.length,
        skippedKnownCandidates:
          (searchDiscovery?.summary.skippedKnownCandidates ?? 0) +
          (careerDiscovery?.summary.skippedKnownCandidates ?? 0),
        previewedCount: previewResults.length,
        recommendedPromotions: enrichedRecords
          .filter((record) => record.recommendedPromotion)
          .slice(0, 20),
        outputFile,
        reportPath,
        datasetPath,
      },
      null,
      2
    )
  );
}

function parseArgs(args: string[]) {
  const parsed: CliArgs = {
    limit: 50,
    threshold: 5,
    "preview-limit": 100,
    "max-search-results": 5,
    family: "all",
    discovery: "all",
  };

  for (const rawArg of args) {
    const normalizedArg = rawArg.replace(/^--/, "");
    const separatorIndex = normalizedArg.indexOf("=");
    const key =
      separatorIndex === -1
        ? normalizedArg
        : normalizedArg.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? true
        : normalizedArg.slice(separatorIndex + 1);

    if (!key) continue;
    if (
      key === "limit" ||
      key === "threshold" ||
      key === "preview-limit" ||
      key === "max-search-results"
    ) {
      (parsed as Record<string, number | string | boolean | undefined>)[key] =
        Number.parseInt(String(value), 10);
    } else {
      (parsed as Record<string, number | string | boolean | undefined>)[key] = value;
    }
  }

  return parsed;
}

function splitArg(value: string | number | boolean | undefined) {
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function buildSourceName(connectorName: SupportedConnectorName, token: string) {
  switch (connectorName) {
    case "successfactors":
      return `SuccessFactors:${token}`;
    case "workday":
      return `Workday:${token}`;
    case "icims":
      return `iCIMS:${token}`;
    case "smartrecruiters":
      return `SmartRecruiters:${token}`;
    default:
      return `${connectorName.charAt(0).toUpperCase()}${connectorName.slice(1)}:${token}`;
  }
}

async function loadKnownSourceStatuses() {
  const storePath = path.resolve("data/discovery/source-candidates.json");
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

function mergeRecords(
  searchRecords: Array<{
    boardUrl: string;
    sourceKey: string;
    connectorName: SupportedConnectorName;
    token: string;
    companyNames: string[];
    discoveredFromQueries: string[];
    searchResultUrls: string[];
    matchedReasons: string[];
    knownStatus: KnownStatus | null;
  }>,
  careerRecords: CareerPageDiscoveryRecord[]
) {
  const merged = new Map<
    string,
    {
      boardUrl: string;
      sourceKey: string;
      connectorName: SupportedConnectorName;
      token: string;
      companyNames: Set<string>;
      discoveredFromQueries: Set<string>;
      searchResultUrls: Set<string>;
      careerPageUrls: Set<string>;
      directAtsUrls: Set<string>;
      matchedReasons: Set<string>;
      knownStatus: KnownStatus | null;
    }
  >();

  for (const record of searchRecords) {
    const entry = merged.get(record.sourceKey) ?? {
      boardUrl: record.boardUrl,
      sourceKey: record.sourceKey,
      connectorName: record.connectorName,
      token: record.token,
      companyNames: new Set<string>(),
      discoveredFromQueries: new Set<string>(),
      searchResultUrls: new Set<string>(),
      careerPageUrls: new Set<string>(),
      directAtsUrls: new Set<string>(),
      matchedReasons: new Set<string>(),
      knownStatus: record.knownStatus,
    };

    for (const value of record.companyNames) entry.companyNames.add(value);
    for (const value of record.discoveredFromQueries) {
      entry.discoveredFromQueries.add(value);
    }
    for (const value of record.searchResultUrls) entry.searchResultUrls.add(value);
    for (const value of record.matchedReasons) entry.matchedReasons.add(value);
    merged.set(record.sourceKey, entry);
  }

  for (const record of careerRecords) {
    const entry = merged.get(record.sourceKey) ?? {
      boardUrl: record.boardUrl,
      sourceKey: record.sourceKey,
      connectorName: record.connectorName as SupportedConnectorName,
      token: record.token,
      companyNames: new Set<string>(),
      discoveredFromQueries: new Set<string>(),
      searchResultUrls: new Set<string>(),
      careerPageUrls: new Set<string>(),
      directAtsUrls: new Set<string>(),
      matchedReasons: new Set<string>(),
      knownStatus: record.knownStatus,
    };

    for (const value of record.companyNames) entry.companyNames.add(value);
    for (const value of record.careerPageUrls) entry.careerPageUrls.add(value);
    for (const value of record.directAtsUrls) entry.directAtsUrls.add(value);
    for (const value of record.matchedReasons) entry.matchedReasons.add(value);
    merged.set(record.sourceKey, entry);
  }

  return [...merged.values()]
    .filter((record) => rawArgs["include-known"] === true || record.knownStatus === null)
    .map((record) => ({
      boardUrl: record.boardUrl,
      sourceKey: record.sourceKey,
      connectorName: record.connectorName,
      token: record.token,
      companyNames: [...record.companyNames].sort(),
      discoveredFromQueries: [...record.discoveredFromQueries].sort(),
      searchResultUrls: [...record.searchResultUrls].sort(),
      careerPageUrls: [...record.careerPageUrls].sort(),
      directAtsUrls: [...record.directAtsUrls].sort(),
      matchedReasons: [...record.matchedReasons].sort(),
      knownStatus: record.knownStatus,
    }))
    .sort((left, right) => {
      const leftStrength =
        left.companyNames.length +
        left.discoveredFromQueries.length +
        left.careerPageUrls.length;
      const rightStrength =
        right.companyNames.length +
        right.discoveredFromQueries.length +
        right.careerPageUrls.length;
      if (rightStrength !== leftStrength) return rightStrength - leftStrength;
      return left.sourceKey.localeCompare(right.sourceKey);
    });
}

main().catch((error) => {
  console.error("Enterprise preflight failed:", error);
  process.exit(1);
});
