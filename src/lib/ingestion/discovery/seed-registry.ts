import { prisma } from "@/lib/db";
import { detectAtsTenantFromUrl } from "@/lib/ingestion/discovery/ats-tenant-detector";
import { ENTERPRISE_DISCOVERY_COMPANIES } from "@/lib/ingestion/discovery/enterprise-catalog";
import {
  discoverSourceCandidatesFromPageUrls,
  isKnownAtsHost,
} from "@/lib/ingestion/discovery/sources";
import { normalizeUrlIdentityKey } from "@/lib/ingestion/source-quality";
import {
  registerSourceCandidate,
} from "@/lib/ingestion/discovery/source-registry";
import type {
  DiscoveryMode,
  SourceCandidateStatus,
  SourceCandidateType,
} from "@/generated/prisma/client";

const CAREER_PATH_RE =
  /\/(?:careers?|jobs?|join(?:-us)?|work-with-us|opportunit(?:y|ies)|open(?:-| )?(?:roles?|positions?|jobs?))/i;
const JOB_DETAIL_PATH_RE =
  /\/(?:job|jobs|career|careers|position|positions|vacancy|vacancies|posting|openings?)\/[^/?#]{4,}/i;
const SITEMAP_RE = /(?:^|\/)(?:sitemap|job-sitemap)[^/]*\.xml$/i;
const AGGREGATOR_HOST_RE =
  /(?:^|\.)?(?:adzuna\.(?:com|ca)|jooble\.org|remoteok\.com|remotive\.com|jobicy\.com|themuse\.com|himalayas\.app|usajobs\.gov|jobbank\.gc\.ca|weworkremotely\.com)$/i;
const COMPANY_SITE_ROUTE_HINTS = [
  "/careers",
  "/jobs",
  "/careers/jobs",
  "/careers/openings",
  "/join-us",
  "/company/careers",
  "/about/careers",
];

type SeedRegistryOptions = {
  discoveryMode?: DiscoveryMode;
  existingSourceLimit?: number;
  urlSeedLimit?: number;
  companySeedLimit?: number;
  companyPageScanLimit?: number;
  enterpriseSeedLimit?: number;
  pageDiscoveryConcurrency?: number;
};

type SeedRegistryStats = {
  existingPromotedCandidates: number;
  liveUrlCandidates: number;
  companySignalCandidates: number;
  discoveredPageCandidates: number;
  enterpriseCandidates: number;
  enterprisePageCandidates: number;
  atsTenantsLinked: number;
  promotedStatusCandidates: number;
  newStatusCandidates: number;
  rejectedUrls: number;
};

type ExistingSourceIndex = {
  atsKeys: Set<string>;
  companySiteCompanyIds: Set<string>;
  companySiteUrlKeys: Set<string>;
};

type UrlSeedRow = {
  url: string;
  companyName: string | null;
  candidateType: SourceCandidateType;
  score: number;
  metadataJson?: Record<string, string | number | boolean | null>;
};

function safeUrl(input: string | null | undefined) {
  if (!input) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function normalizedHost(input: string | null | undefined) {
  const parsed = safeUrl(input);
  return parsed?.hostname.replace(/^www\./i, "").toLowerCase() ?? null;
}

function isAggregatorHost(input: string | null | undefined) {
  const host = normalizedHost(input);
  return host ? AGGREGATOR_HOST_RE.test(host) : false;
}

function deriveCandidateType(input: string): SourceCandidateType | null {
  const parsed = safeUrl(input);
  if (!parsed) return null;
  if (!/^https?:$/i.test(parsed.protocol)) return null;
  if (SITEMAP_RE.test(parsed.pathname)) return "SITEMAP";
  if (isKnownAtsHost(parsed.hostname.replace(/^www\./i, "").toLowerCase())) return "ATS_BOARD";
  if (JOB_DETAIL_PATH_RE.test(parsed.pathname)) return "JOB_PAGE";
  if (!parsed.pathname || parsed.pathname === "/") return "COMPANY_ROOT";
  if (CAREER_PATH_RE.test(parsed.pathname)) return "CAREER_PAGE";
  return "CAREER_PAGE";
}

function buildCompanySiteSeedUrls(domain: string | null, careersUrl: string | null) {
  const urls = new Set<string>();
  if (careersUrl) {
    urls.add(careersUrl);
  }
  if (domain) {
    const normalizedDomain = domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    for (const path of COMPANY_SITE_ROUTE_HINTS) {
      urls.add(`https://${normalizedDomain}${path}`);
    }
  }
  return [...urls];
}

function buildAtsKey(connectorName: string, token: string) {
  return `${connectorName.trim().toLowerCase()}:${token.trim().toLowerCase()}`;
}

async function buildExistingSourceIndex(): Promise<ExistingSourceIndex> {
  const sources = await prisma.companySource.findMany({
    select: {
      companyId: true,
      connectorName: true,
      token: true,
      boardUrl: true,
      status: true,
    },
  });

  const atsKeys = new Set<string>();
  const companySiteCompanyIds = new Set<string>();
  const companySiteUrlKeys = new Set<string>();

  for (const source of sources) {
    if (source.connectorName === "company-site") {
      companySiteCompanyIds.add(source.companyId);
      const urlKey = normalizeUrlIdentityKey(source.boardUrl);
      if (urlKey) companySiteUrlKeys.add(urlKey);
      continue;
    }

    atsKeys.add(buildAtsKey(source.connectorName, source.token));
  }

  return {
    atsKeys,
    companySiteCompanyIds,
    companySiteUrlKeys,
  };
}

async function registerSeedCandidate(
  input: {
    candidateUrl: string;
    candidateType: SourceCandidateType;
    companyId?: string | null;
    companyNameHint?: string | null;
    confidence: number;
    noveltyScore: number;
    coverageGapScore: number;
    potentialYieldScore: number;
    sourceQualityScore: number;
    metadataJson?: Record<string, string | number | boolean | null>;
  },
  existingIndex: ExistingSourceIndex,
  stats: SeedRegistryStats,
  discoveryMode: DiscoveryMode
) {
  if (!safeUrl(input.candidateUrl)) {
    stats.rejectedUrls += 1;
    return null;
  }

  const detectedCandidateType = deriveCandidateType(input.candidateUrl);
  if (!detectedCandidateType) {
    stats.rejectedUrls += 1;
    return null;
  }

  if (
    input.candidateType !== "ATS_BOARD" &&
    isAggregatorHost(input.candidateUrl)
  ) {
    stats.rejectedUrls += 1;
    return null;
  }

  let status: SourceCandidateStatus = "NEW";
  const normalizedUrlKey = normalizeUrlIdentityKey(input.candidateUrl);

  const detectedTenant = detectAtsTenantFromUrl(input.candidateUrl);

  if (detectedTenant) {
    const connectorName =
      detectedTenant.platform === "ASHBY"
        ? "ashby"
        : detectedTenant.platform === "GREENHOUSE"
          ? "greenhouse"
          : detectedTenant.platform === "ICIMS"
            ? "icims"
            : detectedTenant.platform === "JOBVITE"
              ? "jobvite"
              : detectedTenant.platform === "LEVER"
                ? "lever"
                : detectedTenant.platform === "RECRUITEE"
                  ? "recruitee"
                  : detectedTenant.platform === "RIPPLING"
                    ? "rippling"
                    : detectedTenant.platform === "SMARTRECRUITERS"
                      ? "smartrecruiters"
                      : detectedTenant.platform === "SUCCESSFACTORS"
                        ? "successfactors"
                        : detectedTenant.platform === "TALEO"
                          ? "taleo"
                          : detectedTenant.platform === "TEAMTAILOR"
                            ? "teamtailor"
                            : detectedTenant.platform === "WORKABLE"
                              ? "workable"
                              : detectedTenant.platform === "WORKDAY"
                                ? "workday"
                                : null;

    if (connectorName && existingIndex.atsKeys.has(buildAtsKey(connectorName, detectedTenant.tenantKey))) {
      status = "PROMOTED";
    }
  } else if (
    normalizedUrlKey &&
    (existingIndex.companySiteUrlKeys.has(normalizedUrlKey) ||
      (input.companyId ? existingIndex.companySiteCompanyIds.has(input.companyId) : false))
  ) {
    status = "PROMOTED";
  }

  const candidate = await registerSourceCandidate({
    candidateUrl: input.candidateUrl,
    candidateType: input.candidateType,
    discoveryMode,
    companyNameHint: input.companyNameHint ?? null,
    confidence: input.confidence,
    noveltyScore: input.noveltyScore,
    coverageGapScore: input.coverageGapScore,
    potentialYieldScore: input.potentialYieldScore,
    sourceQualityScore: input.sourceQualityScore,
    status,
    metadataJson: input.metadataJson ?? null,
  });

  if (candidate.atsTenantId) {
    stats.atsTenantsLinked += 1;
  }
  if (status === "PROMOTED") {
    stats.promotedStatusCandidates += 1;
  } else {
    stats.newStatusCandidates += 1;
  }

  return candidate;
}

async function seedFromExistingCompanySources(
  existingIndex: ExistingSourceIndex,
  stats: SeedRegistryStats,
  options: SeedRegistryOptions
) {
  const rows = await prisma.companySource.findMany({
    where: {
      status: { not: "DISABLED" },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: options.existingSourceLimit ?? 3_000,
    include: {
      company: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  for (const row of rows) {
    const candidateType =
      row.connectorName === "company-site"
        ? deriveCandidateType(row.boardUrl) ?? "CAREER_PAGE"
        : "ATS_BOARD";

    await registerSeedCandidate(
      {
        candidateUrl: row.boardUrl,
        candidateType,
        companyId: row.companyId,
        companyNameHint: row.company.name,
        confidence: 0.99,
        noveltyScore: 0.05,
        coverageGapScore: 0.05,
        potentialYieldScore: Math.min(1, 0.25 + row.retainedLiveJobCount / 100),
        sourceQualityScore: Math.max(0.5, row.sourceQualityScore),
        metadataJson: {
          seedSource: "company-source",
          companySourceId: row.id,
          connectorName: row.connectorName,
          seedStatus: "promoted",
        },
      },
      existingIndex,
      stats,
      options.discoveryMode ?? "EXPLORATION"
    );
    stats.existingPromotedCandidates += 1;
  }
}

async function seedFromLiveUrlSignals(
  existingIndex: ExistingSourceIndex,
  stats: SeedRegistryStats,
  options: SeedRegistryOptions
) {
  const urlLimit = options.urlSeedLimit ?? 5_000;

  const mappingRows = (await prisma.$queryRawUnsafe<Array<{
    url: string;
    companyName: string | null;
    signalCount: number;
  }>>(
    `
      SELECT
        COALESCE(NULLIF(m."sourceUrl", ''), NULLIF(j."applyUrl", '')) AS url,
        MAX(j.company) AS "companyName",
        COUNT(*)::int AS "signalCount"
      FROM "JobSourceMapping" m
      JOIN "JobCanonical" j
        ON j.id = m."canonicalJobId"
      WHERE
        m."removedAt" IS NULL
        AND j.status IN ('LIVE', 'AGING', 'STALE')
        AND COALESCE(NULLIF(m."sourceUrl", ''), NULLIF(j."applyUrl", '')) IS NOT NULL
      GROUP BY 1
      ORDER BY COUNT(*) DESC
      LIMIT $1
    `,
    urlLimit
  )) satisfies Array<{ url: string; companyName: string | null; signalCount: number }>;

  const canonicalRows = (await prisma.$queryRawUnsafe<Array<{
    url: string;
    companyName: string | null;
    signalCount: number;
  }>>(
    `
      SELECT
        j."applyUrl" AS url,
        MAX(j.company) AS "companyName",
        COUNT(*)::int AS "signalCount"
      FROM "JobCanonical" j
      WHERE
        j.status IN ('LIVE', 'AGING', 'STALE')
        AND j."applyUrl" <> ''
      GROUP BY 1
      ORDER BY COUNT(*) DESC
      LIMIT $1
    `,
    urlLimit
  )) satisfies Array<{ url: string; companyName: string | null; signalCount: number }>;

  const merged = new Map<string, UrlSeedRow>();
  for (const row of [...mappingRows, ...canonicalRows]) {
    if (!row.url || isAggregatorHost(row.url)) continue;
    const candidateType = deriveCandidateType(row.url);
    if (!candidateType) continue;
    const key = `${candidateType}:${normalizeUrlIdentityKey(row.url) ?? row.url}`;
    const existing = merged.get(key);
    const score = Math.min(1, 0.2 + row.signalCount / 50);
    if (existing && existing.score >= score) continue;
    merged.set(key, {
      url: row.url,
      companyName: row.companyName,
      candidateType,
      score,
      metadataJson: {
        seedSource: "live-url-signal",
        signalCount: row.signalCount,
      },
    });
  }

  for (const row of merged.values()) {
    await registerSeedCandidate(
      {
        candidateUrl: row.url,
        candidateType: row.candidateType,
        companyNameHint: row.companyName,
        confidence: row.candidateType === "ATS_BOARD" ? 0.95 : 0.72,
        noveltyScore: row.candidateType === "ATS_BOARD" ? 0.58 : 0.34,
        coverageGapScore: row.candidateType === "ATS_BOARD" ? 0.64 : 0.46,
        potentialYieldScore: row.score,
        sourceQualityScore: row.candidateType === "ATS_BOARD" ? 0.88 : 0.55,
        metadataJson: row.metadataJson,
      },
      existingIndex,
      stats,
      options.discoveryMode ?? "EXPLORATION"
    );
    stats.liveUrlCandidates += 1;
  }
}

async function seedFromCompanySignals(
  existingIndex: ExistingSourceIndex,
  stats: SeedRegistryStats,
  options: SeedRegistryOptions
) {
  const companyLimit = options.companySeedLimit ?? 1_000;
  const companies = await prisma.company.findMany({
    where: {
      OR: [
        { careersUrl: { not: null } },
        { domain: { not: null } },
        { discoveryPages: { some: {} } },
      ],
    },
    orderBy: [{ discoveryConfidence: "desc" }, { updatedAt: "desc" }],
    take: companyLimit,
    include: {
      discoveryPages: {
        where: { failureCount: { lt: 3 } },
        orderBy: [{ confidence: "desc" }, { lastCheckedAt: "desc" }],
        take: 5,
        select: {
          url: true,
          confidence: true,
        },
      },
      sources: {
        where: {
          connectorName: "company-site",
          status: { not: "DISABLED" },
        },
        select: { id: true },
        take: 1,
      },
    },
  });

  const pageScanUrls = new Array<{ companyId: string; companyName: string; url: string; confidence: number }>();

  for (const company of companies) {
    const seedUrls = new Set<string>([
      ...buildCompanySiteSeedUrls(company.domain, company.careersUrl),
      ...company.discoveryPages.map((page) => page.url),
    ]);

    for (const url of seedUrls) {
      const candidateType = deriveCandidateType(url);
      if (!candidateType || isAggregatorHost(url)) continue;

      const hasCompanySiteSource =
        company.sources.length > 0 ||
        existingIndex.companySiteCompanyIds.has(company.id) ||
        (normalizeUrlIdentityKey(url) != null &&
          existingIndex.companySiteUrlKeys.has(normalizeUrlIdentityKey(url)!));

      await registerSeedCandidate(
        {
          candidateUrl: url,
          candidateType,
          companyId: company.id,
          companyNameHint: company.name,
          confidence: Math.max(0.45, company.discoveryConfidence),
          noveltyScore: hasCompanySiteSource ? 0.1 : 0.72,
          coverageGapScore: hasCompanySiteSource ? 0.1 : 0.8,
          potentialYieldScore: hasCompanySiteSource ? 0.2 : 0.62,
          sourceQualityScore: candidateType === "JOB_PAGE" ? 0.42 : 0.58,
          metadataJson: {
            seedSource: "company-signal",
            companyId: company.id,
          },
        },
        existingIndex,
        stats,
        options.discoveryMode ?? "EXPLORATION"
      );
      stats.companySignalCandidates += 1;

      if (!hasCompanySiteSource) {
        pageScanUrls.push({
          companyId: company.id,
          companyName: company.name,
          url,
          confidence: Math.max(0.45, company.discoveryConfidence),
        });
      }
    }
  }

  const uniquePageScanUrls = [...new Map(
    pageScanUrls.map((row) => [normalizeUrlIdentityKey(row.url) ?? row.url, row])
  ).values()].slice(0, options.companyPageScanLimit ?? 250);

  if (uniquePageScanUrls.length === 0) {
    return;
  }

  const discovery = await discoverSourceCandidatesFromPageUrls(
    uniquePageScanUrls.map((row) => row.url),
    { concurrency: options.pageDiscoveryConcurrency ?? 8 }
  );
  const companyByPage = new Map(
    uniquePageScanUrls.map((row) => [row.url, row])
  );

  for (const candidate of discovery.candidates) {
    const sources = discovery.sourceMap.get(candidate.sourceKey) ?? [];
    const strongestPage = sources
      .map((entry) => companyByPage.get(entry.pageUrl))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .sort((left, right) => right.confidence - left.confidence)[0];

    await registerSeedCandidate(
      {
        candidateUrl: candidate.boardUrl,
        candidateType: "ATS_BOARD",
        companyId: strongestPage?.companyId ?? null,
        companyNameHint: strongestPage?.companyName ?? null,
        confidence: 0.9,
        noveltyScore: 0.9,
        coverageGapScore: 0.94,
        potentialYieldScore: 0.88,
        sourceQualityScore: 0.95,
        metadataJson: {
          seedSource: "company-page-discovery",
          sourceKey: candidate.sourceKey,
          matchedPageUrl: strongestPage?.url ?? null,
        },
      },
      existingIndex,
      stats,
      options.discoveryMode ?? "EXPLORATION"
    );
    stats.discoveredPageCandidates += 1;
  }
}

async function seedFromEnterpriseCatalog(
  existingIndex: ExistingSourceIndex,
  stats: SeedRegistryStats,
  options: SeedRegistryOptions
) {
  const records = ENTERPRISE_DISCOVERY_COMPANIES.slice(0, options.enterpriseSeedLimit ?? 250);
  const pageUrls = new Array<{ companyName: string; url: string }>();

  for (const record of records) {
    for (const url of record.seedPageUrls ?? []) {
      const candidateType = deriveCandidateType(url);
      if (!candidateType) continue;
      await registerSeedCandidate(
        {
          candidateUrl: url,
          candidateType,
          companyNameHint: record.name,
          confidence: 0.82,
          noveltyScore: 0.95,
          coverageGapScore: 0.98,
          potentialYieldScore:
            record.ats === "workday" || record.ats === "successfactors" ? 0.95 : 0.74,
          sourceQualityScore: 0.72,
          metadataJson: {
            seedSource: "enterprise-catalog",
            atsHint: record.ats,
          },
        },
        existingIndex,
        stats,
        options.discoveryMode ?? "EXPLORATION"
      );
      stats.enterpriseCandidates += 1;
      pageUrls.push({ companyName: record.name, url });
    }
  }

  const uniquePageUrls = [...new Map(
    pageUrls.map((row) => [normalizeUrlIdentityKey(row.url) ?? row.url, row])
  ).values()];

  if (uniquePageUrls.length === 0) {
    return;
  }

  const discovery = await discoverSourceCandidatesFromPageUrls(
    uniquePageUrls.map((row) => row.url),
    { concurrency: options.pageDiscoveryConcurrency ?? 8 }
  );
  const companyByPage = new Map(uniquePageUrls.map((row) => [row.url, row.companyName]));

  for (const candidate of discovery.candidates) {
    const sources = discovery.sourceMap.get(candidate.sourceKey) ?? [];
    const companyName =
      sources
        .map((entry) => companyByPage.get(entry.pageUrl))
        .find((value): value is string => Boolean(value)) ?? null;

    await registerSeedCandidate(
      {
        candidateUrl: candidate.boardUrl,
        candidateType: "ATS_BOARD",
        companyNameHint: companyName,
        confidence: 0.96,
        noveltyScore: 0.98,
        coverageGapScore: 0.99,
        potentialYieldScore: 0.94,
        sourceQualityScore: 0.96,
        metadataJson: {
          seedSource: "enterprise-page-discovery",
          sourceKey: candidate.sourceKey,
        },
      },
      existingIndex,
      stats,
      options.discoveryMode ?? "EXPLORATION"
    );
    stats.enterprisePageCandidates += 1;
  }
}

export async function seedSourceRegistryFromExistingSignals(
  options: SeedRegistryOptions = {}
) {
  const stats: SeedRegistryStats = {
    existingPromotedCandidates: 0,
    liveUrlCandidates: 0,
    companySignalCandidates: 0,
    discoveredPageCandidates: 0,
    enterpriseCandidates: 0,
    enterprisePageCandidates: 0,
    atsTenantsLinked: 0,
    promotedStatusCandidates: 0,
    newStatusCandidates: 0,
    rejectedUrls: 0,
  };

  const existingIndex = await buildExistingSourceIndex();

  await seedFromExistingCompanySources(existingIndex, stats, options);
  await seedFromLiveUrlSignals(existingIndex, stats, options);
  await seedFromCompanySignals(existingIndex, stats, options);
  await seedFromEnterpriseCatalog(existingIndex, stats, options);

  const [sourceCandidateCount, atsTenantCount] = await Promise.all([
    prisma.sourceCandidate.count(),
    prisma.aTSTenant.count(),
  ]);

  return {
    ...stats,
    sourceCandidateCount,
    atsTenantCount,
  };
}
