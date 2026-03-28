import { prisma } from "@/lib/db";
import { buildEligibilityDraft } from "@/lib/ingestion/classify";
import {
  backfillCanonicalDedupeFields,
  findCrossSourceCanonicalMatch,
  isCanonicalMatchCompatible,
  type CanonicalMatchCandidate,
} from "@/lib/ingestion/dedupe";
import { normalizeSourceJob } from "@/lib/ingestion/normalize";
import type {
  IngestionSummary,
  NormalizedJobInput,
  SourceConnector,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import type {
  IngestionRunMode,
  IngestionRunStatus,
  JobStatus,
  Prisma,
} from "@/generated/prisma/client";

const LIVE_WINDOW_DAYS = 7;
const STALE_WINDOW_DAYS = 21;
const RUNNING_LOCK_WINDOW_MINUTES = 90;

type IngestConnectorOptions = {
  now?: Date;
  limit?: number;
  runMode?: IngestionRunMode;
  allowOverlappingRuns?: boolean;
  triggerLabel?: string;
  scheduleCadenceMinutes?: number | null;
};

export async function previewConnectorIngestion(
  connector: SourceConnector,
  options: Pick<IngestConnectorOptions, "now" | "limit" | "runMode"> = {}
): Promise<IngestionSummary> {
  const startedAt = options.now ?? new Date();
  const runMode = options.runMode ?? "MANUAL";
  const summary = createEmptySummary(connector, {
    runId: `preview:${connector.key}`,
    runMode,
    status: "SUCCESS",
  });

  await performConnectorPreview(connector, summary, startedAt, options.limit);

  return summary;
}

type CanonicalStatusSnapshot = {
  id: string;
  status: JobStatus;
  lastSeenAt: Date;
  deadline: Date | null;
  staleAt: Date | null;
  expiredAt: Date | null;
  removedAt: Date | null;
  sourceMappings: Array<{
    lastSeenAt: Date;
    removedAt: Date | null;
  }>;
};

type CanonicalStatusRefreshResult = {
  status: JobStatus;
  updated: boolean;
};

type CanonicalStatusTally = {
  liveCount: number;
  staleCount: number;
  expiredCount: number;
  removedCount: number;
  updatedCount: number;
};

export async function ingestConnector(
  connector: SourceConnector,
  options: IngestConnectorOptions = {}
): Promise<IngestionSummary> {
  const startedAt = options.now ?? new Date();
  const runMode = options.runMode ?? "MANUAL";
  const run = await createIngestionRun({
    connector,
    startedAt,
    runMode,
    runOptions: buildRunOptions(options),
    allowOverlappingRuns: options.allowOverlappingRuns ?? false,
  });

  const summary = createEmptySummary(connector, {
    runId: run.id,
    runMode,
    status: run.status,
  });

  if (run.status === "SKIPPED") {
    summary.skippedReasons.overlapping_run = 1;
    return summary;
  }

  try {
    await backfillCanonicalDedupeFields();
    await performConnectorIngestion(connector, summary, startedAt, options.limit);
    summary.status = "SUCCESS";

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: buildRunUpdateData(summary, "SUCCESS", new Date(), null),
    });

    return summary;
  } catch (error) {
    summary.status = "FAILED";

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: buildRunUpdateData(summary, "FAILED", new Date(), getErrorSummary(error)),
    });

    throw error;
  }
}

export async function reconcileCanonicalLifecycle(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const canonicalJobs = await prisma.jobCanonical.findMany({
    select: { id: true },
  });

  return refreshCanonicalStatuses(
    canonicalJobs.map((job) => job.id),
    now
  );
}

