import { prisma } from "@/lib/prisma";
import type { JobSearchParams, NormalizedJob, JobSource } from "@/types/index";
import { jsearchAdapter } from "./jsearch";
import { adzunaAdapter } from "./adzuna";
import { theMuseAdapter } from "./themuse";
import { usaJobsAdapter } from "./usajobs";
import { reedAdapter } from "./reed";
import { remotiveAdapter } from "./remotive";
import { jobicyAdapter } from "./jobicy";
import { careerOneStopAdapter } from "./careeronestop";
import { joobleAdapter } from "./jooble";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { ashbyAdapter } from "./ashby";
import { smartRecruitersAdapter } from "./smartrecruiters";
import { remoteOKAdapter } from "./remoteok";
import { arbeitnowAdapter } from "./arbeitnow";
import { himalayasAdapter } from "./himalayas";
import { linkedinAdapter } from "./linkedin";
import { indeedAdapter } from "./indeed";
import { glassdoorAdapter } from "./glassdoor";
import { cache } from "./cache";
import type { JobSourceAdapter } from "./types";
import { getRequestTimeoutMs, splitSearchQuery } from "./utils";
import { classifyNormalizedJob } from "@/lib/jobs/classifier";

const adapters: Partial<Record<JobSource, JobSourceAdapter>> = {
  JSEARCH: jsearchAdapter,
  ADZUNA: adzunaAdapter,
  THE_MUSE: theMuseAdapter,
  USAJOBS: usaJobsAdapter,
  REED: reedAdapter,
  REMOTIVE: remotiveAdapter,
  JOBICY: jobicyAdapter,
  CAREERONESTOP: careerOneStopAdapter,
  JOOBLE: joobleAdapter,
  GREENHOUSE: greenhouseAdapter,
  LEVER: leverAdapter,
  ASHBY: ashbyAdapter,
  SMARTRECRUITERS: smartRecruitersAdapter,
  REMOTEOK: remoteOKAdapter,
  ARBEITNOW: arbeitnowAdapter,
  HIMALAYAS: himalayasAdapter,
  LINKEDIN: linkedinAdapter,
  INDEED: indeedAdapter,
  GLASSDOOR: glassdoorAdapter,
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

function getValidDate(value: Date | undefined): Date | undefined {
  if (!value) return undefined;
  return Number.isNaN(value.getTime()) ? undefined : value;
}

function buildCacheKey(params: JobSearchParams, sources?: JobSource[]): string {
  const locations = params.locations ? [...params.locations].sort() : undefined;
  return JSON.stringify({ ...params, locations, sources: sources?.sort() });
}

function getLocationVariants(params: JobSearchParams): Array<string | undefined> {
  const explicitLocations = params.locations?.map((entry) => entry.trim()).filter(Boolean);
  if (explicitLocations && explicitLocations.length > 0) {
    return [...new Set(explicitLocations)];
  }

  if (params.location?.trim()) {
    return [params.location.trim()];
  }

  return [undefined];
}

function getQueryVariantsForAdapter(
  source: JobSource,
  params: JobSearchParams,
  splitVariants: string[],
): string[] {
  if (source === "JOBICY" || source === "REMOTIVE" || source === "JOOBLE") {
    return [params.query];
  }

  return splitVariants;
}

async function recordSearchQueries(
  userId: string,
  params: JobSearchParams,
  sources: JobSource[],
  jobs: NormalizedJob[],
): Promise<void> {
  try {
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      console.warn(
        `[syncJobsToDb] Skipping search query logging because user ${userId} does not exist in the database`,
      );
      return;
    }

    for (const source of sources) {
      await prisma.searchQuery.create({
        data: {
          userId,
          query: params.query,
          filters: {
            location: params.location,
            locations: params.locations,
            workMode: params.workMode,
          },
          source,
          resultCount: jobs.filter((j) => j.source === source).length,
        },
      });
    }
  } catch (error) {
    console.error("Failed to record search queries:", error);
  }
}

// Paginated adapters need much longer timeouts
const PAGINATED_SOURCES = new Set(["ADZUNA", "JSEARCH", "LINKEDIN", "INDEED", "GLASSDOOR", "ARBEITNOW", "HIMALAYAS", "REMOTEOK"]);

function getAdapterTimeout(source: string): number {
  if (PAGINATED_SOURCES.has(source)) return 120_000; // 2 minutes for paginated
  return getRequestTimeoutMs();
}

async function runAdapterSearch(
  adapter: JobSourceAdapter,
  params: JobSearchParams,
): Promise<NormalizedJob[]> {
  return new Promise((resolve) => {
    const timeoutMs = getAdapterTimeout(adapter.source);
    const timeout = setTimeout(() => {
      console.warn(
        `[searchJobs] ${adapter.source} timed out after ${timeoutMs}ms`,
      );
      resolve([]);
    }, timeoutMs);

    void adapter
      .search(params)
      .then((jobs) => {
        clearTimeout(timeout);
        resolve(jobs);
      })
      .catch((error) => {
        clearTimeout(timeout);
        console.error(
          `[searchJobs] ${adapter.source} failed:`,
          error instanceof Error ? error.message : error,
        );
        resolve([]);
      });
  });
}

export async function searchJobs(
  params: JobSearchParams,
  sources?: JobSource[],
): Promise<NormalizedJob[]> {
  const cacheKey = buildCacheKey(params, sources);
  const cached = cache.get<NormalizedJob[]>(cacheKey);
  if (cached) return cached;

  const baseAdapters = sources
    ? sources
        .map((s) => adapters[s])
        .filter((adapter): adapter is JobSourceAdapter => Boolean(adapter))
    : Object.values(adapters).filter(
        (adapter): adapter is JobSourceAdapter => Boolean(adapter),
      );

  const selectedAdapters = baseAdapters;

  const locationVariants = getLocationVariants(params);

  const searchRequests = selectedAdapters.flatMap((adapter) => {
    const queryVariants = getQueryVariantsForAdapter(
      adapter.source,
      params,
      splitSearchQuery(params.query),
    );

    return queryVariants.flatMap((query) =>
      locationVariants.map((location) =>
        runAdapterSearch(adapter, { ...params, query, location }),
      ),
    );
  });

  const results = await Promise.allSettled(searchRequests);

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
    const classification = classifyNormalizedJob(job);

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
    count++;
  }

  const selectedSources = sources ?? ([
    "JSEARCH",
    "ADZUNA",
    "THE_MUSE",
    "USAJOBS",
    "REED",
    "REMOTIVE",
    "JOBICY",
    "CAREERONESTOP",
    "JOOBLE",
    "GREENHOUSE",
    "LEVER",
    "ASHBY",
    "SMARTRECRUITERS",
    "REMOTEOK",
    "ARBEITNOW",
    "HIMALAYAS",
    "LINKEDIN",
    "INDEED",
    "GLASSDOOR",
  ] as JobSource[]);
  await recordSearchQueries(userId, params, selectedSources, jobs);

  return count;
}
