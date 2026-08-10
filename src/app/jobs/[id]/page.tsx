import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AIWorkspace } from "@/components/jobs/ai-workspace";
import { JobDescriptionSection } from "@/components/jobs/job-description-section";
import { JobDetailActionGroup } from "@/components/jobs/job-detail-action-group";
import { JobDetailScrollReset } from "@/components/jobs/job-detail-scroll-reset";
import { JobMetaRow } from "@/components/jobs/job-meta-row";
import {
  formatDeadlineValue,
  formatDisplayLabel,
  formatPostedAge,
  formatSalary,
  getDeadlineUrgency,
  getExpiringSoonMeta,
} from "@/lib/job-display";
import {
  describeApplyPlatform,
  pickApplyPlatformSourceName,
} from "@/lib/job-trust-display";
import { cn } from "@/lib/utils";
import { getOptionalCurrentUserIds } from "@/lib/current-user";
import {
  getJobsReturnLabel,
  getSafeJobsReturnHref,
} from "@/lib/jobs/return-navigation";
import { getJobDetailPageData } from "@/lib/queries/applications";
import { resolveJobSalaryRange } from "@/lib/salary-extraction";

type JobDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function JobDetailPage({
  params,
  searchParams,
}: JobDetailPageProps) {
  const [currentUser, { id }, resolvedSearchParams] = await Promise.all([
    getOptionalCurrentUserIds(),
    params,
    searchParams,
  ]);
  if (!currentUser) {
    redirect("/sign-in");
  }

  const fromParam = getFirstSearchParamValue(resolvedSearchParams, "from");
  const returnHref = getSafeJobsReturnHref(fromParam) ?? "/jobs";
  const returnLabel = getJobsReturnLabel(returnHref);
  const detailData = await getJobDetailPageData(id, currentUser);

  if (!detailData) {
    notFound();
  }

  const { job, reviewState, latestSubmission } = detailData;
  const deadlineUrgency = getDeadlineUrgency(job.deadline);
  const expiringSoon = getExpiringSoonMeta(job.deadline);
  const deadlineValue = formatDeadlineValue(job.deadline);
  const applyModeLabel =
    reviewState === "NOT_ELIGIBLE" ? "Unavailable" : "Employer site";
  const applyPlatformLabel = describeApplyPlatform(
    pickApplyPlatformSourceName(job.sourceMappings)
  );
  const manualApplyHref =
    job.primaryExternalLink?.href ?? job.sourcePostingLink?.href ?? job.applyUrl;
  const displaySalary = resolveJobSalaryRange({
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    description: job.description,
    regionHint: job.region,
  });
  const hasAppliedStatus = detailData.hasApplied;

  return (
    <div className="app-page space-y-5">
      <JobDetailScrollReset jobId={job.id} />

      {/* Breadcrumb */}
      <div>
        <Link
          href={returnHref}
          scroll={false}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← {returnLabel}
        </Link>
      </div>

      {/* Header — stacks on mobile, row on sm+ */}
      <div className="surface-panel flex flex-col gap-5 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-[1.35rem] font-semibold leading-snug tracking-tight sm:text-2xl">
              {job.title}
            </h1>
            {expiringSoon ? (
              <span
                className={cn(
                  "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-normal",
                  expiringSoon.severity === "critical"
                    ? "border-destructive/15 bg-destructive/[0.04] text-destructive/80"
                    : "border-amber-500/15 bg-amber-500/[0.04] text-amber-700/80 dark:text-amber-300/80"
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
            primaryExternalLink={null}
          />
        </div>

        <JobDetailActionGroup
          applyHref={manualApplyHref}
          initialApplied={hasAppliedStatus}
          initialSaved={job.isSaved && !hasAppliedStatus}
          jobId={job.id}
        />
      </div>

      {/* Lifecycle notice — shown for aging and degraded lifecycle states */}
      {job.status === "AGING" ||
      job.status === "STALE" ||
      job.status === "EXPIRED" ||
      job.status === "REMOVED" ? (
        <div className="rounded-[14px] border border-border/70 bg-card p-4">
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
      <div className="surface-panel grid grid-cols-2 gap-x-4 gap-y-4 p-4 sm:grid-cols-4 sm:gap-x-8 sm:p-5">
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
        <Field label="Apply method" value={applyModeLabel} />
        {applyPlatformLabel ? (
          <Field label="Application platform" value={applyPlatformLabel} />
        ) : null}
      </div>

      {latestSubmission ? (
        <div className="flex items-center justify-end rounded-[14px] border border-border/70 bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {formatDisplayLabel(latestSubmission.status)}
            {latestSubmission.submittedAt
              ? ` · submitted ${formatPostedAge(latestSubmission.submittedAt)}`
              : ""}
          </p>
        </div>
      ) : null}

      <JobDescriptionSection job={job} showSourceLink={false} />

      {/* AI workspace — same fit analysis and cover-letter tools used by tracked applications. */}
      {process.env.OPENAI_API_KEY ? (
        <div className="surface-panel p-5 sm:p-6">
          <p className="text-sm font-medium text-muted-foreground">
            AI workspace
          </p>
          <div className="mt-4">
            <AIWorkspace
              company={job.company}
              jobId={job.id}
              jobTitle={job.title}
              showCoverLetter
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DETAIL_SECTION_TITLE_CLASS = "text-sm font-medium text-muted-foreground";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={DETAIL_SECTION_TITLE_CLASS}>{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function getFirstSearchParamValue(
  params: Record<string, string | string[] | undefined>,
  key: string
) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}
