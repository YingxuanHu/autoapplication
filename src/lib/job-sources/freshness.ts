import { prisma } from "@/lib/prisma";


// ─── Constants ───

const STALE_THRESHOLD_DAYS = 14;
const OLD_THRESHOLD_DAYS = 90;
const DELETE_THRESHOLD_DAYS = 180;

// ─── Freshness Buckets ───

interface FreshnessBreakdown {
  fresh: number; // < 7 days
  recent: number; // 7-30 days
  aging: number; // 30-60 days
  stale: number; // 60-90 days
  expired: number; // 90+ days
}

export interface FreshnessStats {
  breakdown: FreshnessBreakdown;
  totalActive: number;
  totalInactive: number;
  bySource: Record<string, { active: number; inactive: number; total: number }>;
}

export interface CleanupStats {
  markedStale: number;
  markedExpired: number;
  deleted: number;
}

// ─── Core Functions ───

/**
 * Mark jobs as inactive when they haven't been refreshed recently.
 *
 * Rules:
 * - Jobs older than 14 days that haven't been updated in the last 14 days
 * - Jobs older than 90 days with no recent update
 */
export async function markStaleJobs(): Promise<number> {
  const now = new Date();

  // Jobs older than STALE_THRESHOLD_DAYS that haven't been updated recently
  const staleDate = new Date(now.getTime() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  const oldDate = new Date(now.getTime() - OLD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  // Mark jobs that are old and haven't been refreshed
  const staleResult = await prisma.job.updateMany({
    where: {
      isActive: true,
      createdAt: { lt: staleDate },
      updatedAt: { lt: staleDate },
    },
    data: { isActive: false },
  });

  // Mark very old jobs regardless
  const oldResult = await prisma.job.updateMany({
    where: {
      isActive: true,
      createdAt: { lt: oldDate },
      updatedAt: { lt: oldDate },
    },
    data: { isActive: false },
  });

  const total = staleResult.count + oldResult.count;
  if (total > 0) {
    console.log(
      `[freshness] Marked ${staleResult.count} stale + ${oldResult.count} old jobs as inactive`,
    );
  }

  return total;
}

/**
 * Mark jobs with expiresAt in the past as inactive.
 */
export async function markExpiredJobs(): Promise<number> {
  const now = new Date();

  const result = await prisma.job.updateMany({
    where: {
      isActive: true,
      expiresAt: { lt: now },
      NOT: { expiresAt: null },
    },
    data: { isActive: false },
  });

  if (result.count > 0) {
    console.log(`[freshness] Marked ${result.count} expired jobs as inactive`);
  }

  return result.count;
}

/**
 * Find jobs created since the given date.
 */
export async function detectNewJobs(
  since: Date,
): Promise<{ count: number; bySource: Record<string, number> }> {
  const jobs = await prisma.job.groupBy({
    by: ["source"],
    where: { createdAt: { gte: since } },
    _count: { id: true },
  });

  const bySource: Record<string, number> = {};
  let count = 0;

  for (const group of jobs) {
    bySource[group.source] = group._count.id;
    count += group._count.id;
  }

  return { count, bySource };
}

/**
 * Get a detailed breakdown of job freshness across the database.
 */
export async function getJobFreshnessStats(): Promise<FreshnessStats> {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const d60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const d90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Run age bucket counts in parallel
  const [fresh, recent, aging, stale, expired, activeCount, inactiveCount, sourceGroups] =
    await Promise.all([
      prisma.job.count({ where: { createdAt: { gte: d7 } } }),
      prisma.job.count({ where: { createdAt: { gte: d30, lt: d7 } } }),
      prisma.job.count({ where: { createdAt: { gte: d60, lt: d30 } } }),
      prisma.job.count({ where: { createdAt: { gte: d90, lt: d60 } } }),
      prisma.job.count({ where: { createdAt: { lt: d90 } } }),
      prisma.job.count({ where: { isActive: true } }),
      prisma.job.count({ where: { isActive: false } }),
      prisma.job.groupBy({
        by: ["source", "isActive"],
        _count: { id: true },
      }),
    ]);

  // Build per-source breakdown
  const bySource: Record<string, { active: number; inactive: number; total: number }> = {};
  for (const group of sourceGroups) {
    const key = group.source;
    if (!bySource[key]) {
      bySource[key] = { active: 0, inactive: 0, total: 0 };
    }
    const count = group._count.id;
    if (group.isActive) {
      bySource[key].active += count;
    } else {
      bySource[key].inactive += count;
    }
    bySource[key].total += count;
  }

  return {
    breakdown: { fresh, recent, aging, stale, expired },
    totalActive: activeCount,
    totalInactive: inactiveCount,
    bySource,
  };
}

/**
 * Full cleanup: mark stale/expired jobs inactive, then delete very old inactive jobs.
 */
export async function cleanupJobs(): Promise<CleanupStats> {
  const markedStale = await markStaleJobs();
  const markedExpired = await markExpiredJobs();

  // Delete jobs older than DELETE_THRESHOLD_DAYS that are inactive
  const deleteDate = new Date(
    Date.now() - DELETE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
  );

  const deleteResult = await prisma.job.deleteMany({
    where: {
      isActive: false,
      createdAt: { lt: deleteDate },
    },
  });

  if (deleteResult.count > 0) {
    console.log(
      `[freshness] Deleted ${deleteResult.count} inactive jobs older than ${DELETE_THRESHOLD_DAYS} days`,
    );
  }

  return {
    markedStale,
    markedExpired,
    deleted: deleteResult.count,
  };
}
