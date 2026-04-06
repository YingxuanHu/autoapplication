import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { JobDetailActions } from "@/components/jobs/job-detail-actions";
import { ManualApplyMenu } from "@/components/jobs/manual-apply-menu";
import { JobMetaRow } from "@/components/jobs/job-meta-row";
import { Button } from "@/components/ui/button";
import {
  fetchFormattedJobDescriptionFromUrl,
  getJobDescriptionSummaryBlocks,
  isJobDescriptionSummaryUsable,
  isLowQualityJobDescription,
  pickBestFormattedJobDescription,
  parseJobDescriptionBlocks,
} from "@/lib/job-description-format";
import {
  APPLICATION_REVIEW_STATE_META,
  formatDeadlineValue,
  formatDisplayLabel,
  formatPostedAge,
  formatSalary,
  getDeadlineUrgency,
  getSubmissionMeta,
  shouldShowSubmissionMeta,
  submissionCategoryColor,
} from "@/lib/job-display";
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
  const deadlineValue = formatDeadlineValue(job.deadline);
  // EXPIRED jobs: show detail but block the apply flow
  const canStartApplyFlow = reviewState !== "NOT_ELIGIBLE" && job.status !== "EXPIRED";
  const showSubmissionMeta = shouldShowSubmissionMeta(job);
  const manualApplyHref =
    job.primaryExternalLink?.href ?? job.sourcePostingLink?.href ?? job.applyUrl;
  const descriptionSourceUrl =
    job.sourcePostingLink?.href ?? job.primaryExternalLink?.href ?? job.applyUrl;
  const storedDescriptionLowQuality = isLowQualityJobDescription(job.description);
  const fetchedDescription =
    storedDescriptionLowQuality && descriptionSourceUrl
      ? await fetchFormattedJobDescriptionFromUrl(descriptionSourceUrl)
      : null;
  const displayDescription =
    pickBestFormattedJobDescription([fetchedDescription, job.description]) ?? job.description;
  const displaySalary = resolveJobSalaryRange({
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    description: displayDescription,
    regionHint: job.region,
  });
  const summaryBlocks = getJobDescriptionSummaryBlocks(displayDescription, 8);
  const descriptionBlocks =
    summaryBlocks.length > 0 ? summaryBlocks : parseJobDescriptionBlocks(displayDescription);
  const descriptionUsable = isJobDescriptionSummaryUsable(displayDescription);
  const sourceAccessFailed = storedDescriptionLowQuality && descriptionSourceUrl && !fetchedDescription;

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
            workMode={job.workMode}
            salaryMin={displaySalary.salaryMin}
            salaryMax={displaySalary.salaryMax}
            salaryCurrency={displaySalary.salaryCurrency}
            primaryExternalLink={job.primaryExternalLink}
          />
        </div>

        {canStartApplyFlow ? (
          <div className="shrink-0">
            {reviewState === "MANUAL_ONLY" ? (
              <ManualApplyMenu
                align="end"
                applyHref={manualApplyHref}
                buttonSize="sm"
                jobId={job.id}
              />
            ) : (
              <Button size="sm" render={<Link href={`/jobs/${job.id}/apply`} />}>
                Apply
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {/* Lifecycle notice — only shown for STALE or EXPIRED */}
      {job.status === "STALE" || job.status === "EXPIRED" ? (
        <div className="border-t border-border py-3">
          <p
            className={`text-sm ${
              job.status === "EXPIRED" ? "text-destructive" : "text-amber-600"
            }`}
          >
            {job.status === "EXPIRED"
              ? "This posting has expired — the application window is likely closed."
              : "This posting hasn't been confirmed in a recent crawl and may no longer be active."}
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
              deadlineUrgency ? deadlineUrgency.color : "text-foreground"
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

      {/* Full description */}
      <div className="border-t border-border py-4">
        <p className={DETAIL_SECTION_TITLE_CLASS}>Description</p>
        <div className="mt-4 space-y-4 pl-4 text-sm text-foreground/80">
          {descriptionUsable
            ? descriptionBlocks.map((block, i) => {
            if (block.kind === "header") {
              return (
                <p
                  key={i}
                  className="pt-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-foreground/65 first:pt-0"
                >
                  {block.text}
                </p>
              );
            }
            if (block.kind === "list") {
              return (
                <ul key={i} className="ml-6 space-y-2 list-disc marker:text-muted-foreground/50">
                  {block.items.map((item, j) => (
                    <li key={j} className="leading-8">
                      {item}
                    </li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={i} className="pl-4 leading-8">
                {block.text}
              </p>
            );
          })
            : null}
          {!descriptionUsable ? (
            <p className="pl-4 text-sm leading-8 text-muted-foreground">
              {sourceAccessFailed
                ? "The original job posting could not be accessed automatically, so a reliable description summary is not available."
                : "A reliable description summary was not available from the current source."}{" "}
              {descriptionSourceUrl ? "Open the posting link for the original page." : ""}
            </p>
          ) : null}
        </div>
      </div>
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
