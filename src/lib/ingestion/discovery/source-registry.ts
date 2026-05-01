import { prisma } from "@/lib/db";
import { ensureCompanyRecord } from "@/lib/ingestion/company-records";
import {
  promoteCompanySiteSourceRoute,
  promoteDiscoveredAtsCompanySource,
} from "@/lib/ingestion/company-discovery";
import { buildCompanyKey } from "@/lib/ingestion/discovery/company-corpus";
import { detectAtsTenantFromUrl } from "@/lib/ingestion/discovery/ats-tenant-detector";
import { normalizeUrlIdentityKey } from "@/lib/ingestion/source-quality";
import { inspectCompanySiteRoute } from "@/lib/ingestion/connectors";
import { Prisma } from "@/generated/prisma/client";
import type {
  AtsPlatform,
  DiscoveryMode,
  SourceCandidateStatus,
  SourceCandidateType,
} from "@/generated/prisma/client";

function getUrlParts(input: string) {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".");
    const rootDomain =
      parts.length >= 2 ? parts.slice(-2).join(".") : parts[0] ?? host;
    return { url, host, rootDomain };
  } catch {
    return null;
  }
}

export async function registerSourceCandidate(input: {
  candidateUrl: string;
  candidateType: SourceCandidateType;
  discoveryMode?: DiscoveryMode;
  companyNameHint?: string | null;
  titleHint?: string | null;
  confidence?: number;
  noveltyScore?: number;
  coverageGapScore?: number;
  potentialYieldScore?: number;
  sourceQualityScore?: number;
  status?: SourceCandidateStatus;
  metadataJson?: Record<string, Prisma.InputJsonValue | null> | null;
}) {
  const normalizedUrlKey = normalizeUrlIdentityKey(input.candidateUrl) ?? input.candidateUrl;
  const urlParts = getUrlParts(input.candidateUrl);
  const detectedTenant = detectAtsTenantFromUrl(input.candidateUrl);
  const companyNameHint = input.companyNameHint?.trim() || null;

  const company =
    companyNameHint != null
      ? await ensureCompanyRecord({
          companyName: companyNameHint,
          companyKey: buildCompanyKey(companyNameHint),
          urls: [input.candidateUrl],
          discoveryConfidence: input.confidence ?? 0,
          metadataJson: {
            discovery: {
              sourceCandidateUrl: input.candidateUrl,
            },
          },
        })
      : null;

  const atsTenant = detectedTenant
    ? await upsertAtsTenant({
        ...detectedTenant,
        companyId: company?.id ?? null,
        confidence: input.confidence ?? 0,
        discoveryMethod: "url_pattern",
        metadataJson: input.metadataJson ?? null,
      })
    : null;

  const existing = await prisma.sourceCandidate.findUnique({
    where: {
      candidateType_normalizedUrlKey: {
        candidateType: input.candidateType,
        normalizedUrlKey,
      },
    },
  });

  const data = {
    companyId: company?.id ?? existing?.companyId ?? null,
    atsTenantId: atsTenant?.id ?? existing?.atsTenantId ?? null,
    candidateType: input.candidateType,
    status: input.status ?? existing?.status ?? "NEW",
    discoveryMode: input.discoveryMode ?? existing?.discoveryMode ?? "EXPLORATION",
    candidateUrl: input.candidateUrl,
    normalizedUrlKey,
    rootHost: urlParts?.host ?? existing?.rootHost ?? null,
    rootDomain: urlParts?.rootDomain ?? existing?.rootDomain ?? null,
    companyNameHint: companyNameHint ?? existing?.companyNameHint ?? null,
    titleHint: input.titleHint?.trim() || existing?.titleHint || null,
    atsPlatform: atsTenant?.platform ?? existing?.atsPlatform ?? null,
    atsTenantKey: atsTenant?.tenantKey ?? existing?.atsTenantKey ?? null,
    confidence: Math.max(existing?.confidence ?? 0, input.confidence ?? 0),
    noveltyScore: Math.max(existing?.noveltyScore ?? 0, input.noveltyScore ?? 0),
    coverageGapScore: Math.max(
      existing?.coverageGapScore ?? 0,
      input.coverageGapScore ?? 0
    ),
    potentialYieldScore: Math.max(
      existing?.potentialYieldScore ?? 0,
      input.potentialYieldScore ?? 0
    ),
    sourceQualityScore: Math.max(
      existing?.sourceQualityScore ?? 0,
      input.sourceQualityScore ?? 0
    ),
    lastSeenAt: new Date(),
    metadataJson:
      input.metadataJson != null
        ? (input.metadataJson as Prisma.InputJsonValue)
        : existing?.metadataJson != null
          ? (existing.metadataJson as Prisma.InputJsonValue)
          : Prisma.DbNull,
  } satisfies Prisma.SourceCandidateUncheckedCreateInput;

  if (existing) {
    return prisma.sourceCandidate.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.sourceCandidate.create({ data });
}

export async function upsertAtsTenant(input: {
  platform: AtsPlatform;
  tenantKey: string;
  normalizedBoardUrl: string;
  rootHost: string;
  companyId?: string | null;
  confidence?: number;
  discoveryMethod?: string | null;
  metadataJson?: Record<string, Prisma.InputJsonValue | null> | null;
}) {
  const [existingByToken, existingByBoardUrl] = await Promise.all([
    prisma.aTSTenant.findUnique({
      where: {
        platform_tenantKey: {
          platform: input.platform,
          tenantKey: input.tenantKey,
        },
      },
    }),
    prisma.aTSTenant.findUnique({
      where: {
        platform_normalizedBoardUrl: {
          platform: input.platform,
          normalizedBoardUrl: input.normalizedBoardUrl,
        },
      },
    }),
  ]);
  const existing = existingByToken ?? existingByBoardUrl;

  const data = {
    companyId: input.companyId ?? existing?.companyId ?? null,
    platform: input.platform,
    tenantKey: input.tenantKey,
    normalizedBoardUrl: input.normalizedBoardUrl,
    rootHost: input.rootHost,
    status: existing?.status ?? "NEW",
    confidence: Math.max(existing?.confidence ?? 0, input.confidence ?? 0),
    discoveryMethod: input.discoveryMethod ?? existing?.discoveryMethod ?? null,
    lastSeenAt: new Date(),
    metadataJson:
      input.metadataJson != null
        ? (input.metadataJson as Prisma.InputJsonValue)
        : existing?.metadataJson != null
          ? (existing.metadataJson as Prisma.InputJsonValue)
          : Prisma.DbNull,
  } satisfies Prisma.ATSTenantUncheckedCreateInput;

  if (existing) {
    return prisma.aTSTenant.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.aTSTenant.create({ data });
}

export async function promoteSourceCandidate(input: {
  sourceCandidateId: string;
  connectorName: string;
  token: string;
  sourceName: string;
  boardUrl: string;
  sourceType?: string | null;
  extractionRoute?: Prisma.InputJsonValue | null;
  pollingCadenceMinutes?: number | null;
  priorityScore?: number;
}) {
  const candidate = await prisma.sourceCandidate.findUniqueOrThrow({
    where: { id: input.sourceCandidateId },
    include: {
      company: true,
      atsTenant: true,
    },
  });

  const company =
    candidate.company ??
    (candidate.companyNameHint
      ? await ensureCompanyRecord({
          companyName: candidate.companyNameHint,
          companyKey: buildCompanyKey(candidate.companyNameHint),
          urls: [candidate.candidateUrl, input.boardUrl],
          discoveryConfidence: candidate.confidence,
        })
      : null);

  if (!company) {
    throw new Error(`Cannot promote source candidate ${candidate.id} without a company hint.`);
  }

  let source;

  if (candidate.atsTenant && input.connectorName !== "company-site") {
    source = await promoteDiscoveredAtsCompanySource(
      company.id,
      {
        sourceName: input.sourceName,
        connectorName: input.connectorName,
        token: input.token,
        boardUrl: input.boardUrl,
        atsTenantId: candidate.atsTenantId,
        careerPageUrls: [candidate.candidateUrl],
        directAtsUrls: [candidate.candidateUrl, input.boardUrl],
        matchedReasons: [
          "source-candidate-promotion",
          ...(candidate.atsPlatform ? [`ats-platform:${candidate.atsPlatform.toLowerCase()}`] : []),
        ],
      },
      new Date()
    );
  } else {
    const inspection = await inspectCompanySiteRoute(candidate.candidateUrl);
    if (inspection.extractionRoute === "UNKNOWN") {
      throw new Error(
        `Company-site candidate ${candidate.candidateUrl} did not expose a stable route.`
      );
    }

    source = await promoteCompanySiteSourceRoute(
      company.id,
      company.companyKey,
      {
        url: inspection.finalUrl,
        extractionRoute: inspection.extractionRoute,
        parserVersion: inspection.parserVersion,
        confidence: Math.max(candidate.confidence, inspection.confidence),
        metadata: {
          ...(candidate.metadataJson && typeof candidate.metadataJson === "object" && !Array.isArray(candidate.metadataJson)
            ? (candidate.metadataJson as Record<string, Prisma.InputJsonValue | null>)
            : {}),
          sourceCandidateId: candidate.id,
          sourceCandidateUrl: candidate.candidateUrl,
          sourceCandidateType: candidate.candidateType,
        },
      },
      new Date()
    );
  }

  await prisma.sourceCandidate.update({
    where: { id: candidate.id },
    data: {
      companyId: company.id,
      status: "PROMOTED",
      promotedAt: new Date(),
      lastValidatedAt: new Date(),
    },
  });

  if (candidate.atsTenantId) {
    await prisma.aTSTenant.update({
      where: { id: candidate.atsTenantId },
      data: {
        companyId: company.id,
        status: "PROMOTED",
        lastPromotedAt: new Date(),
      },
    });
  }

  return source;
}

export async function rejectSourceCandidate(
  sourceCandidateId: string,
  lastError: string
) {
  return prisma.sourceCandidate.update({
    where: { id: sourceCandidateId },
    data: {
      status: "REJECTED",
      failureCount: { increment: 1 },
      lastError,
      lastValidatedAt: new Date(),
    },
  });
}

export async function listSourceCandidatesForExploration(limit: number) {
  return prisma.sourceCandidate.findMany({
    where: {
      status: { in: ["NEW", "VALIDATED", "STALE"] },
      discoveryMode: "EXPLORATION",
    },
    orderBy: [
      { coverageGapScore: "desc" },
      { noveltyScore: "desc" },
      { potentialYieldScore: "desc" },
      { createdAt: "asc" },
    ],
    take: limit,
  });
}
