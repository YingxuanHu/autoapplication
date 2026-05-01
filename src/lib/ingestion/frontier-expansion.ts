import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type {
  AtsPlatform,
  DiscoveryMode,
  SourceCandidateType,
} from "@/generated/prisma/client";
import {
  assignCanonicalJobsToCompany,
  ensureCompanyRecord,
} from "@/lib/ingestion/company-records";
import { promoteDiscoveredAtsCompanySource } from "@/lib/ingestion/company-discovery";
import {
  buildCompanyKey,
  cleanCompanyName,
} from "@/lib/ingestion/discovery/company-corpus";
import { detectAtsTenantFromUrl } from "@/lib/ingestion/discovery/ats-tenant-detector";
import {
  buildDiscoveredSourceName,
  discoverSourceCandidatesFromPageUrls,
  isKnownAtsHost,
} from "@/lib/ingestion/discovery/sources";
import {
  registerSourceCandidate,
  upsertAtsTenant,
} from "@/lib/ingestion/discovery/source-registry";
import { normalizeUrlIdentityKey } from "@/lib/ingestion/source-quality";
import { enqueueUniqueSourceTask } from "@/lib/ingestion/task-queue";

export type CompanyFrontierSeedFamily =
  | "companies-house"
  | "opencorporates"
  | "github-org"
  | "sec-edgar"
  | "internal-corpus"
  | "existing-corpus";

export type CompanyFrontierSeed = {
  family: CompanyFrontierSeedFamily;
  providerId?: string | null;
  companyName: string;
  aliases?: string[];
  searchTerms?: string[];
  domain?: string | null;
  websiteUrl?: string | null;
  careersUrl?: string | null;
  seedPageUrls?: string[];
  directAtsUrls?: string[];
  sectors?: string[];
  jurisdictionCodes?: string[];
  tickers?: string[];
  detectedAts?: string | null;
  discoveryConfidence?: number;
  metadataJson?: Record<string, Prisma.InputJsonValue | null> | null;
};

export type AtsExpansionSignal = {
  url: string;
  companyId?: string | null;
  companyNameHint?: string | null;
  confidence?: number;
  matchedReason: string;
  sourceFamily?: string | null;
  metadataJson?: Record<string, Prisma.InputJsonValue | null> | null;
};

export type FrontierSeedResult = {
  scannedCount: number;
  mergedCompanyCount: number;
  companyUpsertedCount: number;
  companyDiscoveryTasksQueued: number;
  pageCandidatesDiscovered: number;
  sourceCandidatesRegistered: number;
  atsSignalsDetected: number;
  atsTenantsUpserted: number;
  atsSourcesPromoted: number;
};

export type AtsExpansionResult = {
  scannedSignalCount: number;
  detectedSignalCount: number;
  groupedTenantCount: number;
  sourceCandidatesRegistered: number;
  atsTenantsUpserted: number;
  atsSourcesPromoted: number;
  conflictsSkipped: number;
};

type ConsolidatedSeed = {
  companyKey: string;
  primaryFamily: CompanyFrontierSeedFamily;
  companyName: string;
  aliases: Set<string>;
  searchTerms: Set<string>;
  domains: Set<string>;
  websiteUrls: Set<string>;
  careersUrls: Set<string>;
  seedPageUrls: Set<string>;
  directAtsUrls: Set<string>;
  sectors: Set<string>;
  jurisdictionCodes: Set<string>;
  tickers: Set<string>;
  externalRefs: Set<string>;
  detectedAts: string | null;
  discoveryConfidence: number;
  metadataJson: Record<string, Prisma.InputJsonValue | null>;
};

type PageSeed = {
  companyId: string;
  companyName: string;
  url: string;
  confidence: number;
  primaryFamily: CompanyFrontierSeedFamily;
};

type AggregatedAtsSignal = {
  platformKey: string;
  platform: AtsPlatform;
  connectorName: string;
  tenantKey: string;
  boardUrl: string;
  companyId: string | null;
  companyNameHint: string | null;
  confidence: number;
  reasons: Set<string>;
  sourceFamilies: Set<string>;
  signalUrls: Set<string>;
  metadataJson: Record<string, Prisma.InputJsonValue | null>;
};

