import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";

import { ApplicationRowActions } from "@/components/jobs/application-row-actions";
import { Button } from "@/components/ui/button";
import {
  formatDisplayLabel,
  formatRelativeAge,
  getSubmissionMeta,
  shouldShowSubmissionMeta,
  submissionCategoryColor,
} from "@/lib/job-display";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getApplicationHistory } from "@/lib/queries/applications";
import type { ApplicationHistoryItem, ApplicationHistoryStatus } from "@/types";

type ApplicationHistoryPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const APPLICATION_FILTERS = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "FAILED", label: "Failed" },
  { value: "WITHDRAWN", label: "Withdrawn" },
] as const;

type ApplicationFilterValue = (typeof APPLICATION_FILTERS)[number]["value"];

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
      return "text-muted-foreground";
  }
}

function statusLabel(status: ApplicationHistoryStatus): string {
  if (status === "PACKAGE_ONLY") return "Package only";
  return formatDisplayLabel(status);
}

export default async function ApplicationHistoryPage({
  searchParams,
}: ApplicationHistoryPageProps) {
  await connection();
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

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
    <div className="app-page space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Apply history</h1>
          <p className="page-description">
            Track package creation and submission state changes across the jobs flow.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {history.length} tracked job{history.length !== 1 ? "s" : ""}
            {activeCount > 0 ? ` · ${activeCount} active` : ""}
            {submittedCount > 0 ? ` · ${submittedCount} submitted` : ""}
          </p>
        </div>
        <div className="page-actions">
          <Link href="/applications">Applications</Link>
          <Link href="/applications?status=WISHLIST">Wishlist</Link>
          <Link href="/jobs">Feed</Link>
        </div>
      </div>

      <section className="surface-panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {APPLICATION_FILTERS.map((filter) => {
            const count =
              filter.value === "ALL"
                ? history.length
                : history.filter((item) =>
                    matchesFilter(item.latestStatus, filter.value)
                  ).length;
            return (
              <Link
                key={filter.value}
                href={
                  filter.value === "ALL"
                    ? "/applications/history"
                    : `/applications/history?status=${filter.value}`
                }
                className={`inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors ${
                  selectedFilter === filter.value
                    ? "bg-foreground text-background"
                    : "bg-background/70 text-muted-foreground hover:bg-muted hover:text-foreground"
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
      </section>

      <section className="surface-panel p-4 sm:p-5">
        {filteredHistory.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background/50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              No applications in this view
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start from your wishlist or feed to create your first tracked
              package and submission record.
            </p>
            <div className="mt-3 flex items-center justify-center gap-3">
              <Link
                href="/applications?status=WISHLIST"
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Open wishlist
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
          <div className="space-y-3">
            {filteredHistory.map((item) => (
              <ApplicationRow key={item.job.id} item={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ApplicationRow({ item }: { item: ApplicationHistoryItem }) {
  const submissionMeta = getSubmissionMeta(item.job);
  const showSubmissionMeta = shouldShowSubmissionMeta(item.job);
  const primaryAction = getPrimaryAction(item);
  const statusSummary = getStatusSummary(item);
  const activityNote = getActivityNote(item);
  const lifecycleLabel = getLifecycleLabel(item.job.status);

  return (
    <article className="rounded-2xl border border-border/70 bg-background/45 p-4 transition-colors hover:bg-background/60">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
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

          <p className="mt-1 text-sm text-muted-foreground">
            {item.job.company}
            <Sep />
            {item.job.location}
            <Sep />
            {formatDisplayLabel(item.job.workMode)}
          </p>

          <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground/80">
            {statusSummary}
          </p>

          <p className="mt-3 text-xs text-muted-foreground/70">
            {showSubmissionMeta ? (
              <>
                <span
                  className={`font-medium ${submissionCategoryColor(item.job.eligibility?.submissionCategory)}`}
                >
                  {submissionMeta.label}
                </span>
                <Sep />
              </>
            ) : null}
            {item.latestPackage
              ? `Resume: ${item.latestPackage.resumeVariant.label}`
              : "No package"}
            <Sep />
            {activityNote}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
          <Button
            size="sm"
            variant={primaryAction.variant}
            render={<Link href={primaryAction.href} />}
          >
            {primaryAction.label}
          </Button>
          <ApplicationRowActions
            jobId={item.job.id}
            latestStatus={item.latestStatus}
          />
        </div>
      </div>
    </article>
  );
}

function getApplicationFilter(
  value: string | string[] | undefined
): ApplicationFilterValue {
  const normalized = Array.isArray(value) ? value[0] : value;
  const candidate = String(normalized ?? "ALL").toUpperCase();
  return APPLICATION_FILTERS.some((filter) => filter.value === candidate)
    ? (candidate as ApplicationFilterValue)
    : "ALL";
}

function getPrimaryAction(item: ApplicationHistoryItem) {
  if (item.latestStatus === "CONFIRMED") {
    return {
      href: "/applications",
      label: "Applications",
      variant: "outline" as const,
    };
  }

  if (item.latestStatus === "SUBMITTED") {
    return {
      href: `/jobs/${item.job.id}/apply`,
      label: "Open application",
      variant: "secondary" as const,
    };
  }

  return {
    href: `/jobs/${item.job.id}/apply`,
    label: item.latestStatus === "FAILED" ? "Retry application" : "Open application",
    variant: item.latestStatus === "FAILED" ? "outline" as const : "default" as const,
  };
}

function getStatusSummary(item: ApplicationHistoryItem) {
  switch (item.latestStatus) {
    case "PACKAGE_ONLY":
      return "A tailored package exists, but no submission has been recorded yet.";
    case "DRAFT":
      return "The application was opened, but the package is still incomplete.";
    case "READY":
      return "The package is prepared and ready for submission.";
    case "SUBMITTED":
      return item.latestSubmission?.notes ?? "Submission recorded and awaiting confirmation.";
    case "CONFIRMED":
      return "Submission confirmed. This job is now part of your tracked applications.";
    case "FAILED":
      return item.latestSubmission?.notes ?? "Submission attempt failed and may need another pass.";
    case "WITHDRAWN":
      return "This application was withdrawn after submission.";
    default:
      return "Application state recorded.";
  }
}

function getActivityNote(item: ApplicationHistoryItem) {
  if (item.latestSubmission?.submittedAt) {
    return `Submitted ${formatRelativeAge(item.latestSubmission.submittedAt)}`;
  }
  if (item.latestPackage?.updatedAt) {
    return `Updated ${formatRelativeAge(item.latestPackage.updatedAt)}`;
  }
  return `Updated ${formatRelativeAge(item.latestActivityAt)}`;
}

function getLifecycleLabel(status: ApplicationHistoryItem["job"]["status"]) {
  if (status === "STALE") {
    return { label: "Stale job", color: "text-amber-600" };
  }
  if (status === "EXPIRED") {
    return { label: "Expired job", color: "text-destructive" };
  }
  return null;
}

function Sep() {
  return <span className="mx-1.5 text-border">·</span>;
}
