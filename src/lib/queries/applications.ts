import { prisma } from "@/lib/db";
import {
  getOptionalCurrentProfileId,
  requireCurrentProfileId,
} from "@/lib/current-user";
import { formatDisplayLabel, formatSalary } from "@/lib/job-display";
import { serializeJobDetailData } from "@/lib/job-serialization";
import { recordAction } from "@/lib/queries/behavior";
import {
  syncTrackedApplicationFromSubmission,
  syncTrackedApplicationLifecycleFromSubmission,
} from "@/lib/queries/tracker";
import { resolveATSFiller } from "@/lib/automation/fillers";
import type {
  ApplicationHistoryItem,
  ApplicationHistoryStatus,
  ApplicationPackagePreview,
  ApplicationPackageSummary,
  ApplicationReviewData,
  ApplicationReviewState,
  ApplicationSubmissionSummary,
  JobCardEligibility,
  JobDetailData,
  ResumeVariantSummary,
} from "@/types";
import type { Prisma } from "@/generated/prisma/client";

const NON_TERMINAL_SUBMISSION_STATUSES: ReadonlySet<
  ApplicationSubmissionSummary["status"]
> = new Set([
  "DRAFT",
  "READY",
  "FAILED",
] as const);

export async function getApplicationHistory(): Promise<ApplicationHistoryItem[]> {
  const userId = await requireCurrentProfileId();
  const jobs = await prisma.jobCanonical.findMany({
    where: {
      OR: [
        {
          applicationPackages: {
            some: { userId },
          },
        },
        {
          applicationSubmissions: {
            some: { userId },
          },
        },
      ],
    },
    include: {
      eligibility: true,
      applicationPackages: {
        where: { userId },
        include: {
          resumeVariant: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      applicationSubmissions: {
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });

  return jobs
    .map((job) => serializeApplicationHistoryItem(job))
    .sort(
      (left, right) =>
        new Date(right.latestActivityAt).getTime() -
        new Date(left.latestActivityAt).getTime()
    );
}

export async function getApplicationReviewData(
  jobId: string
): Promise<ApplicationReviewData | null> {
  const userId = await getOptionalCurrentProfileId({ fallbackToDemo: true });
  if (!userId) return null;

  const [job, profile] = await Promise.all([
    prisma.jobCanonical.findUnique({
      where: { id: jobId },
      include: {
        eligibility: true,
        sourceMappings: true,
        savedJobs: {
          where: { userId, status: "ACTIVE" },
          select: { id: true },
        },
        applicationPackages: {
          where: { userId },
          include: {
            resumeVariant: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        applicationSubmissions: {
          where: { userId },
          orderBy: { updatedAt: "desc" },
          take: 5,
        },
      },
    }),
    prisma.userProfile.findUnique({
      where: { id: userId },
      include: {
        resumeVariants: {
          orderBy: { createdAt: "desc" },
        },
      },
    }),
  ]);

  if (!job || !profile) return null;

  const latestPackage = job.applicationPackages[0] ?? null;
  const recommendedResume =
    latestPackage?.resumeVariant ??
    selectRecommendedResumeVariant(job.roleFamily, profile.resumeVariants);

  const detailJob = serializeJobDetail(job);
  const packagePreview = buildPackagePreview(detailJob, profile, recommendedResume);
  const reviewState = getApplicationReviewState(detailJob);
  const atsFiller = resolveATSFiller(job.applyUrl);

  return {
    job: detailJob,
    recommendedResume: recommendedResume
      ? serializeResumeVariant(recommendedResume)
      : null,
    latestPackage: latestPackage
      ? serializeApplicationPackage(latestPackage)
      : null,
    submissions: job.applicationSubmissions.map(serializeApplicationSubmission),
    packagePreview,
    reviewState,
    automationMode: profile.automationMode,
    workAuthorization: profile.workAuthorization,
    atsSupported: atsFiller !== null,
    atsName: atsFiller?.atsName ?? null,
  };
}

export async function prepareApplicationReview(jobId: string) {
  const context = await getMutableApplicationContext(jobId);
  if (!context) throw new Error("Application review context not found");

  const { job, profile, recommendedResume, latestPackage, latestSubmission } = context;
  if (!recommendedResume) {
    throw new Error("No resume variant is available for this application package");
  }

  const packagePreview = buildPackagePreview(serializeJobDetail(job), profile, recommendedResume);
  const packageRecord = await upsertApplicationPackage({
    jobId,
    latestPackageId: latestPackage?.id ?? null,
    resumeVariantId: recommendedResume.id,
    packagePreview,
  });

  const submissionRecord = await upsertApplicationSubmission({
    jobId,
    latestSubmissionId: canUpdateSubmission(latestSubmission?.status)
      ? latestSubmission?.id ?? null
      : null,
    packageId: packageRecord.id,
    status: "READY",
    submissionMethod: "review",
    submittedAt: null,
    notes: "Prepared for review in the apply flow.",
  });

  return {
    package: serializeApplicationPackage({
      ...packageRecord,
      resumeVariant: recommendedResume,
    }),
    submission: serializeApplicationSubmission(submissionRecord),
  };
}

export async function updateApplicationSubmissionStatus(
  jobId: string,
  status: "CONFIRMED" | "FAILED" | "WITHDRAWN"
) {
  const userId = await requireCurrentProfileId();
  const latestSubmission = await prisma.applicationSubmission.findFirst({
    where: { canonicalJobId: jobId, userId },
    orderBy: { updatedAt: "desc" },
  });

  if (!latestSubmission) {
    throw new Error("No submission found to update");
  }

  const updated = await prisma.applicationSubmission.update({
    where: { id: latestSubmission.id },
    data: {
      status,
      notes: `Marked ${status.toLowerCase()} from the apply review flow.`,
    },
  });

  await syncTrackedApplicationLifecycleFromSubmission({
    canonicalJobId: jobId,
    submissionStatus: status,
  });

  return serializeApplicationSubmission(updated);
}

export async function submitApplicationReview(jobId: string) {
  const userId = await requireCurrentProfileId();
  const context = await getMutableApplicationContext(jobId);
  if (!context) throw new Error("Application review context not found");

  const { job, profile, recommendedResume, latestPackage, latestSubmission } = context;
  if (!recommendedResume) {
    throw new Error("No resume variant is available for this application package");
  }

  const packagePreview = buildPackagePreview(serializeJobDetail(job), profile, recommendedResume);
  const packageRecord = await upsertApplicationPackage({
    jobId,
    latestPackageId: latestPackage?.id ?? null,
    resumeVariantId: recommendedResume.id,
    packagePreview,
  });

  const submissionMethod =
    job.eligibility?.submissionCategory === "MANUAL_ONLY" ? "manual" : "review";
  const submittedAt = new Date();

  const submissionRecord = await upsertApplicationSubmission({
    jobId,
    latestSubmissionId: canUpdateSubmission(latestSubmission?.status)
      ? latestSubmission?.id ?? null
      : null,
    packageId: packageRecord.id,
    status: "SUBMITTED",
    submissionMethod,
    submittedAt,
    notes:
      submissionMethod === "manual"
        ? "Marked submitted manually from the apply review flow."
        : "Marked submitted from the apply review flow.",
  });

  await Promise.all([
    recordAction(jobId, "APPLY"),
    prisma.savedJob.upsert({
      where: {
        userId_canonicalJobId: {
          userId,
          canonicalJobId: jobId,
        },
      },
      create: {
        userId,
        canonicalJobId: jobId,
        status: "APPLIED",
      },
      update: {
        status: "APPLIED",
      },
    }),
    syncTrackedApplicationFromSubmission(jobId),
  ]);

  return {
    package: serializeApplicationPackage({
      ...packageRecord,
      resumeVariant: recommendedResume,
    }),
    submission: serializeApplicationSubmission(submissionRecord),
  };
}

async function getMutableApplicationContext(jobId: string) {
  const userId = await requireCurrentProfileId();
  const [job, profile] = await Promise.all([
    prisma.jobCanonical.findUnique({
      where: { id: jobId },
      include: {
        eligibility: true,
        sourceMappings: true,
        savedJobs: {
          where: { userId, status: "ACTIVE" },
          select: { id: true },
        },
        applicationPackages: {
          where: { userId },
          include: { resumeVariant: true },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        applicationSubmissions: {
          where: { userId },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
      },
    }),
    prisma.userProfile.findUnique({
      where: { id: userId },
      include: {
        resumeVariants: {
          orderBy: { createdAt: "desc" },
        },
      },
    }),
  ]);

  if (!job || !profile) return null;

  return {
    job,
    profile,
    recommendedResume:
      job.applicationPackages[0]?.resumeVariant ??
      selectRecommendedResumeVariant(job.roleFamily, profile.resumeVariants),
    latestPackage: job.applicationPackages[0] ?? null,
    latestSubmission: job.applicationSubmissions[0] ?? null,
  };
}

async function upsertApplicationPackage({
  jobId,
  latestPackageId,
  resumeVariantId,
  packagePreview,
}: {
  jobId: string;
  latestPackageId: string | null;
  resumeVariantId: string;
  packagePreview: ApplicationPackagePreview;
}) {
  const userId = await requireCurrentProfileId();
  const data = {
    userId,
    canonicalJobId: jobId,
    resumeVariantId,
    coverLetterContent: null,
    attachedLinks: packagePreview.attachedLinks.reduce<Record<string, string>>(
      (accumulator, entry) => {
        accumulator[entry.label] = entry.value;
        return accumulator;
      },
      {}
    ) as Prisma.InputJsonValue,
    savedAnswers: packagePreview.savedAnswers.reduce<Record<string, string>>(
      (accumulator, entry) => {
        accumulator[entry.label] = entry.value;
        return accumulator;
      },
      {}
    ) as Prisma.InputJsonValue,
    whyItMatches: packagePreview.whyItMatches,
  };

  if (latestPackageId) {
    return prisma.applicationPackage.update({
      where: { id: latestPackageId },
      data,
    });
  }

  return prisma.applicationPackage.create({ data });
}

async function upsertApplicationSubmission({
  jobId,
  latestSubmissionId,
  packageId,
  status,
  submissionMethod,
  submittedAt,
  notes,
}: {
  jobId: string;
  latestSubmissionId: string | null;
  packageId: string;
  status: "READY" | "SUBMITTED";
  submissionMethod: string;
  submittedAt: Date | null;
  notes: string;
}) {
  const userId = await requireCurrentProfileId();
  const data = {
    userId,
    canonicalJobId: jobId,
    packageId,
    status,
    submissionMethod,
    submittedAt,
    notes,
  };

  if (latestSubmissionId) {
    return prisma.applicationSubmission.update({
      where: { id: latestSubmissionId },
      data,
    });
  }

  return prisma.applicationSubmission.create({ data });
}

function selectRecommendedResumeVariant(
  roleFamily: string,
  resumeVariants: Array<{
    id: string;
    label: string;
    targetRoleFamily: string | null;
    content: string | null;
    isDefault: boolean;
  }>
) {
  const normalizedRoleFamily = roleFamily.toLowerCase();

  const exactMatch = resumeVariants.find(
    (resumeVariant) =>
      resumeVariant.targetRoleFamily?.toLowerCase() === normalizedRoleFamily
  );
  if (exactMatch) return exactMatch;

  const partialMatch = resumeVariants.find((resumeVariant) => {
    const targetRoleFamily = resumeVariant.targetRoleFamily?.toLowerCase();
    if (!targetRoleFamily) return false;
    return (
      normalizedRoleFamily.includes(targetRoleFamily) ||
      targetRoleFamily.includes(normalizedRoleFamily)
    );
  });
  if (partialMatch) return partialMatch;

  return (
    resumeVariants.find((resumeVariant) => resumeVariant.isDefault) ??
    resumeVariants[0] ??
    null
  );
}

function serializeJobDetail(job: {
  id: string;
  title: string;
  company: string;
  location: string;
  workMode: JobDetailData["workMode"];
  industry: JobDetailData["industry"];
  status: JobDetailData["status"];
  roleFamily: string;
  experienceLevel: JobDetailData["experienceLevel"];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  shortSummary: string;
  applyUrl: string;
  postedAt: Date;
  deadline: Date | null;
  description: string;
  region: JobDetailData["region"];
  employmentType: JobDetailData["employmentType"];
  eligibility: JobCardEligibility;
  sourceMappings: Array<{
    sourceName: string;
    sourceUrl: string | null;
    isPrimary: boolean;
  }>;
  savedJobs: Array<{ id: string }>;
}): JobDetailData {
  return serializeJobDetailData({
    ...job,
    eligibility: job.eligibility
      ? {
          submissionCategory: job.eligibility.submissionCategory,
          reasonCode: job.eligibility.reasonCode,
          reasonDescription: job.eligibility.reasonDescription,
        }
      : null,
    isSaved: job.savedJobs.length > 0,
  });
}

function serializeResumeVariant(resumeVariant: {
  id: string;
  label: string;
  targetRoleFamily: string | null;
  content: string | null;
  isDefault: boolean;
}): ResumeVariantSummary {
  return {
    id: resumeVariant.id,
    label: resumeVariant.label,
    targetRoleFamily: resumeVariant.targetRoleFamily,
    content: resumeVariant.content,
    isDefault: resumeVariant.isDefault,
  };
}

function serializeApplicationPackage(applicationPackage: {
  id: string;
  resumeVariant: {
    id: string;
    label: string;
    targetRoleFamily: string | null;
    content: string | null;
    isDefault: boolean;
  };
  whyItMatches: string | null;
  coverLetterContent: string | null;
  userNotes: string | null;
  attachedLinks: Prisma.JsonValue;
  savedAnswers: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): ApplicationPackageSummary {
  return {
    id: applicationPackage.id,
    resumeVariant: serializeResumeVariant(applicationPackage.resumeVariant),
    whyItMatches: applicationPackage.whyItMatches,
    coverLetterContent: applicationPackage.coverLetterContent,
    userNotes: applicationPackage.userNotes,
    attachedLinks: jsonObjectToEntries(applicationPackage.attachedLinks),
    savedAnswers: jsonObjectToEntries(applicationPackage.savedAnswers),
    createdAt: applicationPackage.createdAt.toISOString(),
    updatedAt: applicationPackage.updatedAt.toISOString(),
  };
}

function serializeApplicationSubmission(applicationSubmission: {
  id: string;
  status: ApplicationSubmissionSummary["status"];
  submissionMethod: string | null;
  submittedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  packageId: string | null;
}): ApplicationSubmissionSummary {
  return {
    id: applicationSubmission.id,
    status: applicationSubmission.status,
    submissionMethod: applicationSubmission.submissionMethod,
    submittedAt: applicationSubmission.submittedAt?.toISOString() ?? null,
    notes: applicationSubmission.notes,
    createdAt: applicationSubmission.createdAt.toISOString(),
    updatedAt: applicationSubmission.updatedAt.toISOString(),
    packageId: applicationSubmission.packageId,
  };
}

function serializeApplicationHistoryItem(job: {
  id: string;
  title: string;
  company: string;
  location: string;
  workMode: JobDetailData["workMode"];
  industry: JobDetailData["industry"];
  status: JobDetailData["status"];
  roleFamily: string;
  applyUrl: string;
  postedAt: Date;
  eligibility: JobCardEligibility;
  applicationPackages: Array<{
    id: string;
    resumeVariant: {
      id: string;
      label: string;
      targetRoleFamily: string | null;
      content: string | null;
      isDefault: boolean;
    };
    whyItMatches: string | null;
    coverLetterContent: string | null;
    userNotes: string | null;
    attachedLinks: Prisma.JsonValue;
    savedAnswers: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }>;
  applicationSubmissions: Array<{
    id: string;
    status: ApplicationSubmissionSummary["status"];
    submissionMethod: string | null;
    submittedAt: Date | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    packageId: string | null;
  }>;
}): ApplicationHistoryItem {
  const latestPackage = job.applicationPackages[0]
    ? serializeApplicationPackage(job.applicationPackages[0])
    : null;
  const latestSubmission = job.applicationSubmissions[0]
    ? serializeApplicationSubmission(job.applicationSubmissions[0])
    : null;
  const latestStatus = getApplicationHistoryStatus(latestPackage, latestSubmission);
  const latestActivityAt = getLatestActivityAt(latestPackage, latestSubmission, job.postedAt);

  return {
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      workMode: job.workMode,
      industry: job.industry,
      status: job.status,
      roleFamily: job.roleFamily,
      applyUrl: job.applyUrl,
      postedAt: job.postedAt.toISOString(),
      eligibility: job.eligibility,
    },
    latestPackage,
    latestSubmission,
    latestStatus,
    latestActivityAt,
  };
}

function getApplicationHistoryStatus(
  latestPackage: ApplicationPackageSummary | null,
  latestSubmission: ApplicationSubmissionSummary | null
): ApplicationHistoryStatus {
  if (latestSubmission) return latestSubmission.status;
  return latestPackage ? "PACKAGE_ONLY" : "DRAFT";
}

function getLatestActivityAt(
  latestPackage: ApplicationPackageSummary | null,
  latestSubmission: ApplicationSubmissionSummary | null,
  fallback: Date
) {
  const timestamps = [
    latestPackage?.updatedAt,
    latestSubmission?.updatedAt,
  ]
    .filter((value): value is string => value !== null && value !== undefined)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  if (timestamps.length === 0) {
    return fallback.toISOString();
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function buildPackagePreview(
  job: JobDetailData,
  profile: {
    linkedinUrl: string | null;
    githubUrl: string | null;
    portfolioUrl: string | null;
    workAuthorization: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    preferredWorkMode: JobDetailData["workMode"] | null;
    automationMode: ApplicationReviewData["automationMode"];
  },
  recommendedResume: ResumeVariantSummary | null
): ApplicationPackagePreview {
  const attachedLinks = [
    profile.linkedinUrl
      ? { label: "LinkedIn", value: profile.linkedinUrl }
      : null,
    profile.githubUrl ? { label: "GitHub", value: profile.githubUrl } : null,
    profile.portfolioUrl
      ? { label: "Portfolio", value: profile.portfolioUrl }
      : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null);

  const savedAnswers = [
    profile.workAuthorization
      ? { label: "Work authorization", value: profile.workAuthorization }
      : null,
    {
      label: "Salary target",
      value: formatSalary(
        profile.salaryMin,
        profile.salaryMax,
        profile.salaryCurrency
      ),
    },
    profile.preferredWorkMode
      ? {
          label: "Preferred work mode",
          value: formatDisplayLabel(profile.preferredWorkMode),
        }
      : null,
    {
      label: "Automation mode",
      value: formatDisplayLabel(profile.automationMode),
    },
  ].filter((entry): entry is { label: string; value: string } => entry !== null);

  return {
    attachedLinks,
    savedAnswers,
    whyItMatches: buildPackageWhyItMatches(job, recommendedResume),
    coverLetterMode:
      job.eligibility?.submissionCategory === "MANUAL_ONLY"
        ? "No auto-generated cover letter. Manual tailoring is expected."
        : "No custom cover letter yet. This review flow is resume-first.",
  };
}

function buildPackageWhyItMatches(
  job: JobDetailData,
  recommendedResume: ResumeVariantSummary | null
) {
  const reasons = [
    `${job.roleFamily} role family alignment`,
    `${formatDisplayLabel(job.industry)} focus`,
    `${formatDisplayLabel(job.workMode)} work mode fit`,
  ];

  if (recommendedResume) {
    reasons.unshift(`Resume variant: ${recommendedResume.label}`);
  }

  return reasons.join(" · ");
}

function getApplicationReviewState(job: JobDetailData): ApplicationReviewState {
  if (job.status !== "LIVE") return "NOT_ELIGIBLE";
  if (!job.eligibility) return "NOT_ELIGIBLE";
  if (job.eligibility.submissionCategory === "MANUAL_ONLY") return "MANUAL_ONLY";
  return "READY_FOR_REVIEW";
}

function jsonObjectToEntries(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  return Object.entries(value).map(([key, entryValue]) => ({
    label: key,
    value:
      typeof entryValue === "string"
        ? entryValue
        : entryValue === null
          ? "null"
          : JSON.stringify(entryValue),
  }));
}

function canUpdateSubmission(
  status: ApplicationSubmissionSummary["status"] | undefined
) {
  return status ? NON_TERMINAL_SUBMISSION_STATUSES.has(status) : false;
}
