import type { SourceType, CrawlStatus } from "@/generated/prisma";
import type { NormalizedJob } from "@/types/index";
import { prisma } from "@/lib/prisma";

/**
 * Represents a company source for trust scoring.
 */
export interface TrustableSource {
  sourceType: SourceType;
  isVerified: boolean;
  isActive: boolean;
  failCount: number;
  successCount: number;
  lastCrawlAt: Date | null;
  lastCrawlStatus: CrawlStatus | null;
}

/**
 * Represents a crawl run for trust scoring.
 */
export interface TrustableCrawlRun {
  status: CrawlStatus;
  startedAt: Date;
  completedAt: Date | null;
  jobsFound: number;
}

/**
 * Dynamic factors derived from actual crawl history and job data.
 */
export interface DynamicTrustFactors {
  /** Crawl success rate over the last 10 runs (0-1). */
  crawlSuccessRate: number;
  /** Content consistency score measuring job count stability (0-1). */
  contentConsistency: number;
  /** Data completeness score - percentage of fields filled across jobs (0-1). */
  dataCompleteness: number;
  /** Whether the source was updated recently (within 7 days). */
  isRecentlyUpdated: boolean;
  /** Number of broken apply links found. */
  brokenLinkCount: number;
  /** Number of jobs where applyUrl domain matches the company domain. */
  domainMatchCount: number;
  /** Total number of jobs checked for domain match. */
  totalJobsChecked: number;
}

/**
 * Base trust weights by source type.
 */
const SOURCE_TYPE_WEIGHTS: Record<SourceType, number> = {
  CAREER_PAGE: 0.9,
  ATS_BOARD: 0.85,
  STRUCTURED_DATA: 0.8,
  AGGREGATOR: 0.4,
};

const VERIFIED_BONUS = 0.1;
const MAX_TRUST = 1.0;
const MIN_TRUST = 0.0;
const STALE_DAYS_THRESHOLD = 30;
const STALE_PENALTY = 0.15;
const FAIL_PENALTY_PER_COUNT = 0.05;
const MAX_FAIL_PENALTY = 0.3;

/** Freshness bonus for recently updated sources. */
const FRESHNESS_BONUS = 0.10;
/** Penalty per broken link. */
const BROKEN_LINK_PENALTY = 0.02;
/** Bonus when apply URL domain matches company domain. */
const DOMAIN_MATCH_BONUS = 0.05;
/** Weight of static score in the composite formula. */
const STATIC_WEIGHT = 0.6;
/** Weight of dynamic score in the composite formula. */
const DYNAMIC_WEIGHT = 0.4;

/**
 * Calculate a static trust score (0-1) for a company source based on its type,
 * verification status, crawl history, and freshness.
 */
export function calculateSourceTrust(
  source: TrustableSource,
  crawlRuns: TrustableCrawlRun[],
): number {
  let score = SOURCE_TYPE_WEIGHTS[source.sourceType] ?? 0.5;

  // Verified bonus
  if (source.isVerified) {
    score += VERIFIED_BONUS;
  }

  // Inactive penalty
  if (!source.isActive) {
    score *= 0.5;
  }

  // Success rate from recent crawl runs
  if (crawlRuns.length > 0) {
    const recentRuns = crawlRuns
      .slice(-10) // last 10 runs
      .filter((r) => r.status === "SUCCESS" || r.status === "FAILED");

    if (recentRuns.length > 0) {
      const successCount = recentRuns.filter((r) => r.status === "SUCCESS").length;
      const successRate = successCount / recentRuns.length;

      // Blend the base score with the success rate
      // Weight: 70% base, 30% success rate
      score = score * 0.7 + successRate * 0.3;
    }
  }

  // Freshness penalty
  if (source.lastCrawlAt) {
    const daysSinceLastCrawl =
      (Date.now() - source.lastCrawlAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceLastCrawl > STALE_DAYS_THRESHOLD) {
      const staleMultiplier = Math.min(
        1,
        (daysSinceLastCrawl - STALE_DAYS_THRESHOLD) / STALE_DAYS_THRESHOLD,
      );
      score -= STALE_PENALTY * staleMultiplier;
    }
  }

  // Fail count penalty
  if (source.failCount > 0) {
    const failPenalty = Math.min(
      MAX_FAIL_PENALTY,
      source.failCount * FAIL_PENALTY_PER_COUNT,
    );
    score -= failPenalty;
  }

  return clamp(score, MIN_TRUST, MAX_TRUST);
}

