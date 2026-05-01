import Link from "next/link";
import { Bot } from "lucide-react";
import { JobMetaRow } from "@/components/jobs/job-meta-row";
import {
  formatPostedAge,
  getDeadlineUrgencyAt,
  getExpiringSoonMetaAt,
  shouldShowSubmissionMeta,
} from "@/lib/job-display";
import { cn } from "@/lib/utils";
import type { JobCardData } from "@/types";

type JobSummaryCardProps = {
  job: JobCardData;
  referenceNow?: string;
  footerActions?: React.ReactNode;
};

export function JobSummaryCard({
  job,
  referenceNow,
  footerActions,
}: JobSummaryCardProps) {
  const deadlineUrgency = getDeadlineUrgencyAt(job.deadline, referenceNow);
  const expiringSoon = getExpiringSoonMetaAt(job.deadline, referenceNow);
  const showSubmissionMeta = shouldShowSubmissionMeta(job);

  // Lifecycle cue shown in the secondary row for non-LIVE jobs
  const lifecycleCue = getLifecycleCue(job.status);

  return (
    <article
      className={`group relative overflow-hidden rounded-[26px] border border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.92))] p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)] transition-[transform,box-shadow,border-color] hover:-translate-y-px hover:border-border/90 hover:shadow-[0_18px_44px_rgba(15,23,42,0.08)] dark:bg-[linear-gradient(180deg,rgba(12,18,28,0.96),rgba(10,15,24,0.92))] dark:shadow-[0_18px_44px_rgba(2,6,23,0.24)] sm:p-6 ${
        job.status === "EXPIRED" || job.status === "REMOVED" ? "opacity-60" : ""
      }`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="min-w-0 flex-1 text-[1.08rem] leading-7 font-semibold tracking-tight text-foreground sm:text-[1.18rem]">
                <Link
                  href={`/jobs/${job.id}`}
                  className="transition-colors hover:text-foreground/80 hover:underline underline-offset-4"
                >
                  {job.title}
                </Link>
              </h2>
              {showSubmissionMeta ? (
                <span
                  aria-label="Auto-apply ready"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-700"
                  title="Auto-apply ready"
                >
                  <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : null}
              {expiringSoon ? (
                <span
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center rounded-full border px-2.5 text-[11px] font-medium tracking-normal",
                    expiringSoon.severity === "critical"
                      ? "border-destructive/15 bg-destructive/[0.05] text-destructive/80"
                      : "border-amber-500/15 bg-amber-500/[0.05] text-amber-700/85"
                  )}
                >
                  {expiringSoon.label}
                </span>
              ) : null}
            </div>

            <JobMetaRow
              className="mt-3"
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
          </div>

          {footerActions ? <div className="flex h-8 shrink-0 items-center">{footerActions}</div> : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground/75 sm:text-[13px]">
          <span>{formatPostedAge(job.postedAt, referenceNow)}</span>
          <Sep />
          <span className="font-medium text-muted-foreground/80">{job.roleFamily}</span>
          {lifecycleCue ? (
            <>
              <Sep />
              <span className={`font-medium ${lifecycleCue.color}`}>{lifecycleCue.label}</span>
            </>
          ) : !expiringSoon && deadlineUrgency ? (
            <>
              <Sep />
              <span className={`font-medium ${deadlineUrgency.color}`}>
                {deadlineUrgency.label}
              </span>
            </>
          ) : null}
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
