import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { ApplicationReviewActions } from "@/components/jobs/application-review-actions";
import {
  APPLICATION_REVIEW_STATE_META,
  formatDisplayLabel,
  formatPostedAge,
  formatSalary,
  getSourceShortName,
  getSubmissionMeta,
  submissionCategoryColor,
} from "@/lib/job-display";
import { getApplicationReviewData } from "@/lib/queries/applications";

type JobApplyPageProps = {
  params: Promise<{ id: string }>;
};

export default async function JobApplyPage({ params }: JobApplyPageProps) {
  const { id } = await params;
  const reviewData = await getApplicationReviewData(id);

  if (!reviewData) {
    notFound();
  }

  const {
    automationMode,
    job,
    latestPackage,
    packagePreview,
    recommendedResume,
    reviewState,
    submissions,
    workAuthorization,
  } = reviewData;

  const latestSubmission = submissions[0] ?? null;
  const submissionMeta = getSubmissionMeta(job);
  const reviewStateMeta = APPLICATION_REVIEW_STATE_META[reviewState];
  const canCreatePackage = recommendedResume !== null;
  const sourceShortName = getSourceShortName(job.primaryExternalLink?.sourceName ?? null);

  // Compact status strip values
  const packageState = latestPackage ? "Package ready" : "No package";
  const submissionState = latestSubmission
    ? `${formatDisplayLabel(latestSubmission.status)}${
        latestSubmission.submittedAt
          ? ` · ${formatPostedAge(latestSubmission.submittedAt)}`
          : latestSubmission.updatedAt
            ? ` · ${formatPostedAge(latestSubmission.updatedAt)}`
            : ""
      }`
    : "Not submitted";

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Breadcrumb + external link */}
      <div className="mb-3 flex items-center gap-3">
        <Link
          href={`/jobs/${job.id}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Details
        </Link>
        {job.primaryExternalLink ? (
          <a
            href={job.primaryExternalLink.href}
            target="_blank"
            rel="noreferrer"
            title={`${job.primaryExternalLink.label} · ${job.primaryExternalLink.sourceName ?? "external source"}`}
            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
          >
            {sourceShortName ? (
              <span className="font-semibold uppercase tracking-wide">{sourceShortName}</span>
            ) : null}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      {/* Header */}
      <div className="pb-3">
        <p className="mb-0.5 text-xs text-muted-foreground">Apply review</p>
        <h1 className="text-xl font-semibold tracking-tight">{job.title}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {job.company}
          <Sep />
          {job.location}
        </p>
      </div>

      {/* Compact status strip */}
      <div className="border-t border-border py-2.5">
        <p className="text-xs text-muted-foreground">
          <span className={submissionCategoryColor(job.eligibility?.submissionCategory)}>
            {submissionMeta.label}
          </span>
          <Sep />
          {packageState}
          <Sep />
          {submissionState}
        </p>
      </div>

      {/* Primary actions — first thing the user acts on */}
      <div className="border-t border-border py-4">
        <ApplicationReviewActions
          jobId={job.id}
          reviewState={reviewState}
          latestPackageId={latestPackage?.id ?? null}
          latestSubmission={latestSubmission}
          canCreatePackage={canCreatePackage}
        />
      </div>

      {/* Resume — what will be used */}
      <div className="border-t border-border py-4">
        <p className="mb-1.5 text-xs text-muted-foreground">Resume</p>
        {recommendedResume ? (
          <>
            <p className="text-sm font-medium text-foreground">
              {recommendedResume.label}
              {recommendedResume.isDefault ? (
                <span className="ml-2 text-xs text-muted-foreground">(default)</span>
              ) : null}
              {recommendedResume.targetRoleFamily ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  · {recommendedResume.targetRoleFamily}
                </span>
              ) : null}
            </p>
            {recommendedResume.content ? (
              <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                {recommendedResume.content}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add a resume variant in{" "}
            <Link href="/profile" className="underline underline-offset-2 hover:text-foreground">
              your profile
            </Link>{" "}
            before preparing a package.
          </p>
        )}
      </div>

      {/* Submission history — visible if there are any */}
      {submissions.length > 0 ? (
        <div className="border-t border-border py-4">
          <p className="mb-3 text-xs text-muted-foreground">Submission history</p>
          <div className="space-y-3">
            {submissions.map((submission) => (
              <div
                key={submission.id}
                className="border-b border-border/60 pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {formatDisplayLabel(submission.status)}
                  </span>
                  {submission.submissionMethod ? (
                    <span className="text-xs text-muted-foreground">
                      {formatDisplayLabel(submission.submissionMethod)}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatPostedAge(submission.updatedAt)}
                  {submission.submittedAt
                    ? ` · submitted ${formatPostedAge(submission.submittedAt)}`
                    : ""}
                </p>
                {submission.notes ? (
                  <p className="mt-1 text-xs text-muted-foreground">{submission.notes}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Eligibility context — collapsed, available for reference */}
      <details className="border-t border-border">
        <summary className="flex cursor-pointer list-none py-3 text-sm text-muted-foreground hover:text-foreground">
          Eligibility details
        </summary>
        <div className="space-y-2 pb-4">
          <p className="text-sm text-muted-foreground">{reviewStateMeta.description}</p>
          {job.eligibility?.reasonDescription ? (
            <p className="text-sm text-muted-foreground">{job.eligibility.reasonDescription}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">{job.linkTrust.summary}</p>
        </div>
      </details>

      {/* Package preview — collapsed */}
      <details className="border-t border-border">
        <summary className="flex cursor-pointer list-none py-3 text-sm text-muted-foreground hover:text-foreground">
          Package preview
        </summary>
        <div className="space-y-3 pb-4">
          {packagePreview.attachedLinks.length > 0 ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Attached links</p>
              <div className="space-y-1">
                {packagePreview.attachedLinks.map((entry) => (
                  <KV key={entry.label} label={entry.label} value={entry.value} />
                ))}
              </div>
            </div>
          ) : null}
          {packagePreview.savedAnswers.length > 0 ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Saved answers</p>
              <div className="space-y-1">
                {packagePreview.savedAnswers.map((entry) => (
                  <KV key={entry.label} label={entry.label} value={entry.value} />
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">{packagePreview.whyItMatches}</p>
          <p className="text-xs text-muted-foreground">
            Cover letter: {packagePreview.coverLetterMode}
          </p>
        </div>
      </details>

      {/* Latest saved package record — collapsed */}
      {latestPackage ? (
        <details className="border-t border-border">
          <summary className="flex cursor-pointer list-none py-3 text-sm text-muted-foreground hover:text-foreground">
            Package record
          </summary>
          <div className="pb-4">
            <p className="text-sm font-medium text-foreground">
              {latestPackage.resumeVariant.label}
            </p>
            <p className="text-xs text-muted-foreground">
              Updated {formatPostedAge(latestPackage.updatedAt)}
            </p>
            {[...latestPackage.attachedLinks, ...latestPackage.savedAnswers].length > 0 ? (
              <div className="mt-2 space-y-1">
                {[...latestPackage.attachedLinks, ...latestPackage.savedAnswers].map((entry) => (
                  <KV key={entry.label} label={entry.label} value={entry.value} />
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      {/* Job quick facts — collapsed, for reference during apply */}
      <details className="border-t border-border">
        <summary className="flex cursor-pointer list-none py-3 text-sm text-muted-foreground hover:text-foreground">
          Job details
        </summary>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 pb-4 sm:grid-cols-4">
          <Field
            label="Salary"
            value={formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency)}
          />
          <Field label="Work mode" value={formatDisplayLabel(job.workMode)} />
          <Field label="Work auth" value={workAuthorization ?? "Not set"} />
          <Field label="Automation mode" value={formatDisplayLabel(automationMode)} />
        </div>
      </details>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}:</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}

function Sep() {
  return <span className="mx-1.5 text-border">·</span>;
}

