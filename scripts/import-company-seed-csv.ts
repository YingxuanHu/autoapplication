import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { ensureCompanyRecord } from "../src/lib/ingestion/company-records";
import {
  buildCompanyKey,
  cleanCompanyName,
} from "../src/lib/ingestion/discovery/company-corpus";
import {
  buildDiscoveredSourceName,
  discoverSourceCandidatesFromUrls,
  type DiscoveredSourceCandidate,
} from "../src/lib/ingestion/discovery/sources";
import { enqueueUniqueSourceTask } from "../src/lib/ingestion/task-queue";
import type { Prisma } from "../src/generated/prisma/client";

const DEFAULT_SOURCE_POLL_CADENCE_MINUTES = 180;

type CliArgs = {
  file: string;
  dryRun: boolean;
  includeEmptyUrls: boolean;
};

type CsvRow = {
  companyName: string;
  careersUrl: string | null;
  atsVendor: string | null;
  lineNumber: number;
};

type AggregatedCompany = {
  companyName: string;
  companyKey: string;
  careersUrls: Set<string>;
  atsVendors: Set<string>;
  lineNumbers: number[];
};

type ImportSummary = {
  file: string;
  totalRows: number;
  rowsWithUrl: number;
  rowsWithoutUrl: number;
  skippedRows: number;
  uniqueCompanies: number;
  importedCompanies: number;
  updatedCompanies: number;
  atsCompanies: number;
  companySiteCompanies: number;
  atsSourcesCreated: number;
  atsSourcesUpdated: number;
  validationTasksQueued: number;
  discoveryTasksQueued: number;
  unsupportedUrlCompanies: number;
  countsByConnector: Record<string, number>;
  countsByVendor: Record<string, number>;
};

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    file: "/Users/alvinhu/Downloads/job_board_company_seed_10000_tech_finance_na_eu.csv",
    dryRun: false,
    includeEmptyUrls: false,
  };

  for (const arg of argv) {
    const [rawKey, value] = arg.replace(/^--/, "").split("=");
    const key = rawKey.trim();
    if (!key) continue;

    if (key === "file" && value) {
      parsed.file = value;
      continue;
    }

    if (key === "dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (key === "include-empty-urls") {
      parsed.includeEmptyUrls = true;
    }
  }

  return parsed;
}

function parseCsv(content: string, fileLabel: string): CsvRow[] {
  const rows: string[][] = [];
  let field = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      currentRow.push(field);
      field = "";
      if (currentRow.some((value) => value.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    field += char;
  }

  if (field.length > 0 || currentRow.length > 0) {
    currentRow.push(field);
    rows.push(currentRow);
  }

  const [header, ...dataRows] = rows;
  if (!header) return [];

  const normalizedHeader = header.map((value) => value.trim().toLowerCase());
  const companyNameIndex = normalizedHeader.indexOf("company_name");
  const careersUrlIndex = normalizedHeader.indexOf("careers_url");
  const atsVendorIndex = normalizedHeader.indexOf("ats_vendor");

  if (companyNameIndex < 0 || careersUrlIndex < 0 || atsVendorIndex < 0) {
    throw new Error(
      `Unexpected CSV header in ${fileLabel}. Expected company_name, careers_url, ats_vendor.`
    );
  }

  return dataRows.map((row, rowIndex) => ({
    companyName: (row[companyNameIndex] ?? "").trim(),
    careersUrl: normalizeUrl(row[careersUrlIndex] ?? ""),
    atsVendor: normalizeNullableString(row[atsVendorIndex] ?? ""),
    lineNumber: rowIndex + 2,
  }));
}

function normalizeNullableString(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function choosePreferredCareersUrl(urls: string[]) {
  const normalized = [...new Set(urls.map((value) => value.trim()).filter(Boolean))];
  const firstParty = normalized.find((url) => !isKnownThirdPartyHost(url));
  return firstParty ?? normalized[0] ?? null;
}

function isKnownThirdPartyHost(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return [
      "ashbyhq.com",
      "greenhouse.io",
      "lever.co",
      "recruitee.com",
      "rippling.com",
      "smartrecruiters.com",
      "successfactors.com",
      "successfactors.eu",
      "taleo.net",
      "workable.com",
      "myworkdayjobs.com",
      "myworkdaysite.com",
      "jobvite.com",
      "teamtailor.com",
      "icims.com",
      "join.com",
    ].some((hint) => host === hint || host.endsWith(`.${hint}`));
  } catch {
    return false;
  }
}

function mapVendorLabel(label: string | null) {
  if (!label) return null;

  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "direct careers page") return "company-site";
  if (normalized === "ashby") return "ashby";
  if (normalized === "greenhouse") return "greenhouse";
  if (normalized === "lever") return "lever";
  if (normalized === "workday") return "workday";
  if (normalized === "smartrecruiters") return "smartrecruiters";
  if (normalized === "successfactors") return "successfactors";
  if (normalized === "jobvite") return "jobvite";
  if (normalized === "teamtailor") return "teamtailor";
  if (normalized === "rippling") return "rippling";
  if (normalized === "workable") return "workable";
  if (normalized === "recruitee") return "recruitee";
  if (normalized === "icims") return "icims";
  if (normalized === "taleo") return "taleo";
  if (normalized === "join") return "join";

  return normalized;
}

