import Link from "next/link";
import { connection } from "next/server";
import { ApplicationRowActions } from "@/components/jobs/application-row-actions";
import { Button } from "@/components/ui/button";
import {
  formatDisplayLabel,
  formatRelativeAge,
  getSubmissionMeta,
  submissionCategoryColor,
} from "@/lib/job-display";
import { getApplicationHistory } from "@/lib/queries/applications";
import type { ApplicationHistoryItem, ApplicationHistoryStatus } from "@/types";

type ApplicationsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// ─── Filter config ────────────────────────────────────────────────────────────

const APPLICATION_FILTERS = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "In review" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "FAILED", label: "Failed" },
  { value: "WITHDRAWN", label: "Withdrawn" },
] as const;

type ApplicationFilterValue = (typeof APPLICATION_FILTERS)[number]["value"];

/** ACTIVE = any in-progress state that hasn't been formally submitted yet */
const ACTIVE_STATUSES: ApplicationHistoryStatus[] = [
  "DRAFT",
  "PACKAGE_ONLY",
  "READY",
];

function matchesFilter(
  status: ApplicationHistoryStatus,
  filter: ApplicationFilterValue
): boolean {
  if (filter === "ALL") return true;
  if (filter === "ACTIVE") return ACTIVE_STATUSES.includes(status);
  return status === filter;
}

// ─── Status display ───────────────────────────────────────────────────────────

function statusColor(status: ApplicationHistoryStatus): string {
  switch (status) {
    case "CONFIRMED":
      return "text-emerald-600";
    case "SUBMITTED":
      return "text-foreground";
    case "READY":
      return "text-amber-600";
    case "FAILED":
      return "text-destructive";
    case "WITHDRAWN":
      return "text-muted-foreground";
    default:
      // DRAFT, PACKAGE_ONLY
      return "text-muted-foreground";
  }
}