async function createIngestionRun({
  connector,
  startedAt,
  runMode,
  runOptions,
  allowOverlappingRuns,
}: {
  connector: SourceConnector;
  startedAt: Date;
  runMode: IngestionRunMode;
  runOptions: Prisma.InputJsonValue;
  allowOverlappingRuns: boolean;
}) {
  if (!allowOverlappingRuns) {
    const overlapCutoff = new Date(
      startedAt.getTime() - RUNNING_LOCK_WINDOW_MINUTES * 60 * 1000
    );

    const overlappingRun = await prisma.ingestionRun.findFirst({
      where: {
        connectorKey: connector.key,
        status: "RUNNING",
        startedAt: { gte: overlapCutoff },
      },
      orderBy: { startedAt: "desc" },
    });

    if (overlappingRun) {
      return prisma.ingestionRun.create({
        data: {
          connectorKey: connector.key,
          sourceName: connector.sourceName,
          sourceTier: connector.sourceTier,
          runMode,
          status: "SKIPPED",
          startedAt,
          endedAt: startedAt,
          runOptions,
          errorSummary: `Skipped due to overlapping run ${overlappingRun.id}`,
        },
      });
    }
  }

  return prisma.ingestionRun.create({
    data: {
      connectorKey: connector.key,
      sourceName: connector.sourceName,
      sourceTier: connector.sourceTier,
      runMode,
      status: "RUNNING",
      startedAt,
      runOptions,
    },
  });
}

async function performConnectorIngestion(
  connector: SourceConnector,
  summary: IngestionSummary,
  now: Date,
  limit?: number
) {
  const seenSourceIds = new Set<string>();
  const freshnessCandidateIds = new Set<string>();
  const shouldRunFreshnessRemoval =
    connector.freshnessMode === "FULL_SNAPSHOT" && limit === undefined;

  const fetchResult = await connector.fetchJobs({
    now,
    limit,
  });

  for (const sourceJob of fetchResult.jobs) {
    summary.fetchedCount += 1;
    seenSourceIds.add(sourceJob.sourceId);

    const rawJobResult = await upsertRawJob({
      connector,
      sourceJob,
      fetchedAt: now,
    });

    if (rawJobResult.created) {
      summary.rawCreatedCount += 1;
    } else {
      summary.rawUpdatedCount += 1;
    }

    const normalizationResult = normalizeSourceJob({
      job: sourceJob,
      fetchedAt: now,
    });

    if (normalizationResult.kind === "rejected") {
      summary.rejectedCount += 1;
      summary.skippedReasons[normalizationResult.reason] =
        (summary.skippedReasons[normalizationResult.reason] ?? 0) + 1;
      continue;
    }

    summary.acceptedCount += 1;

    const mappedCanonical = await findMappedCanonical(rawJobResult.rawJob.id);
    const compatibleMappedCanonical =
      mappedCanonical &&
      isCanonicalMatchCompatible(normalizationResult.job, mappedCanonical.canonical)
        ? mappedCanonical
        : null;
    const crossSourceMatch = compatibleMappedCanonical
      ? null
      : await findCrossSourceCanonicalMatch(normalizationResult.job);
    const canonicalMatch = compatibleMappedCanonical ?? crossSourceMatch;

    if (canonicalMatch && canonicalMatch.matchedBy !== "rawJob") {
      summary.dedupedCount += 1;
    }

    const canonicalResult = await upsertCanonicalJob({
      currentCanonical: canonicalMatch?.canonical ?? null,
      normalizedJob: normalizationResult.job,
      now,
    });

    freshnessCandidateIds.add(canonicalResult.id);

    if (canonicalResult.created) {
      summary.canonicalCreatedCount += 1;
    } else {
      summary.canonicalUpdatedCount += 1;
    }

    const mappingResult = await upsertSourceMapping({
      canonicalId: canonicalResult.id,
      connector,
      rawJobId: rawJobResult.rawJob.id,
      sourceUrl: sourceJob.sourceUrl,
      now,
    });

    if (mappingResult.created) {
      summary.sourceMappingCreatedCount += 1;
    } else {
      summary.sourceMappingUpdatedCount += 1;
    }

    await upsertEligibility(canonicalResult.id, normalizationResult.job, connector.sourceName);
  }

  if (shouldRunFreshnessRemoval) {
    const removalResult = await markMissingSourceMappingsRemoved({
      connectorSourceName: connector.sourceName,
      seenSourceIds: [...seenSourceIds],
      now,
    });

    summary.sourceMappingsRemovedCount = removalResult.removedMappingCount;

    for (const canonicalId of removalResult.canonicalIds) {
      freshnessCandidateIds.add(canonicalId);
    }
  }

  const statusTally = await refreshCanonicalStatuses([...freshnessCandidateIds], now);
  summary.liveCount = statusTally.liveCount;
  summary.staleCount = statusTally.staleCount;
  summary.expiredCount = statusTally.expiredCount;
  summary.removedCount = statusTally.removedCount;
}

