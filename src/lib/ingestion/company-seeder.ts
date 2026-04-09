import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ensureCompanyRecord, assignCanonicalJobsToCompany } from "@/lib/ingestion/company-records";
import {
  buildDiscoveredSourceUrl,
  type DiscoveredSourceCandidate,
} from "@/lib/ingestion/discovery/sources";

type CanonicalCompanySeedRow = {
  companyKey: string;
  companyName: string;
  sampleApplyUrl: string | null;
  sampleSourceUrl: string | null;
  totalJobs: number;
  liveJobs: number;
};

type AtsSourceSeedRow = {
  sourceName: string;
  companyKey: string;
  companyName: string;
  sampleUrl: string | null;
  occurrenceCount: number;
  liveJobs: number;
};

const ATS_PREFIX_TO_CONNECTOR: Record<string, DiscoveredSourceCandidate["connectorName"]> = {
  Ashby: "ashby",
  Greenhouse: "greenhouse",
  Lever: "lever",
  Recruitee: "recruitee",
  Rippling: "rippling",
  SuccessFactors: "successfactors",
  SmartRecruiters: "smartrecruiters",
  Workday: "workday",
  Workable: "workable",
  iCIMS: "icims",
  Taleo: "taleo",
};

export async function seedCompaniesFromCanonicalInventory(options: {
  limit?: number;
  includeHistorical?: boolean;
} = {}) {
  const limit = Math.max(100, options.limit ?? 5_000);
  const includeHistorical = options.includeHistorical ?? true;

  const rows = (await prisma.$queryRaw`
    WITH grouped AS (
      SELECT
        j."companyKey" AS "companyKey",
        j.company AS "companyName",
        COUNT(*)::int AS "totalJobs",
        COUNT(*) FILTER (WHERE j.status IN ('LIVE', 'AGING', 'STALE'))::int AS "liveJobs",
        MAX(NULLIF(j."applyUrl", '')) AS "sampleApplyUrl",
        MAX(NULLIF(m."sourceUrl", '')) AS "sampleSourceUrl",
        ROW_NUMBER() OVER (
          PARTITION BY j."companyKey"
          ORDER BY COUNT(*) DESC, j.company
        ) AS rank
      FROM "JobCanonical" j
      LEFT JOIN "JobSourceMapping" m
        ON m."canonicalJobId" = j.id
       AND m."removedAt" IS NULL
      WHERE j."companyKey" <> ''
        AND (${includeHistorical} OR j.status IN ('LIVE', 'AGING', 'STALE'))
      GROUP BY 1, 2
    )
    SELECT
      g."companyKey",
      g."companyName",
      g."sampleApplyUrl",
      g."sampleSourceUrl",
      g."totalJobs",
      g."liveJobs"
    FROM grouped g
    LEFT JOIN "Company" c
      ON c."companyKey" = g."companyKey"
    WHERE g.rank = 1
      AND c.id IS NULL
    ORDER BY g."liveJobs" DESC, g."totalJobs" DESC, g."companyKey"
    LIMIT ${limit}
  `) as CanonicalCompanySeedRow[];

  let seededCount = 0;

  for (const row of rows) {
    const company = await ensureCompanyRecord({
      companyName: row.companyName,
      companyKey: row.companyKey,
      urls: [row.sampleApplyUrl, row.sampleSourceUrl],
      careersUrl: chooseCareerSeedUrl(row.sampleSourceUrl, row.sampleApplyUrl),
      discoveryStatus: "PENDING",
      crawlStatus: "IDLE",
      discoveryConfidence: computeInventorySeedConfidence(row.liveJobs, row.totalJobs),
      metadataJson: {
        seedSource: "canonical-inventory",
        totalJobs: row.totalJobs,
        liveJobs: row.liveJobs,
      },
    });

    await assignCanonicalJobsToCompany(company.id, row.companyKey);
    seededCount += 1;
  }

  return {
    seededCount,
    scannedCount: rows.length,
  };
}

