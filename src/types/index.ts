import type {
  Job,
  Resume,
  Application,
  UserProfile,
  FeedAction,
  WorkMode,
  ExperienceLevel,
  AutomationLevel,
  ApplicationStatus,
  FeedActionType,
  JobSource,
} from "@/generated/prisma";

export type {
  Job,
  Resume,
  Application,
  UserProfile,
  FeedAction,
  WorkMode,
  ExperienceLevel,
  AutomationLevel,
  ApplicationStatus,
  FeedActionType,
  JobSource,
};

export interface ScoredJob extends Job {
  score: number;
  matchReasons: string[];
}

export interface JobSearchParams {
  query: string;
  location?: string;
  workMode?: WorkMode;
  page?: number;
  limit?: number;
}

export interface NormalizedJob {
  externalId: string;
  source: JobSource;
  title: string;
  company: string;
  companyLogo?: string;
  location?: string;
  workMode?: WorkMode;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  description: string;
  summary?: string;
  url: string;
  applyUrl?: string;
  postedAt?: Date;
  skills: string[];
  jobType?: string;
}

export interface JobSourceAdapter {
  source: JobSource;
  search(params: JobSearchParams): Promise<NormalizedJob[]>;
}
