import { prisma } from "@/lib/db";
import { DEMO_USER_ID, PAGE_SIZE } from "@/lib/constants";
import type { Prisma } from "@/generated/prisma";

export type JobFilterParams = {
  search?: string;
  region?: string;
  workMode?: string;
  industry?: string;
  roleFamily?: string;
  salaryMin?: number;
  experienceLevel?: string;
  submissionCategory?: string;
  status?: string;
  sortBy?: string;
  page?: number;
};

export async function getJobs(filters: JobFilterParams) {
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;

  const where: Prisma.JobCanonicalWhereInput = {};

  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search, mode: "insensitive" } },
      { company: { contains: filters.search, mode: "insensitive" } },
      { roleFamily: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  if (filters.region) {
    const regions = filters.region.split(",");
    where.region = { in: regions as ("US" | "CA")[] };
  }

  if (filters.workMode) {
    const modes = filters.workMode.split(",");
    where.workMode = {
      in: modes as ("REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE")[],
    };
  }

  if (filters.industry) {
    const industries = filters.industry.split(",");
    where.industry = { in: industries as ("TECH" | "FINANCE")[] };
  }

  if (filters.roleFamily) {
    where.roleFamily = { contains: filters.roleFamily, mode: "insensitive" };
  }

  if (filters.salaryMin) {
    where.salaryMax = { gte: filters.salaryMin };
  }

  if (filters.experienceLevel) {
    const levels = filters.experienceLevel.split(",");
    where.experienceLevel = {
      in: levels as ("ENTRY" | "MID" | "SENIOR" | "LEAD" | "EXECUTIVE")[],
    };
  }

  if (filters.submissionCategory) {
    where.eligibility = {
      submissionCategory: filters.submissionCategory as
        | "AUTO_SUBMIT_READY"
        | "AUTO_FILL_REVIEW"
        | "MANUAL_ONLY",
    };
  }

  if (filters.status) {
    where.status = filters.status as
      | "LIVE"
      | "EXPIRED"
      | "REMOVED"
      | "STALE";
  } else {
    // Default: only show live jobs
    where.status = "LIVE";
  }

  // Build orderBy
  let orderBy: Prisma.JobCanonicalOrderByWithRelationInput = {
    postedAt: "desc",
  };
  if (filters.sortBy === "salary") {
    orderBy = { salaryMax: "desc" };
  }
  // "relevance" just uses default (postedAt desc for now)

  const [jobs, total] = await Promise.all([
    prisma.jobCanonical.findMany({
      where,
      include: {
        eligibility: true,
        sourceMappings: true,
        savedJobs: {
          where: { userId: DEMO_USER_ID },
          select: { id: true },
        },
      },
      orderBy,
      skip,
      take: PAGE_SIZE,
    }),
    prisma.jobCanonical.count({ where }),
  ]);

  // Transform to add isSaved flag
  const data = jobs.map((job) => {
    const { savedJobs, ...rest } = job;
    return {
      ...rest,
      isSaved: savedJobs.length > 0,
    };
  });

  return { data, total, page, pageSize: PAGE_SIZE };
}

export async function getJobById(id: string) {
  const job = await prisma.jobCanonical.findUnique({
    where: { id },
    include: {
      eligibility: true,
      sourceMappings: true,
      savedJobs: {
        where: { userId: DEMO_USER_ID },
        select: { id: true },
      },
    },
  });

  if (!job) return null;

  const { savedJobs, ...rest } = job;
  return {
    ...rest,
    isSaved: savedJobs.length > 0,
  };
}

export async function getFeedStats() {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [totalLive, newLast24h, expiredCount, autoEligibleCount, savedCount] =
    await Promise.all([
      prisma.jobCanonical.count({ where: { status: "LIVE" } }),
      prisma.jobCanonical.count({
        where: { status: "LIVE", createdAt: { gte: oneDayAgo } },
      }),
      prisma.jobCanonical.count({ where: { status: "EXPIRED" } }),
      prisma.jobCanonical.count({
        where: {
          status: "LIVE",
          eligibility: { submissionCategory: "AUTO_SUBMIT_READY" },
        },
      }),
      prisma.savedJob.count({
        where: { userId: DEMO_USER_ID, status: "ACTIVE" },
      }),
    ]);

  return { totalLive, newLast24h, expiredCount, autoEligibleCount, savedCount };
}
