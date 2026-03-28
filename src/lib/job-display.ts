import { formatDistanceToNowStrict } from "date-fns";
import type { ApplicationReviewState, JobCardData } from "@/types";

export const SUBMISSION_CATEGORY_META = {
  AUTO_SUBMIT_READY: {
    label: "Auto-apply",
    badgeVariant: "default" as const,
  },
  AUTO_FILL_REVIEW: {
    label: "Review required",
    badgeVariant: "secondary" as const,
  },
  MANUAL_ONLY: {
    label: "Manual only",
    badgeVariant: "outline" as const,
  },
};

export const APPLICATION_REVIEW_STATE_META: Record<
  ApplicationReviewState,
  {
    label: string;
    description: string;
  }
> = {
  READY_FOR_REVIEW: {
    label: "Ready for review",
    description:
      "The job fits the current review flow and can move into package preparation.",
  },
  MANUAL_ONLY: {
    label: "Manual only",
    description:
      "The system can prepare materials and track the attempt, but the submission itself should stay manual.",
  },
  NOT_ELIGIBLE: {
    label: "Not yet eligible",
    description:
      "The job is not currently suitable for the tracked review flow due to status or missing eligibility data.",
  },
};

export const JOB_LINK_TRUST_META = {
  TRUSTED: {
    badgeVariant: "secondary" as const,
  },
  CAUTION: {
    badgeVariant: "outline" as const,
  },
  UNAVAILABLE: {
    badgeVariant: "destructive" as const,
  },
};

export function getSubmissionMeta(job: Pick<JobCardData, "eligibility">) {
  return SUBMISSION_CATEGORY_META[
    job.eligibility?.submissionCategory ?? "MANUAL_ONLY"
  ];
}

export function getLinkTrustMeta(job: Pick<JobCardData, "linkTrust">) {
  return JOB_LINK_TRUST_META[job.linkTrust.level];
}

export function getPrimarySource(job: Pick<JobCardData, "sourceMappings">) {
  return (
    job.sourceMappings.find((mapping) => mapping.isPrimary) ??
    job.sourceMappings[0] ??
    null
  );
}

export function formatDisplayLabel(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatPostedAge(value: string | Date) {
  return formatDistanceToNowStrict(toDateValue(value), { addSuffix: true });
}

export function formatRelativeAge(value: string | Date) {
  return formatDistanceToNowStrict(toDateValue(value), { addSuffix: true });
}

export function formatDeadline(value: string | Date | null) {
  if (!value) return null;
  return `Deadline ${formatDistanceToNowStrict(toDateValue(value), { addSuffix: true })}`;
}

export function formatSalary(
  salaryMin: number | null,
  salaryMax: number | null,
  salaryCurrency: string | null
) {
  if (!salaryMin && !salaryMax) return "";

  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: salaryCurrency ?? "USD",
    maximumFractionDigits: 0,
  });

  if (salaryMin && salaryMax) {
    return `${formatter.format(salaryMin)} - ${formatter.format(salaryMax)}`;
  }

  if (salaryMin) return `${formatter.format(salaryMin)}+`;
  return `Up to ${formatter.format(salaryMax ?? 0)}`;
}

export function buildWhyShown(job: JobCardData) {
  const reasons = [
    `${formatDisplayLabel(job.industry)} target`,
    `${formatDisplayLabel(job.workMode)} work mode`,
    `${job.roleFamily} role family`,
  ];

  if (job.eligibility?.submissionCategory === "AUTO_SUBMIT_READY") {
    reasons.unshift("Auto-apply eligible now");
  } else if (job.eligibility?.submissionCategory === "AUTO_FILL_REVIEW") {
    reasons.unshift("Strong automation candidate with review");
  }

  if (job.sourceMappings.length > 1) {
    reasons.push("Seen across multiple sources");
  }

  return reasons.slice(0, 4);
}

function toDateValue(value: string | Date) {
  return value instanceof Date ? value : new Date(value);
}

// ─── Deadline urgency ────────────────────────────────────────────────────────

export type DeadlineUrgency = {
  /** Short human label, e.g. "Closes today", "Closes in 3 days" */
  label: string;
  /** Tailwind text-color class */
  color: string;
};

/**
 * Returns an urgency descriptor when a deadline is within 7 days, null otherwise.
 * Also returns a descriptor for already-passed deadlines so callers can surface
 * that a job has a closed posting window.
 */
