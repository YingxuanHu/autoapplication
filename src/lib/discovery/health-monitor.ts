import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "DEAD";

export interface SourceHealthMetrics {
  sourceId: string;
  companyId: string;
  companyName: string;
  companyDomain: string;
  sourceUrl: string;
  atsType: string | null;
  consecutiveFailures: number;
  successRate: number;
  avgResponseTimeMs: number;
  lastJobCount: number | null;
  currentJobCount: number | null;
  jobCountDelta: number | null;
  healthStatus: HealthStatus;
  lastCrawlAt: Date | null;
  lastSuccessAt: Date | null;
  isActive: boolean;
}

export interface HealthReport {
  generatedAt: Date;
  totalCompanies: number;
  totalSources: number;
  activeSources: number;
  healthBreakdown: Record<HealthStatus, number>;
  unhealthySources: SourceHealthMetrics[];
  recentFailures: Array<{
    sourceId: string;
    companyName: string;
    companyDomain: string;
    sourceUrl: string;
    errorMessage: string | null;
    failedAt: Date;
  }>;
  companiesNeedingAttention: Array<{
    companyId: string;
    companyName: string;
    companyDomain: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENT_CRAWL_WINDOW = 10;
const DEFAULT_AUTO_DISABLE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Compute the health status of a single source based on its crawl history.
 */
export function computeHealthStatus(
  consecutiveFailures: number,
  successRate: number,
): HealthStatus {
  if (consecutiveFailures >= 10 || successRate === 0) return "DEAD";
  if (consecutiveFailures >= 5 || successRate < 0.3) return "UNHEALTHY";
  if (consecutiveFailures >= 2 || successRate < 0.7) return "DEGRADED";
  return "HEALTHY";
}

/**
 * Calculate health metrics for a specific company source.
 */
export async function getSourceHealth(
  sourceId: string,
): Promise<SourceHealthMetrics | null> {
  const source = await prisma.companySource.findUnique({
    where: { id: sourceId },
    include: { company: true },
  });

  if (!source) return null;

  // Fetch last N crawl runs for this source
  const recentRuns = await prisma.sourceCrawlRun.findMany({
    where: { sourceId },
    orderBy: { startedAt: "desc" },
    take: RECENT_CRAWL_WINDOW,
  });

  const successfulRuns = recentRuns.filter((r) => r.status === "SUCCESS");
  const successRate =
    recentRuns.length > 0 ? successfulRuns.length / recentRuns.length : 1;

  // Consecutive failures from the most recent runs
  let consecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.status === "FAILED" || run.status === "BLOCKED") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  // Average response time from successful runs
  const durationsMs = successfulRuns
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null);
  const avgResponseTimeMs =
    durationsMs.length > 0
      ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length
      : 0;

  // Job count comparison (latest successful vs previous successful)
  let currentJobCount: number | null = null;
  const lastJobCount: number | null = source.lastJobCount;
  if (successfulRuns.length > 0) {
    currentJobCount = successfulRuns[0].jobsFound;
  }

  const jobCountDelta =
    currentJobCount !== null && lastJobCount !== null
      ? currentJobCount - lastJobCount
      : null;

  // Last success time
  const lastSuccessRun = successfulRuns[0] ?? null;
  const lastSuccessAt = lastSuccessRun?.completedAt ?? null;

  const healthStatus = computeHealthStatus(consecutiveFailures, successRate);

  return {
    sourceId: source.id,
    companyId: source.companyId,
    companyName: source.company.name,
    companyDomain: source.company.domain,
    sourceUrl: source.sourceUrl,
    atsType: source.atsType,
    consecutiveFailures,
    successRate,
    avgResponseTimeMs,
    lastJobCount,
    currentJobCount,
    jobCountDelta,
    healthStatus,
    lastCrawlAt: source.lastCrawlAt,
    lastSuccessAt,
    isActive: source.isActive,
  };
}

/**
 * Get health metrics for all sources of a specific company.
 */
export async function getCompanySourcesHealth(
  companyId: string,
): Promise<SourceHealthMetrics[]> {
  const sources = await prisma.companySource.findMany({
    where: { companyId },
    select: { id: true },
  });

  const results: SourceHealthMetrics[] = [];
  for (const source of sources) {
    const health = await getSourceHealth(source.id);
    if (health) results.push(health);
  }

  return results;
}

/**
 * Get all sources that are not healthy.
 */