async function performConnectorPreview(
  connector: SourceConnector,
  summary: IngestionSummary,
  now: Date,
  limit?: number
) {
  const fetchResult = await connector.fetchJobs({
    now,
    limit,
  });

  for (const sourceJob of fetchResult.jobs) {
    summary.fetchedCount += 1;

    const existingRawJob = await prisma.jobRaw.findUnique({
      where: {
        sourceName_sourceId: {
          sourceName: connector.sourceName,
          sourceId: sourceJob.sourceId,
        },
      },
      select: { id: true },
    });

    if (existingRawJob) {
      summary.rawUpdatedCount += 1;
    } else {
      summary.rawCreatedCount += 1;
    }

    const normalizationResult = normalizeSourceJob({
      job: sourceJob,
      fetchedAt: now,
    });

    if (normalizationResult.kind === "rejected") {
      summary.rejectedCount += 1;
      summary.skippedReasons[normalizationResult.reason] =
        (summary.skippedReasons[normalizationResult.reason] ?? 0) + 1;
      continue;
    }

    summary.acceptedCount += 1;

    const mappedCanonical = existingRawJob
      ? await findMappedCanonical(existingRawJob.id)
      : null;
    const compatibleMappedCanonical =
      mappedCanonical &&
      isCanonicalMatchCompatible(normalizationResult.job, mappedCanonical.canonical)
        ? mappedCanonical
        : null;
    const crossSourceMatch = compatibleMappedCanonical
      ? null
      : await findCrossSourceCanonicalMatch(normalizationResult.job);
    const canonicalMatch = compatibleMappedCanonical ?? crossSourceMatch;

    if (canonicalMatch && canonicalMatch.matchedBy !== "rawJob") {
      summary.dedupedCount += 1;
    }

    if (canonicalMatch) {
      summary.canonicalUpdatedCount += 1;
    } else {
      summary.canonicalCreatedCount += 1;
    }

    const existingMapping = existingRawJob
      ? await prisma.jobSourceMapping.findFirst({
          where: { rawJobId: existingRawJob.id },
          select: { id: true },
        })
      : null;

    if (existingMapping) {
      summary.sourceMappingUpdatedCount += 1;
    } else {
      summary.sourceMappingCreatedCount += 1;
    }
  }
}

function createEmptySummary(
  connector: SourceConnector,
  run: {
    runId: string;
    runMode: IngestionRunMode;
    status: IngestionRunStatus;
  }
): IngestionSummary {
  return {
    runId: run.runId,
    runMode: run.runMode,
    status: run.status,
    connectorKey: connector.key,
    sourceName: connector.sourceName,
    sourceTier: connector.sourceTier,
    freshnessMode: connector.freshnessMode,
    fetchedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    rawCreatedCount: 0,
    rawUpdatedCount: 0,
    canonicalCreatedCount: 0,
    canonicalUpdatedCount: 0,
    dedupedCount: 0,
    sourceMappingCreatedCount: 0,
    sourceMappingUpdatedCount: 0,
    sourceMappingsRemovedCount: 0,
    liveCount: 0,
    staleCount: 0,
    expiredCount: 0,
    removedCount: 0,
    skippedReasons: {},
  };
}

function buildRunOptions(options: Omit<IngestConnectorOptions, "now" | "runMode">) {
  return {
    limit: options.limit ?? null,
    triggerLabel: options.triggerLabel ?? null,
    scheduleCadenceMinutes: options.scheduleCadenceMinutes ?? null,
  } as Prisma.InputJsonValue;
}