export function getDeadlineUrgency(deadline: string | Date | null): DeadlineUrgency | null {
  if (!deadline) return null;
  const now = new Date();
  const target = typeof deadline === "string" ? new Date(deadline) : deadline;
  const msUntil = target.getTime() - now.getTime();
  const daysUntil = Math.ceil(msUntil / (1000 * 60 * 60 * 24));

  if (daysUntil < 0) return { label: "Deadline passed", color: "text-destructive" };
  if (daysUntil === 0) return { label: "Closes today", color: "text-destructive" };
  if (daysUntil === 1) return { label: "Closes tomorrow", color: "text-amber-600" };
  if (daysUntil <= 3) return { label: `Closes in ${daysUntil} days`, color: "text-amber-600" };
  if (daysUntil <= 7) return { label: `Closes in ${daysUntil} days`, color: "text-muted-foreground" };
  return null;
}

/**
 * Plain deadline value for use in key-fields grids (no "Deadline" prefix).
 * Returns "in 2 days", "2 days ago", etc.
 */
export function formatDeadlineValue(deadline: string | Date | null): string | null {
  if (!deadline) return null;
  return formatDistanceToNowStrict(toDateValue(deadline), { addSuffix: true });
}

// ─── Shared color helpers ────────────────────────────────────────────────────

/** Tailwind text-color class for a submission category. */
export function submissionCategoryColor(category?: string | null): string {
  switch (category) {
    case "AUTO_SUBMIT_READY":
      return "text-emerald-600";
    case "AUTO_FILL_REVIEW":
      return "text-amber-600";
    default:
      return "text-muted-foreground";
  }
}

/** Tailwind text-color class for a link/source trust level. */
export function trustLevelColor(level: string): string {
  if (level === "TRUSTED") return "text-emerald-600";
  if (level === "CAUTION") return "text-amber-600";
  return "text-muted-foreground";
}

/**
 * Short uppercase ATS identifier derived from a connector source name.
 * "Greenhouse:vercel" → "GH", "Lever:stripe" → "LV", "SmartRecruiters:…" → "SR".
 * Returns null for unknown or demo sources so no badge is shown.
 */
/**
 * Extract a short, scannable snippet from a job's shortSummary.
 * Strips section-header prefixes ("ABOUT THE ROLE", etc.) and generic
 * boilerplate intros ("X is hiring a Y...") before truncating.
 * Returns null if the result is too generic to be useful.
 */
export function buildDescriptionSnippet(shortSummary: string | null | undefined): string | null {
  if (!shortSummary?.trim()) return null;

  let text = shortSummary
    .trim()
    .replace(/^[\s>*•\-–—]+/, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 24) return null;

  // Strip leading section labels (e.g. "ABOUT THE ROLE ", "THE ROLE: ")
  text = text.replace(/^(about the role|the role|about this role|role overview|position overview)[:\s]*/i, "").trim();

  // Skip generic boilerplate: "X is hiring a Y. ... Join a fast-moving team..."
  if (/is hiring (a|an) .+\.\s*(fully remote|on-site|hybrid|remote-friendly)?/i.test(text) &&
      /join a fast-moving team/i.test(text)) {
    return null;
  }

  // Skip degenerate snippets that collapse to just company name + work mode
  if (/^[A-Z][A-Za-z0-9&' .-]{0,40}(remote-friendly|on-site expectation|hybrid schedule|flexible work arrangement)\.?$/i.test(text)) {
    return null;
  }

  // Truncate cleanly at a word boundary
  const MAX = 160;
  if (text.length <= MAX) return text;
  const truncated = text.slice(0, MAX);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

export function getSourceShortName(sourceName: string | null): string | null {
  if (!sourceName) return null;
  if (sourceName.startsWith("Ashby:")) return "AY";
  if (sourceName.startsWith("Greenhouse:")) return "GH";
  if (sourceName.startsWith("iCIMS:")) return "IC";
  if (sourceName.startsWith("Lever:")) return "LV";
  if (sourceName.startsWith("Recruitee:")) return "RQ";
  if (sourceName.startsWith("SuccessFactors:")) return "SF";
  if (sourceName.startsWith("Workday:")) return "WD";
  if (sourceName.startsWith("SmartRecruiters:")) return "SR";
  if (sourceName.startsWith("Taleo:")) return "TL";
  return null;
}
