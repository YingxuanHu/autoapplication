import { formatDistanceStrict, formatDistanceToNowStrict } from "date-fns";
import type { ApplicationReviewState, JobCardData } from "@/types";

export const SUBMISSION_CATEGORY_META = {
  AUTO_SUBMIT_READY: {
    label: "Auto-apply",
    badgeVariant: "default" as const,
  },
  AUTO_FILL_REVIEW: {
    label: "Manual only",
    badgeVariant: "outline" as const,
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
    label: "Auto-apply ready",
    description:
      "The job is structured well enough for the automated apply flow.",
  },
  MANUAL_ONLY: {
    label: "Manual only",
    description:
      "The system can prepare materials and track the attempt, but the submission itself should stay manual.",
  },
  NOT_ELIGIBLE: {
    label: "Not yet eligible",
    description:
      "The job is not currently suitable for the tracked application flow due to status or missing eligibility data.",
  },
};

export function getSubmissionMeta(job: Pick<JobCardData, "eligibility">) {
  return SUBMISSION_CATEGORY_META[
    job.eligibility?.submissionCategory ?? "MANUAL_ONLY"
  ];
}

export function shouldShowSubmissionMeta(job: Pick<JobCardData, "eligibility">) {
  return job.eligibility?.submissionCategory === "AUTO_SUBMIT_READY";
}

export function getEligibilityReasonDescription(
  eligibility: Pick<JobCardData, "eligibility">["eligibility"]
) {
  if (!eligibility) return "Eligibility has not been evaluated yet.";
  if (eligibility.submissionCategory === "AUTO_FILL_REVIEW") {
    return "This role should stay in the manual application path.";
  }
  return eligibility.reasonDescription;
}

export function formatDisplayLabel(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatPostedAge(
  value: string | Date,
  referenceNow?: string | Date
) {
  if (!referenceNow) {
    return formatDistanceToNowStrict(toDateValue(value), { addSuffix: true });
  }

  return formatDistanceStrict(toDateValue(value), toDateValue(referenceNow), {
    addSuffix: true,
  });
}

export function formatRelativeAge(
  value: string | Date,
  referenceNow?: string | Date
) {
  if (!referenceNow) {
    return formatDistanceToNowStrict(toDateValue(value), { addSuffix: true });
  }

  return formatDistanceStrict(toDateValue(value), toDateValue(referenceNow), {
    addSuffix: true,
  });
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

export type ExpiringSoonMeta = {
  label: string;
  severity: "critical" | "warning";
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

export function getDeadlineUrgencyAt(
  deadline: string | Date | null,
  referenceNow?: string | Date
): DeadlineUrgency | null {
  if (!deadline) return null;
  const now = referenceNow ? toDateValue(referenceNow) : new Date();
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

export function getExpiringSoonMeta(
  deadline: string | Date | null
): ExpiringSoonMeta | null {
  if (!deadline) return null;

  const now = new Date();
  const target = typeof deadline === "string" ? new Date(deadline) : deadline;
  if (Number.isNaN(target.getTime())) return null;

  const msUntil = target.getTime() - now.getTime();
  const daysUntil = Math.ceil(msUntil / (1000 * 60 * 60 * 24));

  if (daysUntil < 0 || daysUntil > 5) return null;
  if (daysUntil === 0) {
    return { label: "Expiring today", severity: "critical" };
  }

  return {
    label: `Expiring in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
    severity: daysUntil === 1 ? "critical" : "warning",
  };
}

export function getExpiringSoonMetaAt(
  deadline: string | Date | null,
  referenceNow?: string | Date
): ExpiringSoonMeta | null {
  if (!deadline) return null;

  const now = referenceNow ? toDateValue(referenceNow) : new Date();
  const target = typeof deadline === "string" ? new Date(deadline) : deadline;
  if (Number.isNaN(target.getTime())) return null;

  const msUntil = target.getTime() - now.getTime();
  const daysUntil = Math.ceil(msUntil / (1000 * 60 * 60 * 24));

  if (daysUntil < 0 || daysUntil > 5) return null;
  if (daysUntil === 0) {
    return { label: "Expiring today", severity: "critical" };
  }

  return {
    label: `Expiring in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
    severity: daysUntil === 1 ? "critical" : "warning",
  };
}

/**
 * Plain deadline value for use in key-fields grids (no "Deadline" prefix).
 * Returns "in 2 days", "2 days ago", etc.
 */
export function formatDeadlineValue(deadline: string | Date | null): string | null {
  if (!deadline) return null;
  return formatDistanceToNowStrict(toDateValue(deadline), { addSuffix: true });
}

export function formatDeadlineValueAt(
  deadline: string | Date | null,
  referenceNow?: string | Date
): string | null {
  if (!deadline) return null;
  if (!referenceNow) {
    return formatDistanceToNowStrict(toDateValue(deadline), { addSuffix: true });
  }

  return formatDistanceStrict(toDateValue(deadline), toDateValue(referenceNow), {
    addSuffix: true,
  });
}

// ─── Shared color helpers ────────────────────────────────────────────────────

/** Tailwind text-color class for a submission category. */
export function submissionCategoryColor(category?: string | null): string {
  switch (category) {
    case "AUTO_SUBMIT_READY":
      return "text-emerald-600";
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

export function getSourceShortName(sourceName: string | null): string | null {
  if (!sourceName) return null;
  if (sourceName.startsWith("Ashby:")) return "AY";
  if (sourceName.startsWith("Greenhouse:")) return "GH";
  if (sourceName.startsWith("Himalayas:")) return "HM";
  if (sourceName.startsWith("Jobicy:")) return "JY";
  if (sourceName.startsWith("iCIMS:")) return "IC";
  if (sourceName.startsWith("Lever:")) return "LV";
  if (sourceName.startsWith("Remotive:")) return "RM";
  if (sourceName.startsWith("Recruitee:")) return "RQ";
  if (sourceName.startsWith("SuccessFactors:")) return "SF";
  if (sourceName.startsWith("Workday:")) return "WD";
  if (sourceName.startsWith("SmartRecruiters:")) return "SR";
  if (sourceName.startsWith("Taleo:")) return "TL";
  if (sourceName.startsWith("TheMuse:")) return "TM";
  if (sourceName.startsWith("Adzuna:")) return "AZ";
  if (sourceName.startsWith("RemoteOK:")) return "RO";
  if (sourceName.startsWith("USAJobs:")) return "UJ";
  if (sourceName.startsWith("Workable:")) return "WB";
  return null;
}
