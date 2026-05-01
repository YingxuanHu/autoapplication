import { prisma } from "@/lib/db";
import {
  buildCanonicalDedupeFields,
} from "@/lib/ingestion/dedupe";
import {
  deriveSourceIdentitySnapshot,
  deriveSourceLifecycleSnapshot,
} from "@/lib/ingestion/source-quality";
import {
  computeNormalizedQualityScore,
  computeTrustScore,
} from "@/lib/ingestion/quality";
import { normalizeSourceJob } from "@/lib/ingestion/normalize";
import { sanitizeCompanyName, sanitizeJobDescriptionText, sanitizeJobTitle } from "@/lib/job-cleanup";
import type { SourceConnectorJob } from "@/lib/ingestion/types";
import { Prisma } from "@/generated/prisma/client";

const INCREMENTAL_SOURCE_PREFIXES = new Set([
  "Adzuna",
  "Himalayas",
  "JobBank",
  "Jobicy",
  "RemoteOK",
  "Remotive",
  "TheMuse",
  "USAJobs",
  "WeWorkRemotely",
]);

function asJsonObject(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, Prisma.JsonValue | null>;
}

function parseDate(value: Prisma.JsonValue | null | undefined) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function inferFreshnessModeFromSourceName(sourceName: string) {
  const prefix = sourceName.split(":")[0] ?? sourceName;
  return INCREMENTAL_SOURCE_PREFIXES.has(prefix) ? "INCREMENTAL" : "FULL_SNAPSHOT";
}

export function parseSourceConnectorJobFromRawPayload(input: {
  sourceName: string;
  sourceId: string;
  rawPayload: Prisma.JsonValue;
}) {
  const payload = asJsonObject(input.rawPayload);
  if (!payload) {
    throw new Error(`Raw job ${input.sourceName}/${input.sourceId} has invalid rawPayload.`);
  }

  return {
    sourceId: input.sourceId,
    sourceUrl: typeof payload.sourceUrl === "string" ? payload.sourceUrl : null,
    title: typeof payload.title === "string" ? payload.title : "",
    company: typeof payload.company === "string" ? payload.company : "",
    location: typeof payload.location === "string" ? payload.location : "",
    description: typeof payload.description === "string" ? payload.description : "",
    applyUrl: typeof payload.applyUrl === "string" ? payload.applyUrl : "",
    postedAt: parseDate(payload.postedAt),
    deadline: parseDate(payload.deadline),
    employmentType: null,
    workMode: null,
    salaryMin: typeof payload.salaryMin === "number" ? payload.salaryMin : null,
    salaryMax: typeof payload.salaryMax === "number" ? payload.salaryMax : null,
    salaryCurrency: typeof payload.salaryCurrency === "string" ? payload.salaryCurrency : null,
    metadata:
      payload.metadata != null
        ? (payload.metadata as Prisma.InputJsonValue)
        : {},
  } satisfies SourceConnectorJob;
}

function buildRejectedNormalizedRecordData(sourceJob: SourceConnectorJob, fetchedAt: Date) {
  const title = sanitizeJobTitle(sourceJob.title);
  const company = sanitizeCompanyName(sourceJob.company, {
    urls: [sourceJob.applyUrl, sourceJob.sourceUrl],
  });
  const location = sourceJob.location.trim() || "Unknown";
  const description = sanitizeJobDescriptionText(sourceJob.description, {
    title,
    location,
  });
  const dedupeFields = buildCanonicalDedupeFields({
    company,
    title,
    description,
    location,
    region: null,
    applyUrl: sourceJob.applyUrl,
  });

  return {
    title,
    company,
    companyKey: dedupeFields.companyKey,
    titleKey: dedupeFields.titleKey,
    titleCoreKey: dedupeFields.titleCoreKey,
    descriptionFingerprint: dedupeFields.descriptionFingerprint,
    location,
    locationKey: dedupeFields.locationKey,
    region: null,
    workMode: "UNKNOWN" as const,
    salaryMin: sourceJob.salaryMin,
    salaryMax: sourceJob.salaryMax,
    salaryCurrency: sourceJob.salaryCurrency,
    employmentType: "UNKNOWN" as const,
    experienceLevel: "UNKNOWN" as const,
    description,
    shortSummary: description.slice(0, 280),
    industry: null,
    roleFamily: "Unknown",
    applyUrl: sourceJob.applyUrl,
    applyUrlKey: dedupeFields.applyUrlKey,
    postedAt: sourceJob.postedAt ?? fetchedAt,
    deadline: sourceJob.deadline,
    duplicateClusterId: dedupeFields.duplicateClusterId,
  };
}

