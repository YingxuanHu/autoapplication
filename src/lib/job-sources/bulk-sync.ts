import { searchJobs } from "./aggregator";
import { prisma } from "@/lib/prisma";
import { classifyNormalizedJob } from "@/lib/jobs/classifier";
import type { JobSource, NormalizedJob } from "@/types/index";

// ─── Default Query Configuration ───

const DEFAULT_QUERIES = [
  "Software Engineer",
  "Software Developer",
  "Frontend Developer",
  "Backend Developer",
  "Full Stack Developer",
  "DevOps Engineer",
  "SRE",
  "Cloud Engineer",
  "Data Engineer",
  "Data Scientist",
  "Machine Learning Engineer",
  "AI Engineer",
  "Product Manager",
  "Technical Product Manager",
  "Engineering Manager",
  "iOS Developer",
  "Android Developer",
  "Mobile Developer",
  "QA Engineer",
  "SDET",
  "Security Engineer",
  "Cybersecurity Analyst",
  "UX Designer",
  "UI Designer",
  "Product Designer",
  "Solutions Architect",
  "Systems Engineer",
  "Platform Engineer",
  "Blockchain Developer",
  "Web3 Engineer",
  "Database Administrator",
  "Data Analyst",
  "Business Analyst",
  "Technical Writer",
  "Developer Advocate",
  "IT Support",
  "Systems Administrator",
  "Network Engineer",
] as const;

const DEFAULT_LOCATIONS = ["United States", "Canada", "Remote"];

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2_000;

// ─── Progress Tracking ───

export interface BulkSyncProgress {
  status: "idle" | "running" | "completed" | "failed";
  startedAt: Date | null;
  completedAt: Date | null;
  currentQuery: string | null;
  currentBatch: number;
  totalBatches: number;
  queriesCompleted: number;
  totalQueries: number;
  jobsFoundSoFar: number;
  jobsSyncedSoFar: number;
  errors: Array<{ query: string; error: string }>;
}

let syncProgress: BulkSyncProgress = {
  status: "idle",
  startedAt: null,
  completedAt: null,
  currentQuery: null,
  currentBatch: 0,
  totalBatches: 0,
  queriesCompleted: 0,
  totalQueries: 0,
  jobsFoundSoFar: 0,
  jobsSyncedSoFar: 0,
  errors: [],
};

export function getBulkSyncProgress(): BulkSyncProgress {
  return { ...syncProgress };
}

// ─── Helpers ───

function getValidDate(value: Date | undefined): Date | undefined {
  if (!value) return undefined;
  return Number.isNaN(value.getTime()) ? undefined : value;
}

