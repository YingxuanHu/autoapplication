import type {
  JobCanonical,
  JobEligibility,
  JobSourceMapping,
} from "@/generated/prisma";

export type JobWithEligibility = JobCanonical & {
  eligibility: JobEligibility | null;
  sourceMappings: JobSourceMapping[];
  isSaved: boolean;
};

export type FeedStats = {
  totalLive: number;
  newLast24h: number;
  expiredCount: number;
  autoEligibleCount: number;
  savedCount: number;
};

export type JobFilters = {
  search?: string;
  region?: string;
  workMode?: string;
  industry?: string;
  roleFamily?: string;
  salaryMin?: string;
  experienceLevel?: string;
  submissionCategory?: string;
  status?: string;
  sortBy?: "relevance" | "freshness" | "salary";
  page?: string;
};
