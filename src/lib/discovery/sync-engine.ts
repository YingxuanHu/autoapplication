import { CrawlStatus } from "@/generated/prisma";
import type { JobSource, SourceType } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import type { NormalizedJob } from "@/types/index";
import { fetchJobsFromSource } from "./ats-adapters";
import { discoverCompany } from "./company-discovery";
import { generateFingerprint, deduplicateJobs } from "./normalizer";
import { calculateSourceTrust } from "./trust-scorer";
import { getRequestTimeoutMs } from "@/lib/job-sources/utils";

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) : str;
}

function getValidDate(value: Date | undefined): Date | undefined {
  if (!value) return undefined;
  return Number.isNaN(value.getTime()) ? undefined : value;
}

export interface SyncStats {
  jobsFound: number;
  jobsNew: number;
  jobsUpdated: number;
  jobsRemoved: number;
}

/**
 * Map a SourceType + atsType combination to a JobSource enum value.
 */
function resolveJobSource(
  sourceType: SourceType,
  atsType: string | null | undefined,
): JobSource {
  if (sourceType === "ATS_BOARD" && atsType) {
    const atsToSource: Record<string, JobSource> = {
      GREENHOUSE: "GREENHOUSE",
      LEVER: "LEVER",
      ASHBY: "ASHBY",
      SMARTRECRUITERS: "SMARTRECRUITERS",
      WORKABLE: "WORKABLE",
      WORKDAY: "WORKDAY",
      TEAMTAILOR: "TEAMTAILOR",
      RECRUITEE: "RECRUITEE",
    };
    return atsToSource[atsType] ?? "COMPANY_SITE";
  }
  if (sourceType === "STRUCTURED_DATA") return "STRUCTURED_DATA";
  return "COMPANY_SITE";
}

/**
 * Determine the source trust score for a job based on its source type.
 */
function getSourceTrustForType(sourceType: SourceType): number {
  const trustMap: Record<string, number> = {
    CAREER_PAGE: 0.9,
    ATS_BOARD: 0.85,
    STRUCTURED_DATA: 0.8,
    AGGREGATOR: 0.4,
  };
  return trustMap[sourceType] ?? 0.5;
}

function getErrorStatusCode(error: unknown): number | null {
  const maybeStatus = (error as { response?: { status?: unknown } })?.response?.status;
  return typeof maybeStatus === "number" ? maybeStatus : null;
}

function isHardMissingSourceError(error: unknown): boolean {
  const statusCode = getErrorStatusCode(error);
  return statusCode === 404 || statusCode === 410;
}

function getSourceMetadata(
  metadata: unknown,
): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

