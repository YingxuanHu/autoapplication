import Link from "next/link";
import { JobMetaRow } from "@/components/jobs/job-meta-row";
import { ManualApplyMenu } from "@/components/jobs/manual-apply-menu";
import { Button } from "@/components/ui/button";
import {
  formatPostedAge,
  getDeadlineUrgency,
  getSubmissionMeta,
  shouldShowSubmissionMeta,
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
  const deadlineUrgency = getDeadlineUrgency(job.deadline);
  const showSubmissionMeta = shouldShowSubmissionMeta(job);

  // Apply is available for active jobs unless they are explicitly expired/removed.
  const canStartApplyFlow =
    job.status !== "EXPIRED" && job.status !== "REMOVED" && job.eligibility !== null;
  const manualApplyHref =
    job.primaryExternalLink?.href ?? job.sourcePostingLink?.href ?? job.applyUrl;

  // Lifecycle cue shown in the secondary row for non-LIVE jobs
  const lifecycleCue = getLifecycleCue(job.status);

  return (
    <article
      className={`rounded-2xl border border-border/70 bg-background/45 p-4 transition-colors hover:bg-background/60 ${
        job.status === "EXPIRED" || job.status === "REMOVED" ? "opacity-60" : ""
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
            {showSubmissionMeta ? (
              <span
                className={`shrink-0 text-xs font-medium ${submissionCategoryColor(job.eligibility?.submissionCategory)}`}
              >
                {submissionMeta.label}
              </span>
            ) : null}
          </div>

          <JobMetaRow
            company={job.company}
            location={job.location}
            geoScope={job.geoScope}
            workMode={job.workMode}
            salaryMin={job.salaryMin}
            salaryMax={job.salaryMax}
            salaryCurrency={job.salaryCurrency}
            primaryExternalLink={job.primaryExternalLink}
            variant="card"
          />

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
              job.eligibility?.submissionCategory === "AUTO_SUBMIT_READY" ? (
                <Button size="sm" render={<Link href={`/jobs/${job.id}/apply`} />} variant="secondary">
                  Apply
                </Button>
              ) : (
                <ManualApplyMenu
                  align="end"
                  applyHref={manualApplyHref}
                  buttonSize="sm"
                  buttonVariant="secondary"
                  jobId={job.id}
                />
              )
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
 * Returns a lifecycle label + color for non-primary lifecycle states.
 * Returns null for LIVE.
 */
function getLifecycleCue(status: string): { label: string; color: string } | null {
  switch (status) {
    case "AGING":
      return { label: "Aging", color: "text-amber-500" };
    case "STALE":
      return { label: "Stale", color: "text-amber-600" };
    case "EXPIRED":
      return { label: "Expired", color: "text-destructive" };
    case "REMOVED":
      return { label: "Removed", color: "text-destructive" };
    default:
      return null;
  }
}