const DEFAULT_FRONTIER_PROMOTION_THRESHOLD = 0.82;
const DEFAULT_PAGE_DISCOVERY_LIMIT = 300;
const DEFAULT_PAGE_DISCOVERY_CONCURRENCY = 8;
const EXTERNAL_FRONTIER_SOURCE_SET = new Set<CompanyFrontierSeedFamily>([
  "companies-house",
  "opencorporates",
  "github-org",
  "sec-edgar",
]);

export async function processCompanyFrontierSeeds(
  seeds: CompanyFrontierSeed[],
  options: {
    now?: Date;
    discoveryMode?: DiscoveryMode;
    pageDiscoveryLimit?: number;
    pageDiscoveryConcurrency?: number;
    promotionThreshold?: number;
    dryRun?: boolean;
  } = {}
): Promise<FrontierSeedResult> {
  const now = options.now ?? new Date();
  const discoveryMode = options.discoveryMode ?? "EXPLORATION";
  const promotionThreshold =
    options.promotionThreshold ?? DEFAULT_FRONTIER_PROMOTION_THRESHOLD;
  const consolidated = consolidateSeeds(seeds);

  if (options.dryRun) {
    return {
      scannedCount: seeds.length,
      mergedCompanyCount: consolidated.length,
      companyUpsertedCount: 0,
      companyDiscoveryTasksQueued: 0,
      pageCandidatesDiscovered: 0,
      sourceCandidatesRegistered: 0,
      atsSignalsDetected: 0,
      atsTenantsUpserted: 0,
      atsSourcesPromoted: 0,
    };
  }

  const pageSeeds: PageSeed[] = [];
  const immediateAtsSignals: AtsExpansionSignal[] = [];
  let companyUpsertedCount = 0;
  let companyDiscoveryTasksQueued = 0;
  let sourceCandidatesRegistered = 0;

  for (const seed of consolidated) {
    const preferredCareersUrl = choosePreferredUrl([...seed.careersUrls]);
    const urls = [
      ...seed.websiteUrls,
      ...seed.careersUrls,
      ...seed.seedPageUrls,
      ...seed.directAtsUrls,
      ...[...seed.domains].map((domain) => `https://${domain}`),
    ];

    const company = await ensureCompanyRecord({
      companyName: seed.companyName,
      companyKey: seed.companyKey,
      urls,
      careersUrl: preferredCareersUrl,
      detectedAts: seed.detectedAts,
      discoveryStatus: "PENDING",
      crawlStatus: "IDLE",
      discoveryConfidence: seed.discoveryConfidence,
      metadataJson: buildCompanyMetadata(seed, now),
    });
    await assignCanonicalJobsToCompany(company.id, seed.companyKey);
    companyUpsertedCount += 1;

    const companySiteUrls = collectCompanySiteUrls(seed);
    for (const url of companySiteUrls) {
      const candidateType = classifyCompanyUrl(url);
      if (!candidateType) continue;

      await registerSourceCandidate({
        candidateUrl: url,
        candidateType,
        discoveryMode,
        companyNameHint: seed.companyName,
        confidence: seed.discoveryConfidence,
        noveltyScore: isLikelyUndercoveredSeed(seed.primaryFamily) ? 0.82 : 0.56,
        coverageGapScore: isLikelyUndercoveredSeed(seed.primaryFamily) ? 0.9 : 0.64,
        potentialYieldScore: candidateType === "CAREER_PAGE" ? 0.72 : 0.48,
        sourceQualityScore: candidateType === "CAREER_PAGE" ? 0.68 : 0.52,
        metadataJson: {
          seedSource: seed.primaryFamily,
          frontierExpansion: true,
          sourceFamilies: [...new Set([seed.primaryFamily])],
          companyKey: seed.companyKey,
        },
      });
      sourceCandidatesRegistered += 1;

      if (!isKnownAtsUrl(url)) {
        pageSeeds.push({
          companyId: company.id,
          companyName: company.name,
          url,
          confidence: seed.discoveryConfidence,
          primaryFamily: seed.primaryFamily,
        });
      }
    }

    for (const url of seed.directAtsUrls) {
      immediateAtsSignals.push({
        url,
        companyId: company.id,
        companyNameHint: company.name,
        confidence: Math.max(seed.discoveryConfidence, 0.84),
        matchedReason: `frontier-seed:${seed.primaryFamily}`,
        sourceFamily: seed.primaryFamily,
        metadataJson: {
          seedSource: seed.primaryFamily,
          frontierExpansion: true,
          companyKey: seed.companyKey,
        },
      });
    }

    await enqueueUniqueSourceTask({
      kind: "COMPANY_DISCOVERY",
      companyId: company.id,
      priorityScore: computeFrontierDiscoveryPriority(seed),
      notBeforeAt: now,
      payloadJson: {
        origin: "frontier-seed",
        seedSource: seed.primaryFamily,
        frontierExpansion: true,
      },
    });
    companyDiscoveryTasksQueued += 1;
  }

  const uniquePageSeeds = dedupePageSeeds(pageSeeds).slice(
    0,
    options.pageDiscoveryLimit ?? DEFAULT_PAGE_DISCOVERY_LIMIT
  );
  let pageCandidatesDiscovered = 0;

  if (uniquePageSeeds.length > 0) {
    const discovery = await discoverSourceCandidatesFromPageUrls(
      uniquePageSeeds.map((seed) => seed.url),
      { concurrency: options.pageDiscoveryConcurrency ?? DEFAULT_PAGE_DISCOVERY_CONCURRENCY }
    );
    const pageByUrlKey = new Map(
      uniquePageSeeds.map((seed) => [normalizeUrlIdentityKey(seed.url) ?? seed.url, seed] as const)
    );
    const discoveredSignals: AtsExpansionSignal[] = [];

    for (const candidate of discovery.candidates) {
      const evidence = discovery.sourceMap.get(candidate.sourceKey) ?? [];
      const pageSeed =
        evidence
          .map((entry) => pageByUrlKey.get(normalizeUrlIdentityKey(entry.pageUrl) ?? entry.pageUrl))
          .find((seed): seed is PageSeed => Boolean(seed)) ?? null;
      if (!pageSeed) continue;

      pageCandidatesDiscovered += 1;
      discoveredSignals.push({
        url: candidate.boardUrl,
        companyId: pageSeed.companyId,
        companyNameHint: pageSeed.companyName,
        confidence: 0.92,
        matchedReason: `page-discovery:${pageSeed.primaryFamily}`,
        sourceFamily: pageSeed.primaryFamily,
        metadataJson: {
          seedSource: pageSeed.primaryFamily,
          frontierExpansion: true,
          matchedPageUrl: pageSeed.url,
          sourceKey: candidate.sourceKey,
        },
      });
    }

    immediateAtsSignals.push(...discoveredSignals);
  }

  const atsExpansion = await expandAtsTenantsFromSignals(immediateAtsSignals, {
    now,
    discoveryMode,
    promotionThreshold,
  });

  return {
    scannedCount: seeds.length,
    mergedCompanyCount: consolidated.length,
    companyUpsertedCount,
    companyDiscoveryTasksQueued,
    pageCandidatesDiscovered,
    sourceCandidatesRegistered:
      sourceCandidatesRegistered + atsExpansion.sourceCandidatesRegistered,
    atsSignalsDetected: atsExpansion.detectedSignalCount,
    atsTenantsUpserted: atsExpansion.atsTenantsUpserted,
    atsSourcesPromoted: atsExpansion.atsSourcesPromoted,
  };
}

