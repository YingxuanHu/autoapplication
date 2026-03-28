/**
 * preflight-enterprise.ts
 *
 * Search-first enterprise source discovery for Workday and SuccessFactors.
 *
 * Usage:
 *   npx tsx scripts/preflight-enterprise.ts --limit=50
 *   npx tsx scripts/preflight-enterprise.ts --family=workday --limit=50
 *   npx tsx scripts/preflight-enterprise.ts --family=successfactors --limit=25
 *   npx tsx scripts/preflight-enterprise.ts --companies=manulife,scotiabank
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { previewSourceCandidates } from "../src/lib/ingestion/discovery/sources";
import {
  discoverEnterpriseSearchCandidates,
  writeEnterpriseDiscoveryDataset,
} from "../src/lib/ingestion/discovery/enterprise-search";

type CliArgs = {
  family?: "workday" | "successfactors" | "all";
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

const rawArgs = parseArgs(process.argv.slice(2));

async function main() {
  const families =
    rawArgs.family === "workday"
      ? ["workday"] as const
      : rawArgs.family === "successfactors"
        ? ["successfactors"] as const
        : (["workday", "successfactors"] as const);

  const discovery = await discoverEnterpriseSearchCandidates({
    companies: splitArg(rawArgs.companies),
    families: [...families],
    limitCompanies: rawArgs.limit,
    maxSearchResults: rawArgs["max-search-results"],
    canadaWeighted: rawArgs["no-canada-weight"] !== true,
    includeKnown: rawArgs["include-known"] === true,
    retestSearch: rawArgs["retest-search"] === true,
    cachePath: rawArgs["cache"],
  });

  const previewResults = await previewSourceCandidates(
    discovery.records.map((record) => ({
      input: record.boardUrl,
      connectorName: record.connectorName,
      token: record.token,
      sourceKey: record.sourceKey,
      sourceName:
        record.connectorName === "successfactors"
          ? `SuccessFactors:${record.token}`
          : `Workday:${record.token}`,
      boardUrl: record.boardUrl,
      source: "token",
    })),
    rawArgs["preview-limit"] ?? 100
  );

  const previewBySourceKey = new Map(
    previewResults.map((result) => [result.sourceKey, result])
  );
  const threshold = rawArgs.threshold ?? 5;
  const enrichedRecords = discovery.records
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
        limitCompanies: rawArgs.limit,
        previewLimit: rawArgs["preview-limit"] ?? 100,
        threshold,
        discoverySummary: discovery.summary,
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
          })),
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeEnterpriseDiscoveryDataset({
    outputPath: outputFile.replace(/\.json$/i, ".dataset.json"),
    records: discovery.records,
    summary: discovery.summary,
  });

  console.log(
    JSON.stringify(
      {
        families,
        companyCount: discovery.summary.companiesSelected.length,
        queryCount: discovery.summary.queryCount,
        cacheHits: discovery.summary.cacheHits,
        cacheMisses: discovery.summary.cacheMisses,
        resultUrlsFetched: discovery.summary.resultUrlsFetched,
        uniqueResultUrls: discovery.summary.uniqueResultUrls,
        candidatesDiscovered: discovery.summary.candidatesDiscovered,
        newCandidates: discovery.summary.newCandidates,
        skippedKnownCandidates: discovery.summary.skippedKnownCandidates,
        previewedCount: previewResults.length,
        recommendedPromotions: enrichedRecords
          .filter((record) => record.recommendedPromotion)
          .slice(0, 20),
        outputFile,
        reportPath,
        datasetPath: outputFile.replace(/\.json$/i, ".dataset.json"),
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

main().catch((error) => {
  console.error("Enterprise preflight failed:", error);
  process.exit(1);
});
