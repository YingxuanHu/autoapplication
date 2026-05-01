import type {
  JobStatus,
  Prisma,
  SubmissionCategory,
} from "@/generated/prisma/client";
import type { NormalizedJobInput } from "@/lib/ingestion/types";

const DIRECT_SOURCE_TYPES = new Set(["ATS", "COMPANY_JSON", "COMPANY_HTML"]);
const STRUCTURED_SOURCE_TYPES = new Set(["ATS", "BOARD", "COMPANY_JSON"]);
const TRUSTED_QUALITY_KINDS = new Set(["DIRECT_COMPANY", "STRUCTURED_BOARD"]);

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

export function computeNormalizedQualityScore(job: NormalizedJobInput) {
  let score = 20;

  if (job.title.trim().length >= 6) score += 10;
  if (job.company.trim().length >= 2) score += 6;
  if (job.location.trim().length >= 2) score += 6;
  if (job.description.trim().length >= 500) score += 18;
  else if (job.description.trim().length >= 250) score += 10;
  else if (job.description.trim().length >= 120) score += 5;
  if (job.shortSummary.trim().length >= 80) score += 6;
  if (job.applyUrl.trim().length > 0) score += 8;
  if (job.postedAt) score += 8;
  if (job.salaryMin != null || job.salaryMax != null) score += 6;
  if (job.experienceLevel && job.experienceLevel !== "UNKNOWN") score += 4;
  if (job.employmentType !== "UNKNOWN") score += 3;
  if (job.workMode !== "UNKNOWN") score += 3;
  if (job.region) score += 2;

  return clampScore(score);
}

export function computeTrustScore(input: {
  sourceReliability?: number | null;
  sourceType?: string | null;
  sourceQualityKind?: string | null;
  sourceCount?: number;
}) {
  let score = 20;

  if (input.sourceReliability != null) {
    score += input.sourceReliability * 40;
  }
  if (input.sourceType && DIRECT_SOURCE_TYPES.has(input.sourceType)) {
    score += 20;
  }
  if (input.sourceType && STRUCTURED_SOURCE_TYPES.has(input.sourceType)) {
    score += 10;
  }
  if (input.sourceQualityKind && TRUSTED_QUALITY_KINDS.has(input.sourceQualityKind)) {
    score += 10;
  }
  if ((input.sourceCount ?? 0) >= 2) {
    score += 8;
  }
  if ((input.sourceCount ?? 0) >= 3) {
    score += 4;
  }

  return clampScore(score);
}

export function computeFreshnessScore(input: {
  postedAt: Date;
  lastSeenAt?: Date | null;
  lastConfirmedAliveAt?: Date | null;
  status: JobStatus;
  deadline?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const basis = input.lastConfirmedAliveAt ?? input.lastSeenAt ?? input.postedAt;
  const ageDays = Math.max(0, (now.getTime() - basis.getTime()) / (24 * 60 * 60 * 1000));
  let score = 100 - ageDays * 4;

  if (input.status === "AGING") score -= 12;
  if (input.status === "STALE") score -= 28;
  if (input.status === "EXPIRED") score -= 55;
  if (input.status === "REMOVED") score = 0;

  if (input.deadline && input.deadline < now) {
    score = Math.min(score, 10);
  }

  return clampScore(score);
}

export function computeRankingScore(input: {
  qualityScore: number;
  trustScore: number;
  freshnessScore: number;
  sourceCount?: number;
  submissionCategory?: SubmissionCategory | null;
}) {
  let score =
    input.qualityScore * 0.35 +
    input.trustScore * 0.25 +
    input.freshnessScore * 0.4;

  if ((input.sourceCount ?? 0) >= 2) score += 4;
  if ((input.sourceCount ?? 0) >= 3) score += 2;

  if (input.submissionCategory === "AUTO_SUBMIT_READY") score += 3;
  if (input.submissionCategory === "MANUAL_ONLY") score -= 1;

  return clampScore(score);
}

export function buildSearchText(input: {
  title: string;
  company: string;
  location: string;
  roleFamily: string;
  shortSummary: string;
  description: string;
}) {
  return [
    input.title,
    input.company,
    input.location,
    input.roleFamily,
    input.shortSummary,
    input.description.slice(0, 4_000),
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeWarningsJson(
  warnings: Record<string, Prisma.InputJsonValue | null>
) {
  return warnings as Prisma.InputJsonValue;
}
