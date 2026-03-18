import { prisma } from "@/lib/prisma";
import type { JobSearchParams, NormalizedJob, JobSource } from "@/types/index";
import { jsearchAdapter } from "./jsearch";
import { adzunaAdapter } from "./adzuna";
import { cache } from "./cache";
import type { JobSourceAdapter } from "./types";

const adapters: Record<string, JobSourceAdapter> = {
  JSEARCH: jsearchAdapter,
  ADZUNA: adzunaAdapter,
};

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

function buildCacheKey(params: JobSearchParams, sources?: JobSource[]): string {
  return JSON.stringify({ ...params, sources: sources?.sort() });
}

export async function searchJobs(
  params: JobSearchParams,
  sources?: JobSource[],
): Promise<NormalizedJob[]> {
  const cacheKey = buildCacheKey(params, sources);
  const cached = cache.get<NormalizedJob[]>(cacheKey);
  if (cached) return cached;

  const selectedAdapters = sources
    ? sources.map((s) => adapters[s]).filter(Boolean)
    : Object.values(adapters);

  const results = await Promise.allSettled(
    selectedAdapters.map((adapter) => adapter.search(params)),
  );

  const allJobs = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );

  const deduplicated = deduplicateJobs(allJobs);
  cache.set(cacheKey, deduplicated);

  return deduplicated;
}

export async function syncJobsToDb(
  userId: string,
  params: JobSearchParams,
  sources?: JobSource[],
): Promise<number> {
  const jobs = await searchJobs(params, sources);
  let count = 0;

  for (const job of jobs) {
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
        postedAt: job.postedAt,
        skills: job.skills,
        jobType: job.jobType,
        isActive: true,
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
        postedAt: job.postedAt,
        skills: job.skills,
        jobType: job.jobType,
      },
    });
    count++;
  }

  const selectedSources = sources ?? (["JSEARCH", "ADZUNA"] as JobSource[]);
  for (const source of selectedSources) {
    await prisma.searchQuery.create({
      data: {
        userId,
        query: params.query,
        filters: {
          location: params.location,
          workMode: params.workMode,
        },
        source,
        resultCount: jobs.filter((j) => j.source === source).length,
      },
    });
  }

  return count;
}
