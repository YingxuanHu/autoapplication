import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Bot } from "lucide-react";
import { JobDescriptionSection } from "@/components/jobs/job-description-section";
import { JobDetailActions } from "@/components/jobs/job-detail-actions";
import { ManualApplyMenu } from "@/components/jobs/manual-apply-menu";
import { JobMetaRow } from "@/components/jobs/job-meta-row";
import { Button } from "@/components/ui/button";
import {
  APPLICATION_REVIEW_STATE_META,
  formatDeadlineValue,
  formatDisplayLabel,
  formatPostedAge,
  formatSalary,
  getDeadlineUrgency,
  getExpiringSoonMeta,
  getSubmissionMeta,
  shouldShowSubmissionMeta,
} from "@/lib/job-display";
import { cn } from "@/lib/utils";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getApplicationReviewData } from "@/lib/queries/applications";
import { resolveJobSalaryRange } from "@/lib/salary-extraction";

type JobDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function JobDetailPage({ params }: JobDetailPageProps) {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const { id } = await params;
  const detailData = await getApplicationReviewData(id);

  if (!detailData) {
    notFound();
  }

  const { job, reviewState, submissions } = detailData;
  const latestSubmission = submissions[0] ?? null;
  const submissionMeta = getSubmissionMeta(job);
  const reviewStateMeta = APPLICATION_REVIEW_STATE_META[reviewState];
  const deadlineUrgency = getDeadlineUrgency(job.deadline);
  const expiringSoon = getExpiringSoonMeta(job.deadline);
  const deadlineValue = formatDeadlineValue(job.deadline);
  const canStartApplyFlow =
    reviewState !== "NOT_ELIGIBLE" &&
    job.status !== "EXPIRED" &&
    job.status !== "REMOVED";
  const showSubmissionMeta = shouldShowSubmissionMeta(job);
  const manualApplyHref =
    job.primaryExternalLink?.href ?? job.sourcePostingLink?.href ?? job.applyUrl;
  const displaySalary = resolveJobSalaryRange({
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    description: job.description,
    regionHint: job.region,
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Breadcrumb */}
      <div className="mb-3">
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          ← Jobs
        </Link>
      </div>

      {/* Header — stacks on mobile, row on sm+ */}
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{job.title}</h1>
            {showSubmissionMeta ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/[0.06] px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-emerald-700">
                <Bot className="h-3 w-3" aria-hidden="true" />
                {submissionMeta.label}
              </span>
            ) : null}
            {expiringSoon ? (
              <span
                className={cn(
                  "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-normal",
                  expiringSoon.severity === "critical"
                    ? "border-destructive/15 bg-destructive/[0.04] text-destructive/80"
                    : "border-amber-500/15 bg-amber-500/[0.04] text-amber-700/80"
                )}
              >
                {expiringSoon.label}
              </span>
            ) : null}
          </div>

          <JobMetaRow
            company={job.company}
            location={job.location}
            geoScope={job.geoScope}
            workMode={job.workMode}
            salaryMin={displaySalary.salaryMin}
            salaryMax={displaySalary.salaryMax}
            salaryCurrency={displaySalary.salaryCurrency}
            primaryExternalLink={job.primaryExternalLink}
          />
        </div>

        {canStartApplyFlow ? (
          <div className="flex shrink-0 items-center gap-2">
            {reviewState === "MANUAL_ONLY" ? (
              <ManualApplyMenu
                align="end"
                applyHref={manualApplyHref}
                buttonSize="sm"
                jobId={job.id}
              />
            ) : job.eligibility?.submissionCategory === "AUTO_SUBMIT_READY" ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={`/jobs/${job.id}/apply`} />}
                >
                  Prepare documentation
                </Button>
                <Button size="sm" render={<Link href={`/jobs/${job.id}/auto-apply`} />}>
                  Auto apply
                </Button>
              </>
            ) : (
              <Button size="sm" render={<Link href={`/jobs/${job.id}/apply`} />}>
                Apply
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {/* Lifecycle notice — shown for aging and degraded lifecycle states */}
      {job.status === "AGING" ||
      job.status === "STALE" ||
      job.status === "EXPIRED" ||
      job.status === "REMOVED" ? (
        <div className="border-t border-border py-3">
          <p
            className={`text-sm ${
              job.status === "EXPIRED" || job.status === "REMOVED"
                ? "text-destructive"
                : job.status === "AGING"
                  ? "text-amber-500"
                  : "text-amber-600"
            }`}
          >
            {job.status === "EXPIRED"
              ? "This posting has expired — the application window is likely closed."
              : job.status === "REMOVED"
                ? "This posting disappeared from a high-confidence source and is likely no longer active."
                : job.status === "AGING"
                  ? "This posting is still visible, but source evidence is weakening and it should be verified before you rely on it."
                  : "This posting hasn't been reconfirmed recently and may no longer be active."}
          </p>
        </div>
      ) : null}

      {/* Key fields */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-t border-border py-4 sm:grid-cols-4">
        <Field
          label="Salary"
          value={
            formatSalary(
              displaySalary.salaryMin,
              displaySalary.salaryMax,
              displaySalary.salaryCurrency
            ) || "—"
          }
        />
        <Field label="Posted" value={formatPostedAge(job.postedAt)} />
        {/* Deadline field — colored when urgent */}
        <div>
          <p className={DETAIL_SECTION_TITLE_CLASS}>Deadline</p>
          <p
            className={`mt-1 text-sm font-medium ${
              expiringSoon
                ? expiringSoon.severity === "critical"
                  ? "text-destructive"
                  : "text-amber-700"
                : deadlineUrgency
                  ? deadlineUrgency.color
                  : "text-foreground"
            }`}
          >
            {deadlineValue ?? "None listed"}
          </p>
        </div>
        <Field label="Automation" value={reviewStateMeta.label} />
      </div>

      {/* Save / Pass + submission status */}
      <div className="flex items-center justify-between border-t border-border py-3">
        <JobDetailActions jobId={job.id} initialSaved={job.isSaved} />
        {latestSubmission ? (
          <p className="text-xs text-muted-foreground">
            {formatDisplayLabel(latestSubmission.status)}
            {latestSubmission.submittedAt
              ? ` · submitted ${formatPostedAge(latestSubmission.submittedAt)}`
              : ""}
          </p>
        ) : null}
      </div>

      <JobDescriptionSection job={job} />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DETAIL_SECTION_TITLE_CLASS = "text-[15px] font-medium text-muted-foreground";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={DETAIL_SECTION_TITLE_CLASS}>{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