export async function upsertNormalizedJobRecordFromSourceJob(input: {
  rawJobId: string;
  rawSourceName: string;
  rawSourceId: string;
  rawPayload: Prisma.JsonValue;
  fetchedAt: Date;
}) {
  const sourceJob = parseSourceConnectorJobFromRawPayload({
    sourceName: input.rawSourceName,
    sourceId: input.rawSourceId,
    rawPayload: input.rawPayload,
  });
  const normalizationResult = normalizeSourceJob({
    job: sourceJob,
    fetchedAt: input.fetchedAt,
  });
  const sourceIdentity = deriveSourceIdentitySnapshot({
    sourceName: input.rawSourceName,
    sourceId: input.rawSourceId,
    sourceUrl: sourceJob.sourceUrl,
    applyUrl: sourceJob.applyUrl,
    metadata: sourceJob.metadata,
  });
  const sourceLifecycle = deriveSourceLifecycleSnapshot({
    sourceName: input.rawSourceName,
    sourceUrl: sourceJob.sourceUrl,
    applyUrl: sourceJob.applyUrl,
    freshnessMode: inferFreshnessModeFromSourceName(input.rawSourceName),
  });

  if (normalizationResult.kind === "rejected") {
    const rejected = buildRejectedNormalizedRecordData(sourceJob, input.fetchedAt);
    const trustScore = computeTrustScore({
      sourceReliability: sourceLifecycle.sourceReliability,
      sourceType: sourceLifecycle.sourceType,
      sourceQualityKind: sourceIdentity.sourceQualityKind,
      sourceCount: 1,
    });

    return prisma.normalizedJobRecord.upsert({
      where: { rawJobId: input.rawJobId },
      create: {
        rawJobId: input.rawJobId,
        status: "REJECTED",
        normalizationVersion: "v2-staged",
        rejectionReason: normalizationResult.reason,
        integrityReason: normalizationResult.reason,
        qualityScore: 0,
        trustScore,
        freshnessScore: 0,
        ...rejected,
        metadataJson:
          sourceJob.metadata != null
            ? (sourceJob.metadata as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
      update: {
        status: "REJECTED",
        normalizationVersion: "v2-staged",
        rejectionReason: normalizationResult.reason,
        integrityReason: normalizationResult.reason,
        qualityScore: 0,
        trustScore,
        freshnessScore: 0,
        ...rejected,
        metadataJson:
          sourceJob.metadata != null
            ? (sourceJob.metadata as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
  }

  const trustScore = computeTrustScore({
    sourceReliability: sourceLifecycle.sourceReliability,
    sourceType: sourceLifecycle.sourceType,
    sourceQualityKind: sourceIdentity.sourceQualityKind,
    sourceCount: 1,
  });

  return prisma.normalizedJobRecord.upsert({
    where: { rawJobId: input.rawJobId },
    create: {
      rawJobId: input.rawJobId,
      status: "VALIDATED",
      normalizationVersion: "v2-staged",
      qualityScore: computeNormalizedQualityScore(normalizationResult.job),
      trustScore,
      freshnessScore: 100,
      ...normalizationResult.job,
      metadataJson:
        sourceJob.metadata != null
          ? (sourceJob.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
    },
    update: {
      status: "VALIDATED",
      normalizationVersion: "v2-staged",
      rejectionReason: null,
      integrityReason: null,
      qualityScore: computeNormalizedQualityScore(normalizationResult.job),
      trustScore,
      freshnessScore: 100,
      ...normalizationResult.job,
      metadataJson:
        sourceJob.metadata != null
          ? (sourceJob.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
    },
  });
}

export async function upsertNormalizedJobRecordFromRawJob(rawJobId: string) {
  const rawJob = await prisma.jobRaw.findUniqueOrThrow({
    where: { id: rawJobId },
  });

  return upsertNormalizedJobRecordFromSourceJob({
    rawJobId,
    rawSourceName: rawJob.sourceName,
    rawSourceId: rawJob.sourceId,
    rawPayload: rawJob.rawPayload,
    fetchedAt: rawJob.fetchedAt,
  });
}