export async function expandAtsTenantsFromSignals(
  signals: AtsExpansionSignal[],
  options: {
    now?: Date;
    discoveryMode?: DiscoveryMode;
    promotionThreshold?: number;
    dryRun?: boolean;
  } = {}
): Promise<AtsExpansionResult> {
  const now = options.now ?? new Date();
  const discoveryMode = options.discoveryMode ?? "EXPLORATION";
  const promotionThreshold =
    options.promotionThreshold ?? DEFAULT_FRONTIER_PROMOTION_THRESHOLD;
  const aggregated = aggregateAtsSignals(signals);

  if (options.dryRun) {
    return {
      scannedSignalCount: signals.length,
      detectedSignalCount: aggregated.reduce(
        (sum, signal) => sum + signal.signalUrls.size,
        0
      ),
      groupedTenantCount: aggregated.length,
      sourceCandidatesRegistered: 0,
      atsTenantsUpserted: 0,
      atsSourcesPromoted: 0,
      conflictsSkipped: 0,
    };
  }

  let sourceCandidatesRegistered = 0;
  let atsTenantsUpserted = 0;
  let atsSourcesPromoted = 0;
  let conflictsSkipped = 0;

  for (const signal of aggregated) {
    const companyId =
      signal.companyId ??
      (signal.companyNameHint
        ? (
            await ensureCompanyRecord({
              companyName: signal.companyNameHint,
              companyKey: buildCompanyKey(signal.companyNameHint),
              urls: [...signal.signalUrls],
              careersUrl: signal.boardUrl,
              discoveryStatus: "DISCOVERED",
              crawlStatus: "IDLE",
              discoveryConfidence: signal.confidence,
              metadataJson: {
                seedSource: "ats-url-expansion",
                frontierExpansion: true,
                sourceFamilies: [...signal.sourceFamilies],
              },
            })
          ).id
        : null);

    const [connectorName, token] = signal.platformKey.split(":", 2);
    if (!connectorName || !token) {
      continue;
    }

    const sourceName = buildDiscoveredSourceName(
      connectorName as Parameters<typeof buildDiscoveredSourceName>[0],
      token
    );
    const existingSource = await prisma.companySource.findUnique({
      where: { sourceName },
      select: {
        id: true,
        companyId: true,
      },
    });

    const atsTenant = await upsertAtsTenant({
      platform: signal.platform,
      tenantKey: signal.tenantKey,
      normalizedBoardUrl: signal.boardUrl,
      rootHost: new URL(signal.boardUrl).hostname.replace(/^www\./i, "").toLowerCase(),
      companyId,
      confidence: signal.confidence,
      discoveryMethod: "frontier_url_signal",
      metadataJson: {
        matchedReasons: [...signal.reasons],
        sourceFamilies: [...signal.sourceFamilies],
        signalUrls: [...signal.signalUrls],
        frontierExpansion: true,
      },
    });
    atsTenantsUpserted += 1;

    await registerSourceCandidate({
      candidateUrl: signal.boardUrl,
      candidateType: "ATS_BOARD",
      discoveryMode,
      companyNameHint: signal.companyNameHint,
      confidence: signal.confidence,
      noveltyScore: Math.min(1, 0.68 + signal.signalUrls.size * 0.04),
      coverageGapScore: Math.min(1, 0.74 + signal.signalUrls.size * 0.05),
      potentialYieldScore: Math.min(1, 0.72 + signal.signalUrls.size * 0.03),
      sourceQualityScore: 0.94,
      status:
        existingSource && companyId && existingSource.companyId === companyId
          ? "PROMOTED"
          : "NEW",
      metadataJson: {
        seedSource: "ats-url-expansion",
        frontierExpansion: true,
        matchedReasons: [...signal.reasons],
        sourceFamilies: [...signal.sourceFamilies],
        signalUrls: [...signal.signalUrls],
      },
    });
    sourceCandidatesRegistered += 1;

    if (!companyId || signal.confidence < promotionThreshold) {
      continue;
    }

    if (existingSource && existingSource.companyId && existingSource.companyId !== companyId) {
      conflictsSkipped += 1;
      continue;
    }

    await promoteDiscoveredAtsCompanySource(
      companyId,
      {
        sourceName,
        connectorName,
        token,
        boardUrl: signal.boardUrl,
        atsTenantId: atsTenant.id,
        careerPageUrls: [],
        directAtsUrls: [...signal.signalUrls],
        matchedReasons: [...signal.reasons],
        metadataJson: {
          seedSource: "ats-url-expansion",
          frontierExpansion: true,
          sourceFamilies: [...signal.sourceFamilies],
          signalUrls: [...signal.signalUrls],
        },
      },
      now
    );
    atsSourcesPromoted += 1;
  }

  return {
    scannedSignalCount: signals.length,
    detectedSignalCount: aggregated.reduce(
      (sum, signal) => sum + signal.signalUrls.size,
      0
    ),
    groupedTenantCount: aggregated.length,
    sourceCandidatesRegistered,
    atsTenantsUpserted,
    atsSourcesPromoted,
    conflictsSkipped,
  };
}