function bumpCounter(record: Record<string, number>, key: string | null) {
  const normalizedKey = key && key.trim().length > 0 ? key : "blank";
  record[normalizedKey] = (record[normalizedKey] ?? 0) + 1;
}

async function upsertAtsSource(input: {
  companyId: string;
  candidate: DiscoveredSourceCandidate;
  careersUrls: string[];
  sourceInputUrls: string[];
  csvVendors: string[];
  now: Date;
}) {
  const existing = await prisma.companySource.findUnique({
    where: { sourceName: input.candidate.sourceName },
    select: { id: true, companyId: true },
  });

  const metadataJson = {
    importSource: "csv-seed",
    importFamily: input.candidate.connectorName,
    csvVendors: input.csvVendors,
    careerPageUrls: input.careersUrls,
    directAtsUrls: input.sourceInputUrls,
  } satisfies Prisma.InputJsonValue;

  const companySource = await prisma.companySource.upsert({
    where: { sourceName: input.candidate.sourceName },
    create: {
      companyId: input.companyId,
      sourceName: input.candidate.sourceName,
      connectorName: input.candidate.connectorName,
      token: input.candidate.token,
      boardUrl: input.candidate.boardUrl,
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType: "ATS",
      extractionRoute: "ATS_NATIVE",
      parserVersion: "csv-import:v1",
      pollingCadenceMinutes: DEFAULT_SOURCE_POLL_CADENCE_MINUTES,
      priorityScore: 0.98,
      sourceQualityScore: 0.82,
      yieldScore: 0.58,
      firstSeenAt: input.now,
      lastProvisionedAt: input.now,
      lastDiscoveryAt: input.now,
      metadataJson,
    },
    update: {
      companyId: input.companyId,
      connectorName: input.candidate.connectorName,
      token: input.candidate.token,
      boardUrl: input.candidate.boardUrl,
      status: "PROVISIONED",
      validationState: "UNVALIDATED",
      pollState: "READY",
      sourceType: "ATS",
      extractionRoute: "ATS_NATIVE",
      parserVersion: "csv-import:v1",
      pollingCadenceMinutes: DEFAULT_SOURCE_POLL_CADENCE_MINUTES,
      priorityScore: Math.max(0.98, 0.9),
      sourceQualityScore: Math.max(0.82, 0.75),
      yieldScore: Math.max(0.58, 0.5),
      lastProvisionedAt: input.now,
      lastDiscoveryAt: input.now,
      lastValidatedAt: null,
      lastHttpStatus: null,
      consecutiveFailures: 0,
      failureStreak: 0,
      validationMessage: null,
      metadataJson,
    },
    select: { id: true },
  });

  await enqueueUniqueSourceTask({
    kind: "SOURCE_VALIDATION",
    companyId: input.companyId,
    companySourceId: companySource.id,
    priorityScore: 96,
    notBeforeAt: input.now,
    payloadJson: {
      origin: "csv_seed_import",
      sourceName: input.candidate.sourceName,
    },
  });

  return {
    created: !existing,
    updated: Boolean(existing),
    queuedValidation: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(args.file);
  const csv = await readFile(filePath, "utf8");
  const rows = parseCsv(csv, path.basename(filePath));
  const now = new Date();

  const summary: ImportSummary = {
    file: filePath,
    totalRows: rows.length,
    rowsWithUrl: 0,
    rowsWithoutUrl: 0,
    skippedRows: 0,
    uniqueCompanies: 0,
    importedCompanies: 0,
    updatedCompanies: 0,
    atsCompanies: 0,
    companySiteCompanies: 0,
    atsSourcesCreated: 0,
    atsSourcesUpdated: 0,
    validationTasksQueued: 0,
    discoveryTasksQueued: 0,
    unsupportedUrlCompanies: 0,
    countsByConnector: {},
    countsByVendor: {},
  };

  const aggregated = new Map<string, AggregatedCompany>();

  for (const row of rows) {
    bumpCounter(summary.countsByVendor, mapVendorLabel(row.atsVendor));

    const cleanedName = cleanCompanyName(row.companyName);
    const companyKey = buildCompanyKey(cleanedName);
    if (!cleanedName || !companyKey) {
      summary.skippedRows += 1;
      continue;
    }

    if (row.careersUrl) {
      summary.rowsWithUrl += 1;
    } else {
      summary.rowsWithoutUrl += 1;
      if (!args.includeEmptyUrls) {
        continue;
      }
    }

    const existing = aggregated.get(companyKey) ?? {
      companyName: cleanedName,
      companyKey,
      careersUrls: new Set<string>(),
      atsVendors: new Set<string>(),
      lineNumbers: [],
    };

    if (cleanedName.length > existing.companyName.length) {
      existing.companyName = cleanedName;
    }

    if (row.careersUrl) {
      existing.careersUrls.add(row.careersUrl);
    }

    if (row.atsVendor) {
      existing.atsVendors.add(row.atsVendor);
    }

    existing.lineNumbers.push(row.lineNumber);
    aggregated.set(companyKey, existing);
  }

  summary.uniqueCompanies = aggregated.size;

  for (const aggregate of aggregated.values()) {
    const careersUrls = [...aggregate.careersUrls];
    const preferredCareersUrl = choosePreferredCareersUrl(careersUrls);
    const discovery = await discoverSourceCandidatesFromUrls(careersUrls);
    const uniqueCandidates = discovery.candidates;
    const connectorNames = Array.from(
      new Set(uniqueCandidates.map((candidate) => candidate.connectorName))
    );

    for (const connectorName of connectorNames) {
      bumpCounter(summary.countsByConnector, connectorName);
    }

    if (uniqueCandidates.length === 0 && careersUrls.length > 0) {
      bumpCounter(summary.countsByConnector, "company-site");
    }

    const companyMetadata = {
      seedSource: "csv-job-board-seed",
      seedFile: path.basename(filePath),
      importedAt: now.toISOString(),
      importLineNumbers: aggregate.lineNumbers,
      sourceCareerUrls: careersUrls,
      seedPageUrls: careersUrls,
      csvVendors: [...aggregate.atsVendors].sort(),
      supportedConnectors: connectorNames,
    } satisfies Record<string, unknown>;

    if (args.dryRun) {
      if (uniqueCandidates.length > 0) {
        summary.atsCompanies += 1;
        summary.validationTasksQueued += uniqueCandidates.length;
      } else if (careersUrls.length > 0) {
        summary.companySiteCompanies += 1;
        summary.discoveryTasksQueued += 1;
        summary.unsupportedUrlCompanies += 1;
      }
      summary.importedCompanies += 1;
      continue;
    }

    const existingCompany = await prisma.company.findUnique({
      where: { companyKey: aggregate.companyKey },
      select: { id: true },
    });

    const company = await ensureCompanyRecord({
      companyName: aggregate.companyName,
      companyKey: aggregate.companyKey,
      urls: careersUrls,
      careersUrl: preferredCareersUrl,
      detectedAts: connectorNames[0] ?? null,
      discoveryStatus: uniqueCandidates.length > 0 ? "DISCOVERED" : "PENDING",
      crawlStatus: "IDLE",
      discoveryConfidence: uniqueCandidates.length > 0 ? 0.94 : careersUrls.length > 0 ? 0.6 : 0.2,
      metadataJson: companyMetadata,
    });

    if (existingCompany) {
      summary.updatedCompanies += 1;
    } else {
      summary.importedCompanies += 1;
    }

    if (uniqueCandidates.length > 0) {
      summary.atsCompanies += 1;
      for (const candidate of uniqueCandidates) {
        const sourceMapEntries = discovery.sourceMap.get(candidate.sourceKey) ?? [];
        const sourceInputUrls = Array.from(
          new Set(sourceMapEntries.map((entry) => entry.value))
        );
        const upserted = await upsertAtsSource({
          companyId: company.id,
          candidate: {
            ...candidate,
            sourceName: buildDiscoveredSourceName(candidate.connectorName, candidate.token),
          },
          careersUrls: sourceMapEntries.length > 0
            ? Array.from(new Set(sourceMapEntries.map((entry) => entry.inputUrl)))
            : careersUrls,
          sourceInputUrls,
          csvVendors: [...aggregate.atsVendors].sort(),
          now,
        });

        if (upserted.created) summary.atsSourcesCreated += 1;
        if (upserted.updated) summary.atsSourcesUpdated += 1;
        if (upserted.queuedValidation) summary.validationTasksQueued += 1;
      }
      continue;
    }

    if (careersUrls.length > 0) {
      summary.companySiteCompanies += 1;
      summary.unsupportedUrlCompanies += 1;
      await enqueueUniqueSourceTask({
        kind: "COMPANY_DISCOVERY",
        companyId: company.id,
        priorityScore: 55,
        notBeforeAt: now,
        payloadJson: {
          origin: "csv_seed_import",
          careersUrl: preferredCareersUrl,
        },
      });
      summary.discoveryTasksQueued += 1;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error("CSV company seed import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