async function fetchJobsWithTimeout(
  source: Parameters<typeof fetchJobsFromSource>[0],
  companyName: string,
): Promise<NormalizedJob[]> {
  const timeoutMs = getSourceTimeoutMs(source);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.warn(
        `[syncCompanyJobs] ${source.sourceUrl} timed out after ${timeoutMs}ms`,
      );
      resolve([]);
    }, timeoutMs);

    void fetchJobsFromSource(source, companyName)
      .then((jobs) => {
        clearTimeout(timeout);
        resolve(jobs);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function getSourceTimeoutMs(
  source: Parameters<typeof fetchJobsFromSource>[0],
): number {
  const defaultTimeoutMs = getRequestTimeoutMs();

  if (source.sourceType === "CAREER_PAGE" || source.sourceType === "STRUCTURED_DATA") {
    return Math.max(defaultTimeoutMs, 30_000);
  }

  if (source.atsType === "WORKDAY" || source.atsType === "CUSTOM_SITE") {
    return Math.max(defaultTimeoutMs, 20_000);
  }

  return defaultTimeoutMs;
}

/**
 * Sync jobs from all active sources for a single company.
 */
export async function syncCompanyJobs(companyId: string): Promise<SyncStats> {
  const stats: SyncStats = { jobsFound: 0, jobsNew: 0, jobsUpdated: 0, jobsRemoved: 0 };

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      sources: {
        where: { isActive: true },
        orderBy: { priority: "desc" },
      },
    },
  });

  if (!company || !company.isActive) return stats;

  // Create a crawl run for tracking
  const crawlRun = await prisma.sourceCrawlRun.create({
    data: {
      companyId,
      status: CrawlStatus.CRAWLING,
      startedAt: new Date(),
    },
  });

  const startTime = Date.now();

  try {
    // Update company status
    await prisma.company.update({
      where: { id: companyId },
      data: { crawlStatus: CrawlStatus.CRAWLING },
    });

    // Collect jobs from all sources
    const allJobs: NormalizedJob[] = [];
    const sourceTypeMap = new Map<string, SourceType>();
    const processedSourceIds = new Set<string>();
    let successfulSourceCount = 0;
    let hardMissingSourceCount = 0;

    const processSources = async (
      sources: typeof company.sources,
    ): Promise<void> => {
      for (const source of sources) {
        if (processedSourceIds.has(source.id)) continue;
        processedSourceIds.add(source.id);

        const existingMetadata = getSourceMetadata(source.metadata);

        try {
          const jobs = await fetchJobsWithTimeout(source, company.name);
          allJobs.push(...jobs);
          successfulSourceCount++;

          // Track source types for dedup preference
          for (const job of jobs) {
            sourceTypeMap.set(job.source, source.sourceType);
          }

          // Update source crawl status
          await prisma.companySource.update({
            where: { id: source.id },
            data: {
              lastCrawlStatus: CrawlStatus.SUCCESS,
              lastCrawlAt: new Date(),
              lastJobCount: jobs.length,
              successCount: { increment: 1 },
              failCount: 0,
              isVerified: true,
              isActive: true,
              metadata:
                existingMetadata.disabledAt || existingMetadata.disabledReason
                  ? {
                      ...existingMetadata,
                      disabledAt: null,
                      disabledReason: null,
                      lastError: null,
                      verificationState: "VERIFIED",
                    }
                  : {
                      ...existingMetadata,
                      verificationState: "VERIFIED",
                    },
            },
          });
        } catch (err) {
          const statusCode = getErrorStatusCode(err);
          const isHardMissing = isHardMissingSourceError(err);

          // Mark source as failed but continue with others
          await prisma.companySource.update({
            where: { id: source.id },
            data: {
              lastCrawlStatus: CrawlStatus.FAILED,
              lastCrawlAt: new Date(),
              failCount: { increment: 1 },
              isVerified: isHardMissing ? false : source.isVerified,
              isActive: isHardMissing ? false : source.isActive,
              metadata: isHardMissing
                ? {
                    ...existingMetadata,
                    disabledAt: new Date().toISOString(),
                    disabledReason: `Source returned ${statusCode}`,
                    lastError: err instanceof Error ? err.message : String(err),
                    verificationState: "INVALID",
                  }
                : {
                    ...existingMetadata,
                    lastError: err instanceof Error ? err.message : String(err),
                  },
            },
          });

          if (isHardMissing) {
            hardMissingSourceCount++;
          }

          console.error(
            `Failed to fetch jobs from source ${source.id} (${source.sourceUrl}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    };

    await processSources(company.sources);

    // Self-heal companies whose only active sources disappeared.
    if (hardMissingSourceCount > 0 && successfulSourceCount === 0) {
      try {
        await discoverCompany(company.domain);

        const refreshedCompany = await prisma.company.findUnique({
          where: { id: companyId },
          include: {
            sources: {
              where: { isActive: true },
              orderBy: { priority: "desc" },
            },
          },
        });

        if (refreshedCompany?.sources.length) {
          await processSources(refreshedCompany.sources);
        }
      } catch (err) {
        console.error(
          `Failed to rediscover company sources for ${company.domain}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Deduplicate across sources
    const deduplicated = deduplicateJobs(allJobs, sourceTypeMap);
    stats.jobsFound = deduplicated.length;

    // Get existing job fingerprints for this company
    const existingJobs = await prisma.job.findMany({
      where: { companyId, isActive: true },
      select: { id: true, fingerprint: true, externalId: true, source: true },
    });
    const existingFingerprints = new Set(
      existingJobs.map((j) => j.fingerprint).filter(Boolean),
    );
    const existingExternalIds = new Set(
      existingJobs.map((j) => `${j.externalId}:${j.source}`),
    );

    // Track which existing jobs are still present
    const seenExternalIds = new Set<string>();

    // Upsert jobs
    for (const job of deduplicated) {
      const fingerprint = generateFingerprint(job);
      const externalKey = `${job.externalId}:${job.source}`;
      seenExternalIds.add(externalKey);

      // Determine source metadata
      const matchedSource = company.sources.find((s) => {
        const resolved = resolveJobSource(s.sourceType, s.atsType);
        return resolved === job.source;
      });
      const sourceType = sourceTypeMap.get(job.source) ?? matchedSource?.sourceType ?? null;
      const sourceTrust = sourceType ? getSourceTrustForType(sourceType) : 0.5;
      const isDirectApply = sourceType === "ATS_BOARD" || sourceType === "CAREER_PAGE";

      const isExisting =
        existingExternalIds.has(externalKey) || existingFingerprints.has(fingerprint);

      await prisma.job.upsert({
        where: {
          externalId_source: {
            externalId: job.externalId,
            source: job.source,
          },
        },
        update: {
          title: truncate(job.title, 500),
          company: truncate(job.company, 255),
          companyLogo: job.companyLogo ? truncate(job.companyLogo, 2048) : null,
          location: job.location ? truncate(job.location, 500) : null,
          workMode: job.workMode,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          salaryCurrency: job.salaryCurrency ? truncate(job.salaryCurrency, 10) : null,
          description: job.description,
          summary: job.summary,
          url: truncate(job.url, 2048),
          applyUrl: job.applyUrl ? truncate(job.applyUrl, 2048) : null,
          postedAt: getValidDate(job.postedAt),
          skills: job.skills,
          jobType: job.jobType ? truncate(job.jobType, 100) : null,
          isActive: true,
          companyId,
          sourceTrust,
          sourceType,
          isDirectApply,
          fingerprint,
        },
        create: {
          externalId: truncate(job.externalId, 500),
          source: job.source,
          title: truncate(job.title, 500),
          company: truncate(job.company, 255),
          companyLogo: job.companyLogo ? truncate(job.companyLogo, 2048) : null,
          location: job.location ? truncate(job.location, 500) : null,
          workMode: job.workMode,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          salaryCurrency: job.salaryCurrency ? truncate(job.salaryCurrency, 10) : null,
          description: job.description,
          summary: job.summary,
          url: truncate(job.url, 2048),
          applyUrl: job.applyUrl ? truncate(job.applyUrl, 2048) : "",
          postedAt: getValidDate(job.postedAt),
          skills: job.skills,
          jobType: job.jobType ? truncate(job.jobType, 100) : null,
          companyId,
          sourceTrust,
          sourceType,
          isDirectApply,
          fingerprint,
        },
      });

      if (isExisting) {
        stats.jobsUpdated++;
      } else {
        stats.jobsNew++;
      }
    }

    // Mark jobs that are no longer found as inactive
    const removedCount = await prisma.job.updateMany({
      where: {
        companyId,
        isActive: true,
        NOT: {
          OR: deduplicated.map((j) => ({
            externalId: j.externalId,
            source: j.source,
          })),
        },
      },
      data: { isActive: false },
    });
    stats.jobsRemoved = removedCount.count;

    // Update crawl run
    await prisma.sourceCrawlRun.update({
      where: { id: crawlRun.id },
      data: {
        status: CrawlStatus.SUCCESS,
        jobsFound: stats.jobsFound,
        jobsNew: stats.jobsNew,
        jobsUpdated: stats.jobsUpdated,
        jobsRemoved: stats.jobsRemoved,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      },
    });

    // Update company trust score
    const sources = await prisma.companySource.findMany({
      where: { companyId },
    });
    const crawlRuns = await prisma.sourceCrawlRun.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" },
      take: 10,
    });

    let maxTrust = 0.5;
    for (const source of sources) {
      const trust = calculateSourceTrust(
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
      maxTrust = Math.max(maxTrust, trust);
    }

    await prisma.company.update({
      where: { id: companyId },
      data: {
        crawlStatus: CrawlStatus.SUCCESS,
        lastSyncAt: new Date(),
        lastSuccessAt: new Date(),
        trustScore: maxTrust,
      },
    });

    return stats;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await prisma.sourceCrawlRun.update({
      where: { id: crawlRun.id },
      data: {
        status: CrawlStatus.FAILED,
        errorMessage,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      },
    });

    await prisma.company.update({
      where: { id: companyId },
      data: {
        crawlStatus: CrawlStatus.FAILED,
        lastSyncAt: new Date(),
      },
    });

    throw err;
  }
}

/**
 * Sync jobs from all active companies with verified sources.
 * Returns aggregate stats across all companies.
 */
export async function syncAllCompanies(): Promise<{
  companiesSynced: number;
  companiesFailed: number;
  totalStats: SyncStats;
  errors: Array<{ companyId: string; domain: string; error: string }>;
}> {
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      sources: {
        some: { isActive: true },
      },
    },
    select: { id: true, domain: true },
  });

  const totalStats: SyncStats = {
    jobsFound: 0,
    jobsNew: 0,
    jobsUpdated: 0,
    jobsRemoved: 0,
  };
  let companiesSynced = 0;
  let companiesFailed = 0;
  const errors: Array<{ companyId: string; domain: string; error: string }> = [];

  for (const company of companies) {
    try {
      const stats = await syncCompanyJobs(company.id);
      totalStats.jobsFound += stats.jobsFound;
      totalStats.jobsNew += stats.jobsNew;
      totalStats.jobsUpdated += stats.jobsUpdated;
      totalStats.jobsRemoved += stats.jobsRemoved;
      companiesSynced++;
    } catch (err) {
      companiesFailed++;
      errors.push({
        companyId: company.id,
        domain: company.domain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { companiesSynced, companiesFailed, totalStats, errors };
}