function consolidateSeeds(seeds: CompanyFrontierSeed[]) {
  const merged = new Map<string, ConsolidatedSeed>();

  for (const seed of seeds) {
    const cleanedName = cleanCompanyName(seed.companyName);
    const companyKey = buildCompanyKey(cleanedName);
    if (!cleanedName || !companyKey) continue;

    const existing = merged.get(companyKey) ?? {
      companyKey,
      primaryFamily: seed.family,
      companyName: cleanedName,
      aliases: new Set<string>(),
      searchTerms: new Set<string>(),
      domains: new Set<string>(),
      websiteUrls: new Set<string>(),
      careersUrls: new Set<string>(),
      seedPageUrls: new Set<string>(),
      directAtsUrls: new Set<string>(),
      sectors: new Set<string>(),
      jurisdictionCodes: new Set<string>(),
      tickers: new Set<string>(),
      externalRefs: new Set<string>(),
      detectedAts: seed.detectedAts ?? null,
      discoveryConfidence: seed.discoveryConfidence ?? 0.6,
      metadataJson: {},
    } satisfies ConsolidatedSeed;

    existing.companyName = chooseLongerName(existing.companyName, cleanedName);
    existing.discoveryConfidence = Math.max(
      existing.discoveryConfidence,
      seed.discoveryConfidence ?? 0.6
    );
    if (!existing.detectedAts && seed.detectedAts) {
      existing.detectedAts = seed.detectedAts;
    }

    existing.aliases.add(cleanedName);
    for (const alias of seed.aliases ?? []) {
      const cleanedAlias = cleanCompanyName(alias);
      if (cleanedAlias) existing.aliases.add(cleanedAlias);
    }
    for (const searchTerm of seed.searchTerms ?? []) {
      const trimmed = searchTerm.trim();
      if (trimmed) existing.searchTerms.add(trimmed);
    }

    const domain = normalizeDomain(seed.domain);
    if (domain) existing.domains.add(domain);
    for (const url of [seed.websiteUrl, seed.careersUrl]) {
      const normalized = normalizeUrl(url);
      if (!normalized) continue;
      existing.websiteUrls.add(normalized);
    }

    if (seed.careersUrl) {
      const normalizedCareers = normalizeUrl(seed.careersUrl);
      if (normalizedCareers) existing.careersUrls.add(normalizedCareers);
    }

    for (const pageUrl of seed.seedPageUrls ?? []) {
      const normalized = normalizeUrl(pageUrl);
      if (normalized) existing.seedPageUrls.add(normalized);
    }

    for (const directAtsUrl of seed.directAtsUrls ?? []) {
      const normalized = normalizeUrl(directAtsUrl);
      if (normalized) existing.directAtsUrls.add(normalized);
    }

    for (const sector of seed.sectors ?? []) {
      const trimmed = sector.trim();
      if (trimmed) existing.sectors.add(trimmed);
    }
    for (const jurisdiction of seed.jurisdictionCodes ?? []) {
      const trimmed = jurisdiction.trim().toLowerCase();
      if (trimmed) existing.jurisdictionCodes.add(trimmed);
    }
    for (const ticker of seed.tickers ?? []) {
      const trimmed = ticker.trim().toUpperCase();
      if (trimmed) existing.tickers.add(trimmed);
    }

    if (seed.providerId) {
      existing.externalRefs.add(`${seed.family}:${seed.providerId}`);
    }

    existing.metadataJson = {
      ...existing.metadataJson,
      ...(seed.metadataJson ?? {}),
    };
    merged.set(companyKey, existing);
  }

  return [...merged.values()];
}