/**
 * Calculate dynamic trust factors from crawl history and job data.
 *
 * @param crawlRuns - Recent crawl runs for the source.
 * @param jobs - Jobs associated with the source.
 * @param companyDomain - The company's domain for apply URL matching.
 * @returns Dynamic trust factors.
 */
export function calculateDynamicFactors(
  crawlRuns: TrustableCrawlRun[],
  jobs: Array<{
    title?: string | null;
    location?: string | null;
    salaryMin?: number | null;
    description?: string | null;
    applyUrl?: string | null;
    postedAt?: Date | null;
    skills?: string[] | null;
    workMode?: string | null;
  }>,
  companyDomain?: string,
): DynamicTrustFactors {
  // 1. Crawl success rate (last 10 runs)
  const recentRuns = crawlRuns
    .slice(-10)
    .filter((r) => r.status === "SUCCESS" || r.status === "FAILED");
  const crawlSuccessRate =
    recentRuns.length > 0
      ? recentRuns.filter((r) => r.status === "SUCCESS").length / recentRuns.length
      : 0.5;

  // 2. Content consistency (job count stability)
  const contentConsistency = calculateContentConsistency(crawlRuns);

  // 3. Data completeness
  const dataCompleteness = calculateDataCompleteness(jobs);

  // 4. Freshness (updated within 7 days)
  const mostRecentRun = crawlRuns
    .filter((r) => r.completedAt)
    .sort((a, b) => (b.completedAt!.getTime()) - (a.completedAt!.getTime()))[0];
  const isRecentlyUpdated = mostRecentRun?.completedAt
    ? (Date.now() - mostRecentRun.completedAt.getTime()) / (1000 * 60 * 60 * 24) < 7
    : false;

  // 5. Domain match for apply URLs
  let domainMatchCount = 0;
  let totalJobsChecked = 0;
  if (companyDomain) {
    for (const job of jobs) {
      if (job.applyUrl) {
        totalJobsChecked++;
        try {
          const applyDomain = new URL(job.applyUrl).hostname.replace(/^www\./, "");
          const normalizedCompanyDomain = companyDomain.replace(/^www\./, "");
          if (
            applyDomain === normalizedCompanyDomain ||
            applyDomain.endsWith(`.${normalizedCompanyDomain}`)
          ) {
            domainMatchCount++;
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  return {
    crawlSuccessRate,
    contentConsistency,
    dataCompleteness,
    isRecentlyUpdated,
    brokenLinkCount: 0, // Set externally after link checking
    domainMatchCount,
    totalJobsChecked,
  };
}

/**
 * Calculate content consistency based on job count stability across crawls.
 * A source that returns wildly different job counts between runs is less trustworthy.
 *
 * @param crawlRuns - Recent crawl runs.
 * @returns Consistency score between 0 and 1.
 */
function calculateContentConsistency(crawlRuns: TrustableCrawlRun[]): number {
  const successfulRuns = crawlRuns.filter(
    (r) => r.status === "SUCCESS" && r.jobsFound > 0,
  );

  if (successfulRuns.length < 2) return 0.5; // Not enough data

  const counts = successfulRuns.map((r) => r.jobsFound);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;

  if (mean === 0) return 0.5;

  // Calculate coefficient of variation (lower = more consistent)
  const variance =
    counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / mean;

  // Map CV to a 0-1 score: CV of 0 = 1.0, CV >= 1 = 0.0
  return clamp(1 - cv, 0, 1);
}

/**
 * Calculate data completeness across a set of jobs.
 * Measures what percentage of important fields are filled.
 *
 * @param jobs - Jobs to assess.
 * @returns Completeness score between 0 and 1.
 */
function calculateDataCompleteness(
  jobs: Array<{
    title?: string | null;
    location?: string | null;
    salaryMin?: number | null;
    description?: string | null;
    applyUrl?: string | null;
    postedAt?: Date | null;
    skills?: string[] | null;
    workMode?: string | null;
  }>,
): number {
  if (jobs.length === 0) return 0;

  let totalFields = 0;
  let filledFields = 0;

  for (const job of jobs) {
    // Check each important field
    const checks = [
      !!job.title,
      !!job.location,
      job.salaryMin != null,
      !!job.description && job.description.length > 100,
      !!job.applyUrl,
      !!job.postedAt,
      Array.isArray(job.skills) && job.skills.length > 0,
      !!job.workMode,
    ];

    totalFields += checks.length;
    filledFields += checks.filter(Boolean).length;
  }

  return totalFields > 0 ? filledFields / totalFields : 0;
}

/**
 * Calculate a composite trust score combining static source trust with
 * dynamic factors from actual crawl history and job data.
 *
 * Formula: (STATIC_WEIGHT * staticScore) + (DYNAMIC_WEIGHT * dynamicScore) + bonuses - penalties
 *
 * @param staticScore - The static trust score from calculateSourceTrust.
 * @param factors - Dynamic trust factors from calculateDynamicFactors.
 * @returns Composite trust score between 0 and 1.
 */
export function calculateCompositeTrust(
  staticScore: number,
  factors: DynamicTrustFactors,
): number {
  // Dynamic score combines success rate, consistency, and completeness
  const dynamicScore =
    factors.crawlSuccessRate * 0.4 +
    factors.contentConsistency * 0.3 +
    factors.dataCompleteness * 0.3;

  let composite = STATIC_WEIGHT * staticScore + DYNAMIC_WEIGHT * dynamicScore;

  // Freshness bonus
  if (factors.isRecentlyUpdated) {
    composite += FRESHNESS_BONUS;
  }

  // Broken link penalty
  if (factors.brokenLinkCount > 0) {
    composite -= factors.brokenLinkCount * BROKEN_LINK_PENALTY;
  }

  // Domain match bonus (only if we have data)
  if (factors.totalJobsChecked > 0) {
    const matchRate = factors.domainMatchCount / factors.totalJobsChecked;
    composite += matchRate * DOMAIN_MATCH_BONUS;
  }

  return clamp(composite, MIN_TRUST, MAX_TRUST);
}

/**
 * Calculate a trust score (0-1) for an individual job based on
 * its source trust and the completeness/quality of its data.
 */
export function calculateJobTrust(
  job: NormalizedJob,
  sourceTrust: number,
): number {
  let score = sourceTrust;

  // Completeness bonuses/penalties
  const completenessFactors = [
    { field: job.title, weight: 0.05 },
    { field: job.company, weight: 0.03 },
    { field: job.location, weight: 0.02 },
    { field: job.description && job.description.length > 100, weight: 0.05 },
    { field: job.applyUrl, weight: 0.03 },
    { field: job.postedAt, weight: 0.02 },
    { field: job.skills && job.skills.length > 0, weight: 0.02 },
    { field: job.salaryMin, weight: 0.01 },
    { field: job.workMode, weight: 0.01 },
  ];

  let completeness = 0;
  let totalWeight = 0;
  for (const factor of completenessFactors) {
    totalWeight += factor.weight;
    if (factor.field) completeness += factor.weight;
  }

  // Adjust trust based on completeness (up to +/- 10%)
  const completenessRatio = totalWeight > 0 ? completeness / totalWeight : 0.5;
  score += (completenessRatio - 0.5) * 0.1;

  // Penalty for very short descriptions (likely incomplete)
  if (!job.description || job.description.length < 50) {
    score -= 0.1;
  }

  return clamp(score, MIN_TRUST, MAX_TRUST);
}

/**
 * Sort jobs by trust score in descending order.
 * Computes trust for each job and returns sorted array.
 */
export function rankByTrust(
  jobs: NormalizedJob[],
  sourceTrustScores?: Map<string, number>,
): NormalizedJob[] {
  const scored = jobs.map((job) => {
    const sourceTrust = sourceTrustScores?.get(job.source) ?? getDefaultSourceTrust(job.source);
    const trust = calculateJobTrust(job, sourceTrust);
    return { job, trust };
  });

  scored.sort((a, b) => b.trust - a.trust);
  return scored.map((s) => s.job);
}

/**
 * Recalculate trust scores for all sources and the company itself.
 *
 * This function:
 * 1. Loads all sources and their crawl history
 * 2. Loads job data for completeness and domain match analysis
 * 3. Calculates static + dynamic factors for each source
 * 4. Computes composite trust scores
 * 5. Updates the company's overall trust score (max across sources)
 *
 * @param companyId - The company ID to recalculate trust for.
 * @returns Updated trust scores per source and overall company trust.
 */
export async function recalculateTrustScores(
  companyId: string,
): Promise<{
  sourceTrustScores: Map<string, number>;
  companyTrust: number;
}> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      sources: true,
    },
  });

  if (!company) {
    return { sourceTrustScores: new Map(), companyTrust: 0.5 };
  }

  // Load crawl runs for the company
  const crawlRuns = await prisma.sourceCrawlRun.findMany({
    where: { companyId },
    orderBy: { startedAt: "desc" },
    take: 20,
  });

  // Load jobs for data analysis
  const jobs = await prisma.job.findMany({
    where: { companyId, isActive: true },
    select: {
      title: true,
      location: true,
      salaryMin: true,
      description: true,
      applyUrl: true,
      postedAt: true,
      skills: true,
      workMode: true,
      source: true,
      sourceTrust: true,
    },
  });

  const sourceTrustScores = new Map<string, number>();
  let maxTrust = 0.5;

  for (const source of company.sources) {
    // Calculate static trust
    const staticScore = calculateSourceTrust(
      {
        sourceType: source.sourceType,
        isVerified: source.isVerified,
        isActive: source.isActive,
        failCount: source.failCount,
        successCount: source.successCount,
        lastCrawlAt: source.lastCrawlAt,
        lastCrawlStatus: source.lastCrawlStatus,
      },
      crawlRuns.map((r) => ({
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        jobsFound: r.jobsFound,
      })),
    );

    // Calculate dynamic factors
    const dynamicFactors = calculateDynamicFactors(
      crawlRuns.map((r) => ({
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        jobsFound: r.jobsFound,
      })),
      jobs,
      company.domain,
    );

    // Calculate composite trust
    const compositeTrust = calculateCompositeTrust(staticScore, dynamicFactors);

    sourceTrustScores.set(source.id, compositeTrust);
    maxTrust = Math.max(maxTrust, compositeTrust);

    // Update source metadata with trust score
    await prisma.companySource.update({
      where: { id: source.id },
      data: {
        metadata: {
          ...(source.metadata as Record<string, unknown> || {}),
          trustScore: compositeTrust,
          dynamicFactors: {
            crawlSuccessRate: dynamicFactors.crawlSuccessRate,
            contentConsistency: dynamicFactors.contentConsistency,
            dataCompleteness: dynamicFactors.dataCompleteness,
            isRecentlyUpdated: dynamicFactors.isRecentlyUpdated,
            domainMatchRate:
              dynamicFactors.totalJobsChecked > 0
                ? dynamicFactors.domainMatchCount / dynamicFactors.totalJobsChecked
                : null,
          },
        },
      },
    });
  }

  // Update company trust score
  await prisma.company.update({
    where: { id: companyId },
    data: { trustScore: maxTrust },
  });

  return { sourceTrustScores, companyTrust: maxTrust };
}

/**
 * Get default source trust based on job source name.
 */
function getDefaultSourceTrust(source: string): number {
  const directSources = [
    "GREENHOUSE", "LEVER", "ASHBY", "SMARTRECRUITERS",
    "WORKABLE", "WORKDAY", "TEAMTAILOR", "RECRUITEE",
  ];

  if (source === "COMPANY_SITE") return SOURCE_TYPE_WEIGHTS.CAREER_PAGE;
  if (directSources.includes(source)) return SOURCE_TYPE_WEIGHTS.ATS_BOARD;
  if (source === "STRUCTURED_DATA") return SOURCE_TYPE_WEIGHTS.STRUCTURED_DATA;
  return SOURCE_TYPE_WEIGHTS.AGGREGATOR;
}

/**
 * Clamp a number between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