export async function seedCompanySourcesFromExistingAts(options: {
  limit?: number;
} = {}) {
  const limit = Math.max(100, options.limit ?? 1_500);
  const families = Object.keys(ATS_PREFIX_TO_CONNECTOR);

  const rows = (await prisma.$queryRaw`
    WITH ranked AS (
      SELECT
        m."sourceName" AS "sourceName",
        j."companyKey" AS "companyKey",
        MAX(j.company) AS "companyName",
        COUNT(*)::int AS "occurrenceCount",
        COUNT(*) FILTER (WHERE j.status IN ('LIVE', 'AGING'))::int AS "liveJobs",
        MAX(COALESCE(NULLIF(m."sourceUrl", ''), NULLIF(j."applyUrl", ''))) AS "sampleUrl",
        ROW_NUMBER() OVER (
          PARTITION BY m."sourceName"
          ORDER BY COUNT(*) DESC, MAX(j."companyKey")
        ) AS rank
      FROM "JobSourceMapping" m
      JOIN "JobCanonical" j
        ON j.id = m."canonicalJobId"
      WHERE m."removedAt" IS NULL
        AND j."companyKey" <> ''
        AND split_part(m."sourceName", ':', 1) = ANY(${families})
      GROUP BY 1, 2
    )
    SELECT
      r."sourceName",
      r."companyKey",
      r."companyName",
      r."sampleUrl",
      r."occurrenceCount",
      r."liveJobs"
    FROM ranked r
    WHERE r.rank = 1
    ORDER BY r."liveJobs" DESC, r."occurrenceCount" DESC
    LIMIT ${limit}
  `) as AtsSourceSeedRow[];

  let companySeededCount = 0;
  let sourceProvisionedCount = 0;

  for (const row of rows) {
    const parsed = parseConnectorFromSourceName(row.sourceName);
    if (!parsed) continue;

    const company = await ensureCompanyRecord({
      companyName: row.companyName,
      companyKey: row.companyKey,
      urls: [row.sampleUrl],
      careersUrl: row.sampleUrl,
      detectedAts: parsed.connectorName,
      discoveryStatus: "DISCOVERED",
      crawlStatus: "IDLE",
      discoveryConfidence: 0.98,
      metadataJson: {
        seedSource: "existing-ats-source",
        sourceName: row.sourceName,
        sourceOccurrenceCount: row.occurrenceCount,
        sourceLiveJobs: row.liveJobs,
      },
    });

    await assignCanonicalJobsToCompany(company.id, row.companyKey);
    companySeededCount += 1;

    await prisma.companySource.upsert({
      where: { sourceName: row.sourceName },
      create: {
        companyId: company.id,
        sourceName: row.sourceName,
        connectorName: parsed.connectorName,
        token: parsed.token,
        boardUrl:
          row.sampleUrl ??
          buildDiscoveredSourceUrl(parsed.connectorName, parsed.token),
        status: "ACTIVE",
        validationState: "VALIDATED",
        pollState: "READY",
        sourceType: "ATS",
        extractionRoute: "ATS_NATIVE",
        parserVersion: "reverse-seed:v1",
        pollingCadenceMinutes: 180,
        priorityScore: Math.min(1.5, 1 + row.liveJobs / 50),
        sourceQualityScore: 0.95,
        yieldScore: 0.85,
        firstSeenAt: new Date(),
        lastProvisionedAt: new Date(),
        lastDiscoveryAt: new Date(),
        lastValidatedAt: new Date(),
        lastSuccessfulPollAt: new Date(),
        metadataJson: {
          seedSource: "existing-ats-source",
          sampleUrl: row.sampleUrl,
          sourceOccurrenceCount: row.occurrenceCount,
          sourceLiveJobs: row.liveJobs,
        } as Prisma.InputJsonValue,
      },
      update: {
        companyId: company.id,
        connectorName: parsed.connectorName,
        token: parsed.token,
        boardUrl:
          row.sampleUrl ??
          buildDiscoveredSourceUrl(parsed.connectorName, parsed.token),
        status: "ACTIVE",
        validationState: "VALIDATED",
        pollState: "READY",
        sourceType: "ATS",
        extractionRoute: "ATS_NATIVE",
        parserVersion: "reverse-seed:v1",
        pollingCadenceMinutes: 180,
        priorityScore: Math.min(1.5, 1 + row.liveJobs / 50),
        sourceQualityScore: 0.95,
        yieldScore: 0.85,
        lastValidatedAt: new Date(),
        lastSuccessfulPollAt: new Date(),
        lastHttpStatus: 200,
        consecutiveFailures: 0,
        failureStreak: 0,
        validationMessage: null,
        metadataJson: {
          seedSource: "existing-ats-source",
          sampleUrl: row.sampleUrl,
          sourceOccurrenceCount: row.occurrenceCount,
          sourceLiveJobs: row.liveJobs,
        } as Prisma.InputJsonValue,
      },
    });

    sourceProvisionedCount += 1;
  }

  return {
    companySeededCount,
    sourceProvisionedCount,
    scannedCount: rows.length,
  };
}

function chooseCareerSeedUrl(...urls: Array<string | null | undefined>) {
  for (const url of urls) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (/(careers?|jobs?|join-us|work-with-us)/i.test(parsed.pathname)) {
        return url;
      }
    } catch {
      continue;
    }
  }

  return urls.find(Boolean) ?? null;
}

function computeInventorySeedConfidence(liveJobs: number, totalJobs: number) {
  const liveWeight = Math.min(0.4, liveJobs / 100);
  const historicalWeight = Math.min(0.2, totalJobs / 500);
  return Math.min(0.85, 0.3 + liveWeight + historicalWeight);
}

function parseConnectorFromSourceName(sourceName: string) {
  const separatorIndex = sourceName.indexOf(":");
  if (separatorIndex <= 0) return null;

  const prefix = sourceName.slice(0, separatorIndex);
  const token = sourceName.slice(separatorIndex + 1).trim();
  const connectorName = ATS_PREFIX_TO_CONNECTOR[prefix];

  if (!connectorName || !token) return null;

  return {
    connectorName,
    token,
  };
}