function buildCompanyMetadata(seed: ConsolidatedSeed, now: Date) {
  return {
    ...seed.metadataJson,
    seedSource: seed.primaryFamily,
    frontierExpansion: true,
    frontierSeededAt: now.toISOString(),
    sourceFamilies: [...new Set([seed.primaryFamily, ...inferSourceFamilies(seed)])],
    aliases: [...seed.aliases],
    searchTerms: [...new Set([seed.companyName, ...seed.aliases, ...seed.searchTerms])],
    domains: [...seed.domains],
    seedPageUrls: [...new Set([
      ...seed.seedPageUrls,
      ...seed.careersUrls,
      ...[...seed.domains].flatMap((domain) => buildDomainSeedUrls(domain)),
    ])],
    directAtsUrls: [...seed.directAtsUrls],
    sectors: [...seed.sectors],
    jurisdictions: [...seed.jurisdictionCodes],
    tickers: [...seed.tickers],
    externalRefs: [...seed.externalRefs],
  } satisfies Record<string, Prisma.InputJsonValue | null>;
}

function collectCompanySiteUrls(seed: ConsolidatedSeed) {
  const urls = new Set<string>();

  for (const url of seed.seedPageUrls) {
    if (!isKnownAtsUrl(url)) {
      urls.add(url);
    }
  }

  for (const url of seed.careersUrls) {
    if (!isKnownAtsUrl(url)) {
      urls.add(url);
    }
  }

  for (const url of seed.websiteUrls) {
    if (!isKnownAtsUrl(url)) {
      urls.add(url);
    }
  }

  for (const domain of seed.domains) {
    for (const url of buildDomainSeedUrls(domain)) {
      if (!isKnownAtsUrl(url)) {
        urls.add(url);
      }
    }
  }

  return [...urls];
}

