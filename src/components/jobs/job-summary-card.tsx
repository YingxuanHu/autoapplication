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
      className={`rounded-2xl border border-border/70 bg-background/45 p-4 transition-colors hover:bg-background/60 ${
        job.status === "EXPIRED" ? "opacity-60" : ""
      }`}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-[15px] font-semibold text-foreground">
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

          <p className="mt-1 text-sm text-muted-foreground">
            {job.company}
            {job.primaryExternalLink ? (
              <a
                href={job.primaryExternalLink.href}
                target="_blank"
                rel="noreferrer"
                title={`${job.primaryExternalLink.label} · ${job.primaryExternalLink.sourceName ?? "external source"}`}
                className="ml-1 inline-flex items-center gap-0.5 align-middle opacity-50 transition-opacity hover:opacity-90"
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

          {snippet ? (
            <p className="mt-2 line-clamp-2 max-w-3xl text-[13px] leading-6 text-muted-foreground/85">
              {snippet}
            </p>
          ) : null}

          <p className="mt-3 text-xs text-muted-foreground/70">
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

        <div className="flex shrink-0 items-center gap-2 self-start">
          {primaryAction ??
            (canStartApplyFlow ? (
              <Button size="sm" render={<Link href={`/jobs/${job.id}/apply`} />} variant="secondary">
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