function buildRunUpdateData(
  summary: IngestionSummary,
  status: IngestionRunStatus,
  endedAt: Date,
  errorSummary: string | null
) {
  return {
    status,
    endedAt,
    fetchedCount: summary.fetchedCount,
    acceptedCount: summary.acceptedCount,
    rejectedCount: summary.rejectedCount,
    rawCreatedCount: summary.rawCreatedCount,
    rawUpdatedCount: summary.rawUpdatedCount,
    canonicalCreatedCount: summary.canonicalCreatedCount,
    canonicalUpdatedCount: summary.canonicalUpdatedCount,
    dedupedCount: summary.dedupedCount,
    sourceMappingCreatedCount: summary.sourceMappingCreatedCount,
    sourceMappingUpdatedCount: summary.sourceMappingUpdatedCount,
    sourceMappingsRemovedCount: summary.sourceMappingsRemovedCount,
    liveCount: summary.liveCount,
    staleCount: summary.staleCount,
    expiredCount: summary.expiredCount,
    removedCount: summary.removedCount,
    skippedReasons: summary.skippedReasons as Prisma.InputJsonValue,
    errorSummary,
  } satisfies Prisma.IngestionRunUncheckedUpdateInput;
}

async function upsertRawJob({
  connector,
  sourceJob,
  fetchedAt,
}: {
  connector: SourceConnector;
  sourceJob: SourceConnectorJob;
  fetchedAt: Date;
}) {
  const existingRawJob = await prisma.jobRaw.findUnique({
    where: {
      sourceName_sourceId: {
        sourceName: connector.sourceName,
        sourceId: sourceJob.sourceId,
      },
    },
  });

  const data = {
    sourceId: sourceJob.sourceId,
    sourceName: connector.sourceName,
    sourceTier: connector.sourceTier,
    fetchedAt,
    rawPayload: buildRawPayload(sourceJob, fetchedAt),
  } satisfies Prisma.JobRawUncheckedCreateInput;

  if (existingRawJob) {
    const rawJob = await prisma.jobRaw.update({
      where: { id: existingRawJob.id },
      data,
    });
    return { rawJob, created: false as const };
  }

  const rawJob = await prisma.jobRaw.create({ data });
  return { rawJob, created: true as const };
}

async function findMappedCanonical(rawJobId: string) {
  const mappingMatch = await prisma.jobSourceMapping.findFirst({
    where: { rawJobId },
    include: {
      canonicalJob: {
        select: canonicalMatchSelect,
      },
    },
  });

  if (!mappingMatch) return null;

  return {
    matchedBy: "rawJob" as const,
    canonical: mappingMatch.canonicalJob,
    score: 100,
  };
}

const canonicalMatchSelect = {
  id: true,
  applyUrl: true,
  description: true,
  shortSummary: true,
  postedAt: true,
  deadline: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  companyKey: true,
  titleKey: true,
  titleCoreKey: true,
  descriptionFingerprint: true,
  locationKey: true,
  applyUrlKey: true,
  roleFamily: true,
  workMode: true,
} as const;

