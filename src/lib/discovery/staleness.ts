/**
 * Stale Job Handling
 *
 * Calculates and manages job freshness/staleness based on age, crawl history,
 * and apply link validity. Stale jobs are deprioritized in the feed, not deleted.
 */

import { prisma } from "@/lib/prisma";
import { checkApplyLink } from "./link-checker";

/**
 * Staleness levels based on job age and recency.
 */
export enum StalenessLevel {
  /** Less than 7 days old. */
  FRESH = "FRESH",
  /** 7-30 days old. */
  RECENT = "RECENT",
  /** 30-60 days old. */
  AGING = "AGING",
  /** 60-90 days old. */
  STALE = "STALE",
  /** Over 90 days old or otherwise expired. */
  EXPIRED = "EXPIRED",
}

/**
 * Staleness assessment result for a single job.
 */
export interface StalenessResult {
  /** The job's database ID. */
  jobId: string;
  /** The determined staleness level. */
  level: StalenessLevel;
  /** Number of days since the job was posted or first seen. */
  ageDays: number;
  /** Whether the apply link was checked and found broken. */
  applyLinkBroken: boolean;
  /** Whether the job was not found in recent crawls. */
  missingFromCrawls: boolean;
  /** Reasons contributing to the staleness determination. */
  reasons: string[];
}

/**
 * Configuration thresholds for staleness detection.
 */
const STALENESS_THRESHOLDS = {
  FRESH_MAX_DAYS: 7,
  RECENT_MAX_DAYS: 30,
  AGING_MAX_DAYS: 60,
  STALE_MAX_DAYS: 90,
  /** Number of missed crawls before marking as stale. */
  MISSED_CRAWL_THRESHOLD: 2,
  /** Maximum age in days before auto-expiration with no refresh. */
  AUTO_EXPIRE_DAYS: 90,
} as const;

/**
 * Feed deprioritization multipliers by staleness level.
 * Applied to the job's trust/relevance score in the feed.
 */
export const STALENESS_MULTIPLIERS: Record<StalenessLevel, number> = {
  [StalenessLevel.FRESH]: 1.0,
  [StalenessLevel.RECENT]: 0.95,
  [StalenessLevel.AGING]: 0.8,
  [StalenessLevel.STALE]: 0.5,
  [StalenessLevel.EXPIRED]: 0.1,
};

/**
 * Determine the staleness level based on the age in days.
 *
 * @param ageDays - Number of days since the job was posted or first seen.
 * @returns The staleness level.
 */
export function getStalenessFromAge(ageDays: number): StalenessLevel {
  if (ageDays < STALENESS_THRESHOLDS.FRESH_MAX_DAYS) return StalenessLevel.FRESH;
  if (ageDays < STALENESS_THRESHOLDS.RECENT_MAX_DAYS) return StalenessLevel.RECENT;
  if (ageDays < STALENESS_THRESHOLDS.AGING_MAX_DAYS) return StalenessLevel.AGING;
  if (ageDays < STALENESS_THRESHOLDS.STALE_MAX_DAYS) return StalenessLevel.STALE;
  return StalenessLevel.EXPIRED;
}

/**
 * Calculate the staleness of a single job based on its age, crawl presence,
 * and apply link validity.
 *
 * A job is considered stale if any of these are true:
 * - Not seen in the last 2 crawls of the same source
 * - Posted more than 90 days ago with no refresh (updatedAt not recent)
 * - Apply link is broken
 *
 * @param job - The job record from the database.
 * @param options - Optional configuration.
 * @param options.checkLink - Whether to check the apply link (default false, for performance).
 * @param options.recentCrawlIds - External IDs found in the most recent crawls of this source.
 * @param options.crawlCount - Number of recent crawls to compare against.
 * @returns The staleness assessment.
 */