function classifyCompanyUrl(url: string): SourceCandidateType | null {
  const normalizedKey = normalizeUrlIdentityKey(url);
  if (!normalizedKey) return null;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (!path || path === "/") return "COMPANY_ROOT";
    if (/(?:^|\/)(?:careers?|jobs?|join-us|join|opportunities|openings?)(?:\/|$)/i.test(path)) {
      return "CAREER_PAGE";
    }
    return "CAREER_PAGE";
  } catch {
    return null;
  }
}

function computeFrontierDiscoveryPriority(seed: ConsolidatedSeed) {
  return (
    Math.min(42, seed.searchTerms.size * 2) +
    Math.min(24, seed.domains.size * 12) +
    Math.min(30, seed.careersUrls.size * 10) +
    (seed.directAtsUrls.size > 0 ? 32 : 0) +
    (isLikelyUndercoveredSeed(seed.primaryFamily) ? 24 : 10) +
    Math.round(seed.discoveryConfidence * 25)
  );
}

function dedupePageSeeds(pageSeeds: PageSeed[]) {
  const merged = new Map<string, PageSeed>();

  for (const seed of pageSeeds) {
    const key = normalizeUrlIdentityKey(seed.url) ?? seed.url;
    const existing = merged.get(key);
    if (!existing || seed.confidence > existing.confidence) {
      merged.set(key, seed);
    }
  }

  return [...merged.values()];
}