async function upsertCanonicalJob({
  currentCanonical,
  normalizedJob,
  now,
}: {
  currentCanonical: CanonicalMatchCandidate | null;
  normalizedJob: NormalizedJobInput;
  now: Date;
}) {
  if (!currentCanonical) {
    const canonicalJob = await prisma.jobCanonical.create({
      data: {
        ...normalizedJob,
        status: "LIVE",
        lastSeenAt: now,
        staleAt: null,
        expiredAt: null,
        removedAt: null,
      },
    });

    return {
      id: canonicalJob.id,
      created: true as const,
    };
  }

  const canonicalJob = await prisma.jobCanonical.update({
    where: { id: currentCanonical.id },
    data: {
      title: normalizedJob.title,
      company: normalizedJob.company,
      companyKey: normalizedJob.companyKey,
      titleKey: normalizedJob.titleKey,
      titleCoreKey: normalizedJob.titleCoreKey,
      descriptionFingerprint:
        normalizedJob.descriptionFingerprint || currentCanonical.descriptionFingerprint,
      location: normalizedJob.location,
      locationKey: normalizedJob.locationKey,
      region: normalizedJob.region,
      workMode: normalizedJob.workMode,
      salaryMin: chooseNumericValue(normalizedJob.salaryMin, currentCanonical.salaryMin),
      salaryMax: chooseNumericValue(normalizedJob.salaryMax, currentCanonical.salaryMax),
      salaryCurrency: normalizedJob.salaryCurrency ?? currentCanonical.salaryCurrency,
      employmentType: normalizedJob.employmentType,
      experienceLevel: normalizedJob.experienceLevel,
      description: chooseLongerText(normalizedJob.description, currentCanonical.description),
      // Always prefer the freshly-computed shortSummary: it uses the current
      // buildShortSummary logic which skips section headers like "ABOUT THE ROLE".
      // chooseLongerText would keep the old (longer) header-prefixed value.
      shortSummary: normalizedJob.shortSummary,
      industry: normalizedJob.industry,
      roleFamily: normalizedJob.roleFamily,
      applyUrl: choosePreferredUrl(normalizedJob.applyUrl, currentCanonical.applyUrl),
      applyUrlKey: normalizedJob.applyUrlKey ?? currentCanonical.applyUrlKey,
      postedAt: chooseEarlierDate(currentCanonical.postedAt, normalizedJob.postedAt),
      deadline: choosePreferredDeadline(currentCanonical.deadline, normalizedJob.deadline),
      duplicateClusterId: normalizedJob.duplicateClusterId,
      status: "LIVE",
      lastSeenAt: now,
      staleAt: null,
      expiredAt: null,
      removedAt: null,
    },
  });

  return {
    id: canonicalJob.id,
    created: false as const,
  };
}

async function upsertSourceMapping({
  canonicalId,
  connector,
  rawJobId,
  sourceUrl,
  now,
}: {
  canonicalId: string;
  connector: SourceConnector;
  rawJobId: string;
  sourceUrl: string | null;
  now: Date;
}) {
  const existingMapping = await prisma.jobSourceMapping.findFirst({
    where: { rawJobId },
  });

  if (existingMapping) {
    const hasAnyActivePrimary = await prisma.jobSourceMapping.count({
      where: {
        canonicalJobId: canonicalId,
        isPrimary: true,
        removedAt: null,
      },
    });

    await prisma.jobSourceMapping.update({
      where: { id: existingMapping.id },
      data: {
        canonicalJobId: canonicalId,
        sourceName: connector.sourceName,
        sourceUrl,
        lastSeenAt: now,
        removedAt: null,
        isPrimary: existingMapping.isPrimary || hasAnyActivePrimary === 0,
      },
    });

    return { created: false as const };
  }

  const hasAnyActivePrimary = await prisma.jobSourceMapping.count({
    where: {
      canonicalJobId: canonicalId,
      isPrimary: true,
      removedAt: null,
    },
  });

  await prisma.jobSourceMapping.create({
    data: {
      canonicalJobId: canonicalId,
      rawJobId,
      sourceName: connector.sourceName,
      sourceUrl,
      isPrimary: hasAnyActivePrimary === 0,
      lastSeenAt: now,
      removedAt: null,
    },
  });

  return { created: true as const };
}

async function upsertEligibility(
  canonicalJobId: string,
  normalizedJob: NormalizedJobInput,
  sourceName: string
) {
  const eligibilityDraft = buildEligibilityDraft({
    job: normalizedJob,
    sourceName,
  });

  await prisma.jobEligibility.upsert({
    where: { canonicalJobId },
    create: {
      canonicalJobId,
      ...eligibilityDraft,
    },
    update: eligibilityDraft,
  });
}

async function markMissingSourceMappingsRemoved({
  connectorSourceName,
  seenSourceIds,
  now,
}: {
  connectorSourceName: string;
  seenSourceIds: string[];
  now: Date;
}) {
  const missingMappings = await prisma.jobSourceMapping.findMany({
    where: {
      sourceName: connectorSourceName,
      removedAt: null,
      ...(seenSourceIds.length > 0
        ? {
            rawJob: {
              sourceId: {
                notIn: seenSourceIds,
              },
            },
          }
        : {}),
    },
    select: {
      id: true,
      canonicalJobId: true,
    },
  });

  if (missingMappings.length === 0) {
    return {
      removedMappingCount: 0,
      canonicalIds: [] as string[],
    };
  }

  await prisma.jobSourceMapping.updateMany({
    where: {
      id: {
        in: missingMappings.map((mapping) => mapping.id),
      },
    },
    data: {
      removedAt: now,
    },
  });

  return {
    removedMappingCount: missingMappings.length,
    canonicalIds: [...new Set(missingMappings.map((mapping) => mapping.canonicalJobId))],
  };
}