export async function calculateStaleness(
  job: {
    id: string;
    postedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    applyUrl: string | null;
    externalId: string;
    source: string;
    isActive: boolean;
  },
  options: {
    checkLink?: boolean;
    recentCrawlIds?: Set<string>;
    crawlCount?: number;
  } = {},
): Promise<StalenessResult> {
  const { checkLink = false, recentCrawlIds, crawlCount = 2 } = options;

  const now = new Date();
  const referenceDate = job.postedAt || job.createdAt;
  const ageDays = Math.floor(
    (now.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24),
  );

  const reasons: string[] = [];
  let level = getStalenessFromAge(ageDays);
  let applyLinkBroken = false;
  let missingFromCrawls = false;

  // Check if job was not found in recent crawls
  if (recentCrawlIds && crawlCount >= STALENESS_THRESHOLDS.MISSED_CRAWL_THRESHOLD) {
    const externalKey = `${job.externalId}:${job.source}`;
    if (!recentCrawlIds.has(externalKey)) {
      missingFromCrawls = true;
      reasons.push(
        `Not seen in the last ${crawlCount} crawls of source ${job.source}`,
      );
      // Escalate staleness level
      if (level === StalenessLevel.FRESH || level === StalenessLevel.RECENT) {
        level = StalenessLevel.AGING;
      } else if (level === StalenessLevel.AGING) {
        level = StalenessLevel.STALE;
      }
    }
  }

  // Check if job is old with no recent refresh
  const daysSinceUpdate = Math.floor(
    (now.getTime() - job.updatedAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (ageDays >= STALENESS_THRESHOLDS.AUTO_EXPIRE_DAYS && daysSinceUpdate > 30) {
    level = StalenessLevel.EXPIRED;
    reasons.push(
      `Posted ${ageDays} days ago with no refresh in ${daysSinceUpdate} days`,
    );
  }

  // Check apply link validity
  if (checkLink && job.applyUrl) {
    const linkResult = await checkApplyLink(job.applyUrl);
    if (!linkResult.isValid) {
      applyLinkBroken = true;
      reasons.push(`Apply link broken: ${linkResult.reason || "Unknown"}`);
      // Broken link always makes job at least STALE
      if (
        level === StalenessLevel.FRESH ||
        level === StalenessLevel.RECENT ||
        level === StalenessLevel.AGING
      ) {
        level = StalenessLevel.STALE;
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push(`Age-based staleness: ${ageDays} days old`);
  }

  return {
    jobId: job.id,
    level,
    ageDays,
    applyLinkBroken,
    missingFromCrawls,
    reasons,
  };
}

/**
 * Batch-update staleness levels for all active jobs belonging to a company.
 *
 * This function:
 * 1. Loads all active jobs for the company
 * 2. Calculates staleness for each job
 * 3. Updates job metadata with staleness information
 * 4. Returns summary statistics
 *
 * Stale jobs are deprioritized in the feed, not deleted.
 *
 * @param companyId - The company ID to process.
 * @param options - Configuration options.
 * @param options.checkLinks - Whether to check apply links (slow, default false).
 * @param options.linkCheckDelayMs - Delay between link checks in ms (default 500).
 * @returns Summary of staleness updates.
 */
export async function batchUpdateStaleness(
  companyId: string,
  options: {
    checkLinks?: boolean;
    linkCheckDelayMs?: number;
  } = {},
): Promise<{
  total: number;
  byLevel: Record<StalenessLevel, number>;
  brokenLinks: number;
  missingFromCrawls: number;
}> {
  const { checkLinks = false } = options;

  // Load active jobs for this company
  const jobs = await prisma.job.findMany({
    where: { companyId, isActive: true },
    select: {
      id: true,
      externalId: true,
      source: true,
      postedAt: true,
      createdAt: true,
      updatedAt: true,
      applyUrl: true,
      isActive: true,
    },
  });

  // Load recent crawl data to determine which jobs were seen recently
  const recentCrawls = await prisma.sourceCrawlRun.findMany({
    where: {
      companyId,
      status: "SUCCESS",
    },
    orderBy: { startedAt: "desc" },
    take: 2,
    select: { id: true, metadata: true },
  });

  // Build set of external IDs seen in recent crawls if available
  // (This relies on metadata being populated during sync - see sync-engine integration)
  const recentCrawlIds = new Set<string>();
  for (const crawl of recentCrawls) {
    const meta = crawl.metadata as { seenExternalIds?: string[] } | null;
    if (meta?.seenExternalIds) {
      for (const id of meta.seenExternalIds) {
        recentCrawlIds.add(id);
      }
    }
  }

  const crawlCount = recentCrawls.length;

  const byLevel: Record<StalenessLevel, number> = {
    [StalenessLevel.FRESH]: 0,
    [StalenessLevel.RECENT]: 0,
    [StalenessLevel.AGING]: 0,
    [StalenessLevel.STALE]: 0,
    [StalenessLevel.EXPIRED]: 0,
  };
  let brokenLinks = 0;
  let missingFromCrawls = 0;

  for (const job of jobs) {
    const result = await calculateStaleness(job, {
      checkLink: checkLinks,
      recentCrawlIds: crawlCount >= 2 ? recentCrawlIds : undefined,
      crawlCount,
    });

    byLevel[result.level]++;
    if (result.applyLinkBroken) brokenLinks++;
    if (result.missingFromCrawls) missingFromCrawls++;

    // Update the job's sourceTrust based on staleness multiplier
    const multiplier = STALENESS_MULTIPLIERS[result.level];

    // Store staleness info in a way that can be used by the feed
    await prisma.job.update({
      where: { id: job.id },
      data: {
        // Mark expired jobs as inactive
        isActive: result.level !== StalenessLevel.EXPIRED,
        // Apply staleness multiplier to trust score
        sourceTrust: {
          multiply: multiplier,
        },
      },
    });
  }

  return {
    total: jobs.length,
    byLevel,
    brokenLinks,
    missingFromCrawls,
  };
}

/**
 * Batch-update staleness for all active companies.
 *
 * @param options - Configuration options.
 * @returns Aggregate statistics.
 */
export async function batchUpdateAllStaleness(
  options: {
    checkLinks?: boolean;
  } = {},
): Promise<{
  companiesProcessed: number;
  totalJobs: number;
  byLevel: Record<StalenessLevel, number>;
  brokenLinks: number;
}> {
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const aggregate = {
    companiesProcessed: 0,
    totalJobs: 0,
    byLevel: {
      [StalenessLevel.FRESH]: 0,
      [StalenessLevel.RECENT]: 0,
      [StalenessLevel.AGING]: 0,
      [StalenessLevel.STALE]: 0,
      [StalenessLevel.EXPIRED]: 0,
    } as Record<StalenessLevel, number>,
    brokenLinks: 0,
  };

  for (const company of companies) {
    try {
      const result = await batchUpdateStaleness(company.id, options);
      aggregate.companiesProcessed++;
      aggregate.totalJobs += result.total;
      aggregate.brokenLinks += result.brokenLinks;
      for (const level of Object.values(StalenessLevel)) {
        aggregate.byLevel[level] += result.byLevel[level];
      }
    } catch (err) {
      console.error(
        `Failed to update staleness for company ${company.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return aggregate;
}
