import type {
  ApplicationStatus,
  AutomationMode,
  EmploymentType,
  ExperienceLevel,
  Industry,
  JobCanonical,
  JobEligibility,
  JobStatus,
  JobSourceMapping,
  Region,
  SavedJobStatus,
  SubmissionCategory,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  JobLinkTrust,
  JobLinkTrustLevel,
  JobResolvedLink,
} from "@/lib/job-links";

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
  reviewRequiredCount: number;
  manualOnlyCount: number;
  savedCount: number;
  savedEndingSoonCount: number;
  withheldCount: number;
};

export type JobCardEligibility = {
  submissionCategory: SubmissionCategory;
  reasonCode: string;
  reasonDescription: string;
} | null;

export type JobCardSource = {
  sourceName: string;
  sourceUrl: string | null;
  isPrimary: boolean;
  trust: {
    level: JobLinkTrustLevel;
    label: string;
    summary: string;
  };
};

export type JobCardData = {
  id: string;
  title: string;
  company: string;
  location: string;
  workMode: WorkMode;
  industry: Industry;
  status: JobStatus;
  roleFamily: string;
  experienceLevel: ExperienceLevel | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  shortSummary: string;
  applyUrl: string;
  postedAt: string;
  deadline: string | null;
  isSaved: boolean;
  eligibility: JobCardEligibility;
  sourceMappings: JobCardSource[];
  primaryExternalLink: JobResolvedLink | null;
  sourcePostingLink: JobResolvedLink | null;
  linkTrust: JobLinkTrust;
};

export type JobDetailData = JobCardData & {
  description: string;
  region: Region;
  employmentType: EmploymentType;
};

export type ResumeVariantSummary = {
  id: string;
  label: string;
  targetRoleFamily: string | null;
  content: string | null;
  isDefault: boolean;
};

export type ApplicationPackagePreview = {
  attachedLinks: Array<{ label: string; value: string }>;
  savedAnswers: Array<{ label: string; value: string }>;
  whyItMatches: string;
  coverLetterMode: string;
};

export type ApplicationPackageSummary = {
  id: string;
  resumeVariant: ResumeVariantSummary;
  whyItMatches: string | null;
  coverLetterContent: string | null;
  userNotes: string | null;
  attachedLinks: Array<{ label: string; value: string }>;
  savedAnswers: Array<{ label: string; value: string }>;
  createdAt: string;
  updatedAt: string;
};

export type ApplicationSubmissionSummary = {
  id: string;
  status: ApplicationStatus;
  submissionMethod: string | null;
  submittedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  packageId: string | null;
};

export type ApplicationReviewState =
  | "READY_FOR_REVIEW"
  | "MANUAL_ONLY"
  | "NOT_ELIGIBLE";

export type ApplicationReviewData = {
  job: JobDetailData;
  recommendedResume: ResumeVariantSummary | null;
  latestPackage: ApplicationPackageSummary | null;
  submissions: ApplicationSubmissionSummary[];
  packagePreview: ApplicationPackagePreview;
  reviewState: ApplicationReviewState;
  automationMode: AutomationMode;
  workAuthorization: string | null;
  /** Whether the job's apply URL is handled by a registered ATS filler */
  atsSupported: boolean;
  /** Name of the ATS filler (e.g. "Greenhouse", "Lever"), or null */
  atsName: string | null;
};

export type ApplicationHistoryStatus = ApplicationStatus | "PACKAGE_ONLY";

export type ApplicationHistoryItem = {
  job: {
    id: string;
    title: string;
    company: string;
    location: string;
    workMode: WorkMode;
    industry: Industry;
    status: JobStatus;
    roleFamily: string;
    applyUrl: string;
    postedAt: string;
    eligibility: JobCardEligibility;
  };
  latestPackage: ApplicationPackageSummary | null;
  latestSubmission: ApplicationSubmissionSummary | null;
  latestStatus: ApplicationHistoryStatus;
  latestActivityAt: string;
};

export type SavedJobListItem = {
  id: string;
  status: SavedJobStatus;
  notes: string | null;
  createdAt: string;
  canonicalJob: JobCardData;
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