async function refreshCanonicalStatuses(canonicalIds: string[], now: Date) {
  const uniqueCanonicalIds = [...new Set(canonicalIds)];
  const tally: CanonicalStatusTally = {
    liveCount: 0,
    staleCount: 0,
    expiredCount: 0,
    removedCount: 0,
    updatedCount: 0,
  };

  for (const canonicalId of uniqueCanonicalIds) {
    const result = await refreshCanonicalStatus(canonicalId, now);
    if (result.status === "LIVE") tally.liveCount += 1;
    if (result.status === "STALE") tally.staleCount += 1;
    if (result.status === "EXPIRED") tally.expiredCount += 1;
    if (result.status === "REMOVED") tally.removedCount += 1;
    if (result.updated) tally.updatedCount += 1;
  }

  return tally;
}

async function refreshCanonicalStatus(
  canonicalId: string,
  now: Date
): Promise<CanonicalStatusRefreshResult> {
  const canonicalJob = await prisma.jobCanonical.findUnique({
    where: { id: canonicalId },
    select: {
      id: true,
      status: true,
      lastSeenAt: true,
      deadline: true,
      staleAt: true,
      expiredAt: true,
      removedAt: true,
      sourceMappings: {
        select: {
          lastSeenAt: true,
          removedAt: true,
        },
      },
    },
  });

  if (!canonicalJob) {
    throw new Error(`Canonical job ${canonicalId} not found while refreshing freshness`);
  }

  return refreshCanonicalStatusFromSnapshot(canonicalJob, now);
}

async function refreshCanonicalStatusFromSnapshot(
  canonicalJob: CanonicalStatusSnapshot,
  now: Date
): Promise<CanonicalStatusRefreshResult> {
  const activeMappings = canonicalJob.sourceMappings.filter(
    (sourceMapping) => sourceMapping.removedAt === null
  );
  const removedMappingsCount = canonicalJob.sourceMappings.length - activeMappings.length;
  const latestSeenAt = canonicalJob.sourceMappings.reduce<Date>(
    (currentLatestSeenAt, sourceMapping) =>
      sourceMapping.lastSeenAt > currentLatestSeenAt
        ? sourceMapping.lastSeenAt
        : currentLatestSeenAt,
    canonicalJob.lastSeenAt
  );

  const nextStatus = determineCanonicalStatus({
    activeMappingsCount: activeMappings.length,
    removedMappingsCount,
    deadline: canonicalJob.deadline,
    latestSeenAt,
    now,
  });

  const nextLifecycleData = buildLifecycleUpdateData({
    nextStatus,
    currentStatus: canonicalJob.status,
    currentStaleAt: canonicalJob.staleAt,
    currentExpiredAt: canonicalJob.expiredAt,
    currentRemovedAt: canonicalJob.removedAt,
    latestSeenAt,
    now,
  });

  const shouldUpdate =
    nextStatus !== canonicalJob.status ||
    latestSeenAt.getTime() !== canonicalJob.lastSeenAt.getTime() ||
    !sameNullableDate(nextLifecycleData.staleAt, canonicalJob.staleAt) ||
    !sameNullableDate(nextLifecycleData.expiredAt, canonicalJob.expiredAt) ||
    !sameNullableDate(nextLifecycleData.removedAt, canonicalJob.removedAt);

  if (shouldUpdate) {
    await prisma.jobCanonical.update({
      where: { id: canonicalJob.id },
      data: nextLifecycleData,
    });
  }

  return {
    status: nextStatus,
    updated: shouldUpdate,
  };
}