function aggregateAtsSignals(signals: AtsExpansionSignal[]) {
  const merged = new Map<string, AggregatedAtsSignal>();

  for (const signal of signals) {
    const detected = detectAtsTenantFromUrl(signal.url);
    if (!detected) continue;

    const connectorName = mapPlatformToConnectorName(detected.platform);
    if (!connectorName) continue;

    const platformKey = `${connectorName}:${detected.tenantKey}`;
    const existing = merged.get(platformKey) ?? {
      platformKey,
      platform: detected.platform,
      connectorName,
      tenantKey: detected.tenantKey,
      boardUrl: detected.normalizedBoardUrl,
      companyId: signal.companyId ?? null,
      companyNameHint: signal.companyNameHint?.trim() || null,
      confidence: signal.confidence ?? 0.7,
      reasons: new Set<string>(),
      sourceFamilies: new Set<string>(),
      signalUrls: new Set<string>(),
      metadataJson: {},
    };

    if (!existing.companyId && signal.companyId) {
      existing.companyId = signal.companyId;
    }
    if (!existing.companyNameHint && signal.companyNameHint) {
      existing.companyNameHint = signal.companyNameHint.trim();
    }
    existing.confidence = Math.max(
      existing.confidence,
      Math.min(0.99, (signal.confidence ?? 0.7) + Math.max(0, existing.signalUrls.size) * 0.03)
    );
    existing.reasons.add(signal.matchedReason);
    if (signal.sourceFamily) {
      existing.sourceFamilies.add(signal.sourceFamily);
    }
    existing.signalUrls.add(signal.url);
    existing.metadataJson = {
      ...existing.metadataJson,
      ...(signal.metadataJson ?? {}),
    };
    merged.set(platformKey, existing);
  }

  return [...merged.values()];
}

function mapPlatformToConnectorName(platform: AtsPlatform) {
  switch (platform) {
    case "ASHBY":
      return "ashby";
    case "GREENHOUSE":
      return "greenhouse";
    case "ICIMS":
      return "icims";
    case "JOBVITE":
      return "jobvite";
    case "LEVER":
      return "lever";
    case "RECRUITEE":
      return "recruitee";
    case "RIPPLING":
      return "rippling";
    case "SMARTRECRUITERS":
      return "smartrecruiters";
    case "SUCCESSFACTORS":
      return "successfactors";
    case "TALEO":
      return "taleo";
    case "TEAMTAILOR":
      return "teamtailor";
    case "WORKABLE":
      return "workable";
    case "WORKDAY":
      return "workday";
    default:
      return null;
  }
}

function buildDomainSeedUrls(domain: string) {
  return [
    `https://${domain}`,
    `https://${domain}/careers`,
    `https://${domain}/jobs`,
    `https://${domain}/careers/jobs`,
    `https://${domain}/join-us`,
  ];
}

function normalizeDomain(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/.*$/, "")
      .trim();
  }
}

function normalizeUrl(value: string | null | undefined) {
  if (!value) return null;
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

function choosePreferredUrl(urls: string[]) {
  return urls.sort((left, right) => scorePreferredUrl(right) - scorePreferredUrl(left))[0] ?? null;
}

function scorePreferredUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (isKnownAtsHost(parsed.hostname.replace(/^www\./i, "").toLowerCase())) {
      return 10;
    }
    if (/\/careers?(?:\/|$)/.test(path)) return 9;
    if (/\/jobs?(?:\/|$)/.test(path)) return 8;
    if (path === "/" || path.length === 0) return 2;
    return 4;
  } catch {
    return 0;
  }
}

function isKnownAtsUrl(url: string) {
  try {
    return isKnownAtsHost(new URL(url).hostname.replace(/^www\./i, "").toLowerCase());
  } catch {
    return false;
  }
}

function chooseLongerName(currentValue: string, nextValue: string) {
  return nextValue.trim().length > currentValue.trim().length
    ? nextValue
    : currentValue;
}

function inferSourceFamilies(seed: ConsolidatedSeed) {
  return [...seed.externalRefs].map((value) => value.split(":")[0] ?? value);
}

function isLikelyUndercoveredSeed(seedFamily: CompanyFrontierSeedFamily) {
  return EXTERNAL_FRONTIER_SOURCE_SET.has(seedFamily);
}
