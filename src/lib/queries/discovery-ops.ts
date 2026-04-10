import { prisma } from "@/lib/db";

export async function getDiscoveryOpsOverview() {
  const [
    companyCounts,
    sourceCounts,
    taskCounts,
    companyDiscoveredCount,
    totalSourceCount,
    sourceUnvalidatedCount,
    sourceValidatedCount,
    sourceReadyCount,
    sourceTrackedPollCount,
    sourcePolledSuccessfullyCount,
    sourceYieldedJobsCount,
    sourceYieldedRetainedLiveJobsCount,
    recentCompanies,
    recentSources,
    vendorSources,
  ] = await Promise.all([
    prisma.company.groupBy({
      by: ["discoveryStatus"],
      _count: { _all: true },
    }),
    prisma.companySource.groupBy({
      by: ["status", "validationState", "pollState", "extractionRoute"],
      _count: { _all: true },
    }),
    prisma.sourceTask.groupBy({
      by: ["kind", "status"],
      _count: { _all: true },
    }),
    prisma.company.count({
      where: {
        discoveryStatus: { in: ["DISCOVERING", "DISCOVERED", "NEEDS_REVIEW"] },
      },
    }),
    prisma.companySource.count(),
    prisma.companySource.count({
      where: { validationState: "UNVALIDATED" },
    }),
    prisma.companySource.count({
      where: { validationState: "VALIDATED" },
    }),
    prisma.companySource.count({
      where: {
        validationState: "VALIDATED",
        pollState: "READY",
      },
    }),
    prisma.companySource.count({
      where: {
        pollAttemptCount: { gt: 0 },
      },
    }),
    prisma.companySource.count({
      where: { lastSuccessfulPollAt: { not: null } },
    }),
    prisma.companySource.count({
      where: { jobsFetchedCount: { gt: 0 } },
    }),
    prisma.companySource.count({
      where: { retainedLiveJobCount: { gt: 0 } },
    }),
    prisma.company.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: 25,
      select: {
        id: true,
        name: true,
        domain: true,
        careersUrl: true,
        discoveryStatus: true,
        crawlStatus: true,
        detectedAts: true,
        discoveryConfidence: true,
        lastDiscoveryAt: true,
        lastSuccessfulPollAt: true,
        lastDiscoveryError: true,
        _count: {
          select: {
            jobs: true,
            sources: true,
            discoveryPages: true,
          },
        },
      },
    }),
    prisma.companySource.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: 25,
      select: {
        id: true,
        sourceName: true,
        connectorName: true,
        boardUrl: true,
        status: true,
        validationState: true,
        pollState: true,
        sourceType: true,
        extractionRoute: true,
        parserVersion: true,
        pollingCadenceMinutes: true,
        priorityScore: true,
        sourceQualityScore: true,
        yieldScore: true,
        cooldownUntil: true,
        lastValidatedAt: true,
        lastSuccessfulPollAt: true,
        lastFailureAt: true,
        lastHttpStatus: true,
        validationAttemptCount: true,
        validationSuccessCount: true,
        pollAttemptCount: true,
        pollSuccessCount: true,
        jobsFetchedCount: true,
        jobsAcceptedCount: true,
        jobsDedupedCount: true,
        jobsCreatedCount: true,
        retainedLiveJobCount: true,
        lastJobsFetchedCount: true,
        lastJobsAcceptedCount: true,
        lastJobsDedupedCount: true,
        lastJobsCreatedCount: true,
        consecutiveFailures: true,
        failureStreak: true,
        overlapRatio: true,
        validationMessage: true,
        company: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.companySource.findMany({
      select: {
        connectorName: true,
        sourceQualityScore: true,
        yieldScore: true,
        validationAttemptCount: true,
        validationSuccessCount: true,
        pollAttemptCount: true,
        pollSuccessCount: true,
        jobsFetchedCount: true,
        jobsAcceptedCount: true,
        jobsCreatedCount: true,
        retainedLiveJobCount: true,
      },
    }),
  ]);

  const sourceFunnel = {
    companiesDiscovered: companyDiscoveredCount,
    sourcesProvisioned: totalSourceCount,
    sourcesUnvalidated: sourceUnvalidatedCount,
    sourcesValidated: sourceValidatedCount,
    sourcesReady: sourceReadyCount,
    sourcesTrackedPolls: sourceTrackedPollCount,
    sourcesPolledSuccessfully: sourcePolledSuccessfullyCount,
    sourcesYieldedJobs: sourceYieldedJobsCount,
    sourcesYieldedRetainedLiveJobs: sourceYieldedRetainedLiveJobsCount,
  };

  const vendorAccumulator = new Map<
    string,
    {
      sourceCount: number;
      trackedSourceCount: number;
      successfulSourceCount: number;
      sourceQualityScoreTotal: number;
      yieldScoreTotal: number;
      validationAttemptCount: number;
      validationSuccessCount: number;
      pollAttemptCount: number;
      pollSuccessCount: number;
      jobsFetched: number;
      jobsAccepted: number;
      jobsCreated: number;
      retainedLiveJobs: number;
      trackedRetainedLiveJobs: number;
    }
  >();

  for (const source of vendorSources) {
    const current = vendorAccumulator.get(source.connectorName) ?? {
      sourceCount: 0,
      trackedSourceCount: 0,
      successfulSourceCount: 0,
      sourceQualityScoreTotal: 0,
      yieldScoreTotal: 0,
      validationAttemptCount: 0,
      validationSuccessCount: 0,
      pollAttemptCount: 0,
      pollSuccessCount: 0,
      jobsFetched: 0,
      jobsAccepted: 0,
      jobsCreated: 0,
      retainedLiveJobs: 0,
      trackedRetainedLiveJobs: 0,
    };

    current.sourceCount += 1;
    if (source.pollAttemptCount > 0) current.trackedSourceCount += 1;
    if (source.pollSuccessCount > 0) current.successfulSourceCount += 1;
    current.sourceQualityScoreTotal += source.sourceQualityScore;
    current.yieldScoreTotal += source.yieldScore;
    current.validationAttemptCount += source.validationAttemptCount;
    current.validationSuccessCount += source.validationSuccessCount;
    current.pollAttemptCount += source.pollAttemptCount;
    current.pollSuccessCount += source.pollSuccessCount;
    current.jobsFetched += source.jobsFetchedCount;
    current.jobsAccepted += source.jobsAcceptedCount;
    current.jobsCreated += source.jobsCreatedCount;
    current.retainedLiveJobs += source.retainedLiveJobCount;
    if (source.pollAttemptCount > 0) {
      current.trackedRetainedLiveJobs += source.retainedLiveJobCount;
    }

    vendorAccumulator.set(source.connectorName, current);
  }

  const vendorPerformance = [...vendorAccumulator.entries()]
    .map(([connectorName, row]) => {
      const validationAttempts = row.validationAttemptCount;
      const validationSuccesses = row.validationSuccessCount;
      const pollAttempts = row.pollAttemptCount;
      const pollSuccesses = row.pollSuccessCount;

      return {
        connectorName,
        sourceCount: row.sourceCount,
        trackedSourceCount: row.trackedSourceCount,
        successfulSourceCount: row.successfulSourceCount,
        averageSourceQualityScore:
          row.sourceCount > 0 ? row.sourceQualityScoreTotal / row.sourceCount : 0,
        averageYieldScore: row.sourceCount > 0 ? row.yieldScoreTotal / row.sourceCount : 0,
        validationSuccessRate:
          validationAttempts > 0 ? validationSuccesses / validationAttempts : 0,
        pollSuccessRate: pollAttempts > 0 ? pollSuccesses / pollAttempts : 0,
        jobsFetched: row.jobsFetched,
        jobsAccepted: row.jobsAccepted,
        jobsCreated: row.jobsCreated,
        retainedLiveJobs: row.retainedLiveJobs,
        trackedRetainedLiveJobs: row.trackedRetainedLiveJobs,
        acceptedPerSuccessfulPoll:
          pollSuccesses > 0 ? row.jobsAccepted / pollSuccesses : 0,
        createdPerSuccessfulPoll:
          pollSuccesses > 0 ? row.jobsCreated / pollSuccesses : 0,
      };
    })
    .sort((left, right) => {
      if (right.retainedLiveJobs !== left.retainedLiveJobs) {
        return right.retainedLiveJobs - left.retainedLiveJobs;
      }
      return right.averageYieldScore - left.averageYieldScore;
    });

  return {
    companyCounts,
    sourceCounts,
    taskCounts,
    sourceFunnel,
    recentCompanies,
    recentSources,
    vendorPerformance,
  };
}