function determineCanonicalStatus({
  activeMappingsCount,
  removedMappingsCount,
  deadline,
  latestSeenAt,
  now,
}: {
  activeMappingsCount: number;
  removedMappingsCount: number;
  deadline: Date | null;
  latestSeenAt: Date;
  now: Date;
}): JobStatus {
  if (deadline && deadline.getTime() < now.getTime()) {
    return "EXPIRED";
  }

  if (activeMappingsCount === 0 && removedMappingsCount > 0) {
    return "REMOVED";
  }

  if (activeMappingsCount === 0) {
    return "EXPIRED";
  }

  const liveCutoff = new Date(now.getTime() - LIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const staleCutoff = new Date(now.getTime() - STALE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (latestSeenAt.getTime() >= liveCutoff.getTime()) {
    return "LIVE";
  }

  if (latestSeenAt.getTime() >= staleCutoff.getTime()) {
    return "STALE";
  }

  return "EXPIRED";
}

function buildLifecycleUpdateData({
  nextStatus,
  currentStatus,
  currentStaleAt,
  currentExpiredAt,
  currentRemovedAt,
  latestSeenAt,
  now,
}: {
  nextStatus: JobStatus;
  currentStatus: JobStatus;
  currentStaleAt: Date | null;
  currentExpiredAt: Date | null;
  currentRemovedAt: Date | null;
  latestSeenAt: Date;
  now: Date;
}) {
  return {
    status: nextStatus,
    lastSeenAt: latestSeenAt,
    staleAt:
      nextStatus === "STALE"
        ? currentStatus === "STALE"
          ? currentStaleAt
          : now
        : null,
    expiredAt:
      nextStatus === "EXPIRED"
        ? currentStatus === "EXPIRED"
          ? currentExpiredAt
          : now
        : null,
    removedAt:
      nextStatus === "REMOVED"
        ? currentStatus === "REMOVED"
          ? currentRemovedAt
          : now
        : null,
  } satisfies Prisma.JobCanonicalUncheckedUpdateInput;
}

function buildRawPayload(sourceJob: SourceConnectorJob, fetchedAt: Date) {
  return {
    title: sourceJob.title,
    company: sourceJob.company,
    location: sourceJob.location,
    description: sourceJob.description,
    applyUrl: sourceJob.applyUrl,
    sourceUrl: sourceJob.sourceUrl,
    postedAt: sourceJob.postedAt?.toISOString() ?? null,
    deadline: sourceJob.deadline?.toISOString() ?? null,
    salaryMin: sourceJob.salaryMin,
    salaryMax: sourceJob.salaryMax,
    salaryCurrency: sourceJob.salaryCurrency,
    fetchedAt: fetchedAt.toISOString(),
    metadata: sourceJob.metadata,
  } as Prisma.InputJsonValue;
}

function chooseNumericValue(nextValue: number | null, currentValue: number | null) {
  return nextValue ?? currentValue;
}

function chooseEarlierDate(currentValue: Date, nextValue: Date) {
  return currentValue.getTime() <= nextValue.getTime() ? currentValue : nextValue;
}

function choosePreferredDeadline(
  currentValue: Date | null,
  nextValue: Date | null
): Date | null {
  if (!currentValue) return nextValue;
  if (!nextValue) return currentValue;
  return currentValue.getTime() <= nextValue.getTime() ? currentValue : nextValue;
}

function chooseLongerText(nextValue: string, currentValue: string) {
  if (nextValue.trim().length >= currentValue.trim().length) return nextValue;
  return currentValue;
}

function choosePreferredUrl(nextValue: string, currentValue: string) {
  const normalizedNextValue = nextValue.trim();
  if (!normalizedNextValue) return currentValue;

  try {
    const nextUrl = new URL(normalizedNextValue);
    const currentUrl = new URL(currentValue);

    if (currentUrl.hostname.includes("greenhouse.io") && !nextUrl.hostname.includes("greenhouse.io")) {
      return normalizedNextValue;
    }

    if (currentUrl.hostname.includes("lever.co") && !nextUrl.hostname.includes("lever.co")) {
      return normalizedNextValue;
    }
  } catch {
    return normalizedNextValue;
  }

  return normalizedNextValue;
}

function sameNullableDate(left: Date | null, right: Date | null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

function getErrorSummary(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 1000);
  }

  return String(error).slice(0, 1000);
}
