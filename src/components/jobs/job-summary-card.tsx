import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildDescriptionSnippet,
  formatPostedAge,
  formatSalary,
  formatDisplayLabel,
  getDeadlineUrgency,
  getSourceShortName,
  getSubmissionMeta,
  submissionCategoryColor,
} from "@/lib/job-display";
import type { JobCardData } from "@/types";

type JobSummaryCardProps = {
  job: JobCardData;
  primaryAction?: React.ReactNode;
  footerActions?: React.ReactNode;
};

export function JobSummaryCard({
  job,
  primaryAction,
  footerActions,
}: JobSummaryCardProps) {
  const submissionMeta = getSubmissionMeta(job);
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency);
  const sourceShortName = getSourceShortName(job.primaryExternalLink?.sourceName ?? null);
  const deadlineUrgency = getDeadlineUrgency(job.deadline);
  const snippet = buildDescriptionSnippet(job.shortSummary);

  // Apply is only available for live, eligible jobs
  const canStartApplyFlow =
    job.status === "LIVE" && job.eligibility !== null;

  // Lifecycle cue shown in the secondary row for non-LIVE jobs
  const lifecycleCue = getLifecycleCue(job.status);

  return (
    <article
      className={`border-b border-border/60 py-4 first:pt-0 last:border-b-0 last:pb-0 ${
        job.status === "EXPIRED" ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: primary info */}
        <div className="min-w-0 flex-1">
          {/* Title + classification */}
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-[15px] font-semibold text-foreground">
              <Link href={`/jobs/${job.id}`} className="hover:underline underline-offset-2">
                {job.title}
              </Link>
            </h2>
            <span
              className={`shrink-0 text-xs font-medium ${submissionCategoryColor(job.eligibility?.submissionCategory)}`}
            >
              {submissionMeta.label}
            </span>
          </div>

          {/* Meta: company (with inline ATS trust cue) · location · workMode · salary */}
          <p className="mt-0.5 text-sm text-muted-foreground">
            {job.company}
            {job.primaryExternalLink ? (
              <a
                href={job.primaryExternalLink.href}
                target="_blank"
                rel="noreferrer"
                title={`${job.primaryExternalLink.label} · ${job.primaryExternalLink.sourceName ?? "external source"}`}
                className="ml-1 inline-flex items-center gap-0.5 align-middle opacity-40 transition-opacity hover:opacity-80"
              >
                {sourceShortName ? (
                  <span className="text-[10px] font-semibold uppercase leading-none tracking-wide">
                    {sourceShortName}
                  </span>
                ) : null}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            <Sep />
            {job.location}
            <Sep />
            {formatDisplayLabel(job.workMode)}
            {salary ? (
              <>
                <Sep />
                {salary}
              </>
            ) : null}
          </p>

          {/* Description snippet */}
          {snippet ? (
            <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground/80">
              {snippet}
            </p>
          ) : null}

          {/* Secondary: age · role family · lifecycle/deadline cues */}
          <p className="mt-1 text-xs text-muted-foreground/70">
            {formatPostedAge(job.postedAt)}
            <Sep />
            {job.roleFamily}
            {lifecycleCue ? (
              <>
                <Sep />
                <span className={`font-medium ${lifecycleCue.color}`}>{lifecycleCue.label}</span>
              </>
            ) : deadlineUrgency ? (
              <>
                <Sep />
                <span className={`font-medium ${deadlineUrgency.color}`}>
                  {deadlineUrgency.label}
                </span>
              </>
            ) : null}
          </p>
        </div>

        {/* Right: actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {primaryAction ??
            (canStartApplyFlow ? (
              <Button size="sm" render={<Link href={`/jobs/${job.id}/apply`} />}>
                {job.eligibility?.submissionCategory === "MANUAL_ONLY" ? "Apply manually" : "Apply"}
              </Button>
            ) : null)}
          {footerActions}
        </div>
      </div>
    </article>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Sep() {
  return <span className="mx-1.5 text-border">·</span>;
}

/**
 * Returns a lifecycle label + color for STALE and EXPIRED jobs.
 * Returns null for LIVE (no indicator needed).
 */
function getLifecycleCue(status: string): { label: string; color: string } | null {
  switch (status) {
    case "STALE":
      return { label: "Stale", color: "text-amber-600" };
    case "EXPIRED":
      return { label: "Expired", color: "text-destructive" };
    default:
      return null;
  }
}