export async function getHealthOpsOverview() {
  const [healthCounts, recentChecks, atRiskJobs, lifecycleCounts] = await Promise.all([
    prisma.jobUrlHealthCheck.groupBy({
      by: ["result", "urlType"],
      _count: { _all: true },
    }),
    prisma.jobUrlHealthCheck.findMany({
      orderBy: [{ checkedAt: "desc" }],
      take: 50,
      select: {
        id: true,
        result: true,
        urlType: true,
        checkedAt: true,
        statusCode: true,
        finalUrl: true,
        closureReason: true,
        canonicalJob: {
          select: {
            id: true,
            title: true,
            company: true,
            status: true,
            availabilityScore: true,
            deadSignalAt: true,
          },
        },
      },
    }),
    prisma.jobCanonical.findMany({
      where: {
        status: { in: ["AGING", "STALE", "EXPIRED"] },
      },
      orderBy: [{ availabilityScore: "asc" }, { updatedAt: "desc" }],
      take: 40,
      select: {
        id: true,
        title: true,
        company: true,
        status: true,
        availabilityScore: true,
        lastApplyCheckAt: true,
        lastConfirmedAliveAt: true,
        deadSignalAt: true,
        deadSignalReason: true,
      },
    }),
    prisma.jobCanonical.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  return {
    healthCounts,
    recentChecks,
    atRiskJobs,
    lifecycleCounts,
  };
}