function deduplicateJobs(jobs: NormalizedJob[]): NormalizedJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    const key = [
      job.title.toLowerCase().trim(),
      job.company.toLowerCase().trim(),
      (job.location ?? "").toLowerCase().trim(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ───

export function getDefaultQueries(): string[] {
  return [...DEFAULT_QUERIES];
}

export function estimateJobVolume(): Record<string, number> {
  // Rough estimates of jobs-per-query by source based on typical API response sizes
  return {
    JSEARCH: 10,
    ADZUNA: 20,
    THE_MUSE: 10,
    USAJOBS: 15,
    REED: 15,
    REMOTIVE: 5,
    JOBICY: 5,
    CAREERONESTOP: 10,
    JOOBLE: 20,
    GREENHOUSE: 10,
    LEVER: 10,
    ASHBY: 5,
    SMARTRECRUITERS: 10,
    estimatedPerQuery: 145,
    estimatedTotal: 145 * DEFAULT_QUERIES.length,
  };
}

export interface BulkSyncOptions {
  queries?: string[];
  locations?: string[];
  sources?: JobSource[];
  batchSize?: number;
  batchDelayMs?: number;
}

export interface BulkSyncStats {
  totalJobsFound: number;
  totalJobsSynced: number;
  newJobs: number;
  updatedJobs: number;
  bySource: Record<string, { found: number; synced: number }>;
  byQuery: Record<string, { found: number; synced: number }>;
  errors: Array<{ query: string; error: string }>;
  durationMs: number;
}

async function syncJobBatch(jobs: NormalizedJob[]): Promise<{ newCount: number; updatedCount: number }> {
  let newCount = 0;
  let updatedCount = 0;

  for (const job of jobs) {
    const classification = classifyNormalizedJob(job);

    const existing = await prisma.job.findUnique({
      where: {
        externalId_source: {
          externalId: job.externalId,
          source: job.source,
        },
      },
      select: { id: true },
    });

    await prisma.job.upsert({
      where: {
        externalId_source: {
          externalId: job.externalId,
          source: job.source,
        },
      },
      update: {
        title: job.title,
        company: job.company,
        companyLogo: job.companyLogo,
        location: job.location,
        workMode: job.workMode,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        salaryCurrency: job.salaryCurrency,
        description: job.description,
        summary: job.summary,
        url: job.url,
        applyUrl: job.applyUrl,
        postedAt: getValidDate(job.postedAt),
        skills: job.skills,
        jobType: job.jobType,
        sourceType: "AGGREGATOR",
        sourceTrust: 0.4,
        isDirectApply: false,
        isActive: true,
        countryCode: classification.countryCode,
        regionScope: classification.regionScope,
        jobFamily: classification.jobFamily,
        jobSubfamily: classification.jobSubfamily,
        stemScore: classification.stemScore,
        canonicalCompanyDomain: classification.canonicalCompanyDomain,
        isAgency: classification.isAgency,
        isPublicSector: classification.isPublicSector,
        isInternship: classification.isInternship,
      },
      create: {
        externalId: job.externalId,
        source: job.source,
        title: job.title,
        company: job.company,
        companyLogo: job.companyLogo,
        location: job.location,
        workMode: job.workMode,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        salaryCurrency: job.salaryCurrency,
        description: job.description,
        summary: job.summary,
        url: job.url,
        applyUrl: job.applyUrl ?? "",
        postedAt: getValidDate(job.postedAt),
        skills: job.skills,
        jobType: job.jobType,
        sourceType: "AGGREGATOR",
        sourceTrust: 0.4,
        isDirectApply: false,
        countryCode: classification.countryCode,
        regionScope: classification.regionScope,
        jobFamily: classification.jobFamily,
        jobSubfamily: classification.jobSubfamily,
        stemScore: classification.stemScore,
        canonicalCompanyDomain: classification.canonicalCompanyDomain,
        isAgency: classification.isAgency,
        isPublicSector: classification.isPublicSector,
        isInternship: classification.isInternship,
      },
    });

    if (existing) {
      updatedCount++;
    } else {
      newCount++;
    }
  }

  return { newCount, updatedCount };
}

export async function runBulkSync(options: BulkSyncOptions = {}): Promise<BulkSyncStats> {
  const queries = options.queries ?? [...DEFAULT_QUERIES];
  const locations = options.locations ?? [...DEFAULT_LOCATIONS];
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const batchDelayMs = options.batchDelayMs ?? BATCH_DELAY_MS;

  const totalBatches = Math.ceil(queries.length / batchSize);
  const startTime = Date.now();

  // Reset progress
  syncProgress = {
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    currentQuery: null,
    currentBatch: 0,
    totalBatches,
    queriesCompleted: 0,
    totalQueries: queries.length,
    jobsFoundSoFar: 0,
    jobsSyncedSoFar: 0,
    errors: [],
  };

  const stats: BulkSyncStats = {
    totalJobsFound: 0,
    totalJobsSynced: 0,
    newJobs: 0,
    updatedJobs: 0,
    bySource: {},
    byQuery: {},
    errors: [],
    durationMs: 0,
  };

  // Collect ALL jobs across queries, then deduplicate globally before syncing
  const allJobsCollected: NormalizedJob[] = [];
  const jobsByQuery: Record<string, NormalizedJob[]> = {};

  try {
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batch = queries.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
      syncProgress.currentBatch = batchIdx + 1;

      console.log(
        `[bulk-sync] Batch ${batchIdx + 1}/${totalBatches}: ${batch.join(", ")}`,
      );

      // Run all queries in the batch concurrently
      const batchPromises = batch.map(async (query) => {
        syncProgress.currentQuery = query;

        try {
          const jobs = await searchJobs(
            { query, locations, location: locations[0] },
            options.sources,
          );

          console.log(`[bulk-sync] "${query}" returned ${jobs.length} jobs`);
          return { query, jobs, error: null };
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : String(error);
          console.error(`[bulk-sync] "${query}" failed: ${errMsg}`);
          return { query, jobs: [] as NormalizedJob[], error: errMsg };
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);

      for (const result of batchResults) {
        if (result.status !== "fulfilled") continue;
        const { query, jobs, error } = result.value;

        if (error) {
          stats.errors.push({ query, error });
          syncProgress.errors.push({ query, error });
        }

        jobsByQuery[query] = jobs;
        allJobsCollected.push(...jobs);
        syncProgress.jobsFoundSoFar += jobs.length;
        syncProgress.queriesCompleted++;
      }

      // Delay between batches (skip after the last batch)
      if (batchIdx < totalBatches - 1) {
        await sleep(batchDelayMs);
      }
    }

    // Global deduplication
    const deduplicated = deduplicateJobs(allJobsCollected);
    stats.totalJobsFound = deduplicated.length;

    console.log(
      `[bulk-sync] Collected ${allJobsCollected.length} total, ${deduplicated.length} after dedup. Syncing to DB...`,
    );

    // Sync deduplicated jobs to DB in chunks to avoid long transactions
    const DB_CHUNK_SIZE = 50;
    for (let i = 0; i < deduplicated.length; i += DB_CHUNK_SIZE) {
      const chunk = deduplicated.slice(i, i + DB_CHUNK_SIZE);
      const { newCount, updatedCount } = await syncJobBatch(chunk);
      stats.newJobs += newCount;
      stats.updatedJobs += updatedCount;
      stats.totalJobsSynced += chunk.length;
      syncProgress.jobsSyncedSoFar += chunk.length;
    }

    // Build per-source stats from deduplicated results
    for (const job of deduplicated) {
      const sourceKey = job.source;
      if (!stats.bySource[sourceKey]) {
        stats.bySource[sourceKey] = { found: 0, synced: 0 };
      }
      stats.bySource[sourceKey].found++;
      stats.bySource[sourceKey].synced++;
    }

    // Build per-query stats from raw (pre-dedup) results
    for (const [query, jobs] of Object.entries(jobsByQuery)) {
      stats.byQuery[query] = { found: jobs.length, synced: jobs.length };
    }

    stats.durationMs = Date.now() - startTime;

    syncProgress.status = "completed";
    syncProgress.completedAt = new Date();
    syncProgress.currentQuery = null;

    console.log(
      `[bulk-sync] Complete. ${stats.totalJobsSynced} synced (${stats.newJobs} new, ${stats.updatedJobs} updated) in ${stats.durationMs}ms`,
    );
  } catch (error) {
    syncProgress.status = "failed";
    syncProgress.completedAt = new Date();
    stats.durationMs = Date.now() - startTime;

    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[bulk-sync] Fatal error: ${errMsg}`);
    stats.errors.push({ query: "__fatal__", error: errMsg });
    throw error;
  }

  return stats;
}