function statusLabel(status: ApplicationHistoryStatus): string {
  if (status === "PACKAGE_ONLY") return "Package only";
  return formatDisplayLabel(status);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ApplicationsPage({
  searchParams,
}: ApplicationsPageProps) {
  await connection();

  const resolvedSearchParams = await searchParams;
  const selectedFilter = getApplicationFilter(resolvedSearchParams.status);
  const history = await getApplicationHistory();
  const activeCount = history.filter((item) =>
    matchesFilter(item.latestStatus, "ACTIVE")
  ).length;
  const submittedCount = history.filter((item) =>
    matchesFilter(item.latestStatus, "SUBMITTED")
  ).length;

  const filteredHistory = history.filter((item) =>
    matchesFilter(item.latestStatus, selectedFilter)
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Applications</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {history.length} tracked job{history.length !== 1 ? "s" : ""}
            {activeCount > 0 ? ` · ${activeCount} in review` : ""}
            {submittedCount > 0 ? ` · ${submittedCount} submitted` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/saved"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Saved
          </Link>
          <Link
            href="/jobs"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Feed
          </Link>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        {APPLICATION_FILTERS.map((filter) => {
          const count =
            filter.value === "ALL"
              ? history.length
              : history.filter((i) => matchesFilter(i.latestStatus, filter.value))
                  .length;
          return (
            <Link
              key={filter.value}
              href={
                filter.value === "ALL"
                  ? "/applications"
                  : `/applications?status=${filter.value}`
              }
              className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm font-medium transition-colors ${
                selectedFilter === filter.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {filter.label}
              {count > 0 ? (
                <span className="ml-1.5 text-xs opacity-60">{count}</span>
              ) : null}
            </Link>
          );
        })}
      </div>

      {/* List */}
      <div className="pt-1">
        {filteredHistory.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              No applications in this view
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start from your shortlist or feed to create your first tracked
              package and submission record.
            </p>
            <div className="mt-3 flex items-center justify-center gap-3">
              <Link
                href="/saved"
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Open saved jobs
              </Link>
              <Link
                href="/jobs"
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Browse jobs
              </Link>
            </div>
          </div>
        ) : (
          <div>
            {filteredHistory.map((item) => (
              <ApplicationRow key={item.job.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function ApplicationRow({ item }: { item: ApplicationHistoryItem }) {
  const submissionMeta = getSubmissionMeta(item.job);
  const primaryAction = getPrimaryAction(item);
  const statusSummary = getStatusSummary(item);
  const activityNote = getActivityNote(item);
  const lifecycleLabel = getLifecycleLabel(item.job.status);

  return (
    <article className="border-b border-border/60 py-4 first:pt-2 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Title + status */}
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="truncate text-[15px] font-semibold text-foreground">
              <Link
                href={`/jobs/${item.job.id}`}
                className="hover:underline underline-offset-2"
              >
                {item.job.title}
              </Link>
            </h2>
            <span
              className={`shrink-0 text-xs font-medium ${statusColor(item.latestStatus)}`}
            >
              {statusLabel(item.latestStatus)}
            </span>
            {lifecycleLabel ? (
              <span className={`shrink-0 text-xs font-medium ${lifecycleLabel.color}`}>
                {lifecycleLabel.label}
              </span>
            ) : null}
          </div>

          {/* Company · location · work mode */}
          <p className="mt-0.5 text-sm text-muted-foreground">
            {item.job.company}
            <Sep />
            {item.job.location}
            <Sep />
            {formatDisplayLabel(item.job.workMode)}
          </p>

          <p className="mt-1 text-sm text-foreground/80">{statusSummary}</p>

          {/* Submission category · resume · activity */}
          <p className="mt-1 text-xs text-muted-foreground/70">
            <span
              className={`font-medium ${submissionCategoryColor(item.job.eligibility?.submissionCategory)}`}
            >
              {submissionMeta.label}
            </span>
            <Sep />
            {item.latestPackage
              ? `Resume: ${item.latestPackage.resumeVariant.label}`
              : "No package"}
            <Sep />
            {activityNote}
          </p>
        </div>

        {/* Actions column */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button
            size="sm"
            variant={primaryAction.variant}
            render={<Link href={primaryAction.href} />}
          >
            {primaryAction.label}
          </Button>
          <div className="flex items-center gap-2">
            <Link
              href={`/jobs/${item.job.id}`}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Details
            </Link>
            {primaryAction.href !== `/jobs/${item.job.id}/apply` ? (
              <Link
                href={`/jobs/${item.job.id}/apply`}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Review
              </Link>
            ) : null}
          </div>
          <ApplicationRowActions
            jobId={item.job.id}
            latestStatus={item.latestStatus}
          />
        </div>
      </div>
    </article>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Sep() {
  return <span className="mx-1.5 text-border">·</span>;
}

function getApplicationFilter(
  value: string | string[] | undefined
): ApplicationFilterValue {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  return APPLICATION_FILTERS.some((filter) => filter.value === normalizedValue)
    ? (normalizedValue as ApplicationFilterValue)
    : "ALL";
}

function getPrimaryAction(item: ApplicationHistoryItem) {
  switch (item.latestStatus) {
    case "DRAFT":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "Start review",
        variant: "default" as const,
      };
    case "PACKAGE_ONLY":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "Continue review",
        variant: "default" as const,
      };
    case "READY":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "Finish review",
        variant: "default" as const,
      };
    case "SUBMITTED":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "View review",
        variant: "secondary" as const,
      };
    case "CONFIRMED":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "View review",
        variant: "secondary" as const,
      };
    case "FAILED":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "Revisit",
        variant: "outline" as const,
      };
    case "WITHDRAWN":
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "View review",
        variant: "outline" as const,
      };
    default:
      return {
        href: `/jobs/${item.job.id}/apply`,
        label: "Review",
        variant: "outline" as const,
      };
  }
}

function getStatusSummary(item: ApplicationHistoryItem) {
  const lifecycleSuffix =
    item.job.status === "LIVE"
      ? ""
      : " The posting is no longer fully live, so use this as a tracking view.";

  switch (item.latestStatus) {
    case "DRAFT":
      return `No review package yet. Open review to choose a resume and start the application package.${lifecycleSuffix}`;
    case "PACKAGE_ONLY":
      return `A package exists, but it has not been moved into a ready submission state yet.${lifecycleSuffix}`;
    case "READY":
      return `This application is prepared and waiting for a final submit decision.${lifecycleSuffix}`;
    case "SUBMITTED":
      return "Submitted and waiting for an outcome update.";
    case "CONFIRMED":
      return "Outcome recorded as confirmed.";
    case "FAILED":
      return "Outcome recorded as unsuccessful.";
    case "WITHDRAWN":
      return "Application was withdrawn from consideration.";
    default:
      return "Tracked in the application review flow.";
  }
}

function getActivityNote(item: ApplicationHistoryItem) {
  const latestSubmission = item.latestSubmission;

  if (!latestSubmission) {
    return item.latestPackage
      ? `Package updated ${formatRelativeAge(item.latestPackage.updatedAt)}`
      : `Opened ${formatRelativeAge(item.latestActivityAt)}`;
  }

  if (latestSubmission.status === "SUBMITTED" && latestSubmission.submittedAt) {
    return `Submitted ${formatRelativeAge(latestSubmission.submittedAt)} via ${
      latestSubmission.submissionMethod ?? "tracked flow"
    }`;
  }

  if (latestSubmission.status === "READY") {
    return `Ready for submission · updated ${formatRelativeAge(latestSubmission.updatedAt)}`;
  }

  return `${statusLabel(latestSubmission.status)} · updated ${formatRelativeAge(
    latestSubmission.updatedAt
  )}`;
}

function getLifecycleLabel(status: ApplicationHistoryItem["job"]["status"]) {
  switch (status) {
    case "STALE":
      return { label: "Stale posting", color: "text-amber-600" };
    case "EXPIRED":
      return { label: "Expired posting", color: "text-destructive" };
    case "REMOVED":
      return { label: "Removed posting", color: "text-muted-foreground" };
    default:
      return null;
  }
}