export async function getUnhealthySources(): Promise<SourceHealthMetrics[]> {
  const sources = await prisma.companySource.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const unhealthy: SourceHealthMetrics[] = [];

  for (const source of sources) {
    const health = await getSourceHealth(source.id);
    if (health && health.healthStatus !== "HEALTHY") {
      unhealthy.push(health);
    }
  }

  return unhealthy.sort((a, b) => {
    const order: Record<HealthStatus, number> = {
      DEAD: 0,
      UNHEALTHY: 1,
      DEGRADED: 2,
      HEALTHY: 3,
    };
    return order[a.healthStatus] - order[b.healthStatus];
  });
}

/**
 * Auto-disable sources that have exceeded the consecutive failure threshold.
 * Returns the list of source IDs that were disabled.
 */
export async function autoDisableFailingSources(
  threshold: number = DEFAULT_AUTO_DISABLE_THRESHOLD,
): Promise<string[]> {
  const sources = await prisma.companySource.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const disabledIds: string[] = [];

  for (const source of sources) {
    const recentRuns = await prisma.sourceCrawlRun.findMany({
      where: { sourceId: source.id },
      orderBy: { startedAt: "desc" },
      take: threshold,
    });

    if (recentRuns.length < threshold) continue;

    const allFailed = recentRuns.every(
      (r) => r.status === "FAILED" || r.status === "BLOCKED",
    );

    if (allFailed) {
      await prisma.companySource.update({
        where: { id: source.id },
        data: { isActive: false },
      });
      disabledIds.push(source.id);
    }
  }

  return disabledIds;
}

/**
 * Generate a comprehensive health report across all companies and sources.
 */
export async function generateHealthReport(): Promise<HealthReport> {
  const totalCompanies = await prisma.company.count();
  const totalSources = await prisma.companySource.count();
  const activeSources = await prisma.companySource.count({
    where: { isActive: true },
  });

  // Compute health for all active sources
  const activeSourceRecords = await prisma.companySource.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const healthBreakdown: Record<HealthStatus, number> = {
    HEALTHY: 0,
    DEGRADED: 0,
    UNHEALTHY: 0,
    DEAD: 0,
  };

  const unhealthySources: SourceHealthMetrics[] = [];

  for (const source of activeSourceRecords) {
    const health = await getSourceHealth(source.id);
    if (!health) continue;

    healthBreakdown[health.healthStatus]++;
    if (health.healthStatus !== "HEALTHY") {
      unhealthySources.push(health);
    }
  }

  // Recent failures (last 20 failed crawl runs)
  const recentFailedRuns = await prisma.sourceCrawlRun.findMany({
    where: { status: "FAILED" },
    orderBy: { startedAt: "desc" },
    take: 20,
    include: {
      company: { select: { name: true, domain: true } },
      source: { select: { sourceUrl: true } },
    },
  });

  const recentFailures = recentFailedRuns.map((run) => ({
    sourceId: run.sourceId ?? "",
    companyName: run.company.name,
    companyDomain: run.company.domain,
    sourceUrl: run.source?.sourceUrl ?? "",
    errorMessage: run.errorMessage,
    failedAt: run.startedAt,
  }));

  // Companies needing attention: no active sources, or all sources unhealthy
  const companiesWithSources = await prisma.company.findMany({
    where: { isActive: true },
    include: {
      sources: { select: { id: true, isActive: true } },
    },
  });

  const companiesNeedingAttention: HealthReport["companiesNeedingAttention"] = [];

  for (const company of companiesWithSources) {
    const activeSrcs = company.sources.filter((s) => s.isActive);

    if (activeSrcs.length === 0) {
      companiesNeedingAttention.push({
        companyId: company.id,
        companyName: company.name,
        companyDomain: company.domain,
        reason: "No active sources",
      });
      continue;
    }

    // Check if all active sources are unhealthy
    let allUnhealthy = true;
    for (const src of activeSrcs) {
      const health = await getSourceHealth(src.id);
      if (health && health.healthStatus === "HEALTHY") {
        allUnhealthy = false;
        break;
      }
    }

    if (allUnhealthy) {
      companiesNeedingAttention.push({
        companyId: company.id,
        companyName: company.name,
        companyDomain: company.domain,
        reason: "All active sources are unhealthy",
      });
    }
  }

  return {
    generatedAt: new Date(),
    totalCompanies,
    totalSources,
    activeSources,
    healthBreakdown,
    unhealthySources: unhealthySources.sort((a, b) => {
      const order: Record<HealthStatus, number> = {
        DEAD: 0,
        UNHEALTHY: 1,
        DEGRADED: 2,
        HEALTHY: 3,
      };
      return order[a.healthStatus] - order[b.healthStatus];
    }),
    recentFailures,
    companiesNeedingAttention,
  };
}
