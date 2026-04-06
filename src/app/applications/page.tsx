import Link from "next/link";
import { redirect } from "next/navigation";

import { ApplicationsOverviewBar } from "@/components/applications/applications-overview-bar";
import { DeleteApplicationButton } from "@/components/applications/delete-application-button";
import { getOptionalSessionUser } from "@/lib/current-user";
import {
  getTrackedDashboardData,
  type TrackerDeadlineFilter,
  type TrackerSortFilter,
} from "@/lib/queries/tracker";
import {
  formatTrackerDate,
  TRACKED_STATUS_LABEL,
  trackedStatusClass,
} from "@/lib/tracker-ui";

type ApplicationsSearchParams = {
  status?: string;
  deadline?: string;
  sort?: string;
  tags?: string;
};

function parseStatusFilter(rawValue?: string) {
  const value = String(rawValue ?? "ALL").toUpperCase();
  if (
    value === "ALL" ||
    value === "WISHLIST" ||
    value === "PREPARING" ||
    value === "APPLIED" ||
    value === "SCREEN" ||
    value === "INTERVIEW" ||
    value === "OFFER" ||
    value === "REJECTED" ||
    value === "WITHDRAWN"
  ) {
    return value;
  }
  return "ALL";
}

function parseDeadlineFilter(rawValue?: string): TrackerDeadlineFilter {
  const value = String(rawValue ?? "ALL").toUpperCase();
  if (
    value === "UPCOMING" ||
    value === "OVERDUE" ||
    value === "NO_DEADLINE"
  ) {
    return value;
  }
  return "ALL";
}

function parseSortFilter(rawValue?: string): TrackerSortFilter {
  const value = String(rawValue ?? "UPDATED_DESC").toUpperCase();
  if (
    value === "UPDATED_ASC" ||
    value === "DEADLINE_ASC" ||
    value === "DEADLINE_DESC" ||
    value === "COMPANY_ASC" ||
    value === "COMPANY_DESC"
  ) {
    return value;
  }
  return "UPDATED_DESC";
}

function buildApplicationsUrl(input: {
  status?: string;
  deadline?: string;
  sort?: string;
  tags?: string[];
}) {
  const params = new URLSearchParams();
  if (input.status && input.status !== "ALL") params.set("status", input.status);
  if (input.deadline && input.deadline !== "ALL") params.set("deadline", input.deadline);
  if (input.sort && input.sort !== "UPDATED_DESC") params.set("sort", input.sort);
  if (input.tags && input.tags.length > 0) params.set("tags", input.tags.join(","));
  const query = params.toString();
  return query ? `/applications?${query}` : "/applications";
}

function toggleTag(selectedTags: string[], tag: string) {
  return selectedTags.includes(tag)
    ? selectedTags.filter((value) => value !== tag)
    : [...selectedTags, tag].sort((left, right) => left.localeCompare(right));
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<ApplicationsSearchParams>;
}) {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const params = await searchParams;
  const status = parseStatusFilter(params.status);
  const deadline = parseDeadlineFilter(params.deadline);
  const sort = parseSortFilter(params.sort);
  const selectedTags = String(params.tags ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  const data = await getTrackedDashboardData({
    status: status as Parameters<typeof getTrackedDashboardData>[0]["status"],
    deadline,
    sort,
    tags: selectedTags,
  });
  const expiredCount = data.applications.filter(
    (application) => application.canonicalJob?.status === "EXPIRED"
  ).length;
  const hasActiveFilters =
    status !== "ALL" ||
    deadline !== "ALL" ||
    sort !== "UPDATED_DESC" ||
    selectedTags.length > 0;

  return (
    <div className="app-page space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Applications</h1>
          <p className="page-description">
            Track feed submissions and manual applications in one workflow.
          </p>
        </div>
        <div className="page-actions">
          <Link href="/applications/history">Apply history</Link>
          <Link href="/notifications">
            Notifications
            {data.unreadNotificationCount > 0 ? ` (${data.unreadNotificationCount})` : ""}
          </Link>
          <Link href="/jobs">Feed</Link>
        </div>
      </div>

      <ApplicationsOverviewBar
        shownCount={data.applications.length}
        totalCount={data.totalApplicationCount}
        activeCount={data.activeCount}
        expiredCount={expiredCount}
      />

      <section className="surface-panel p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Your applications</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Jobs submitted from the feed appear here automatically.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <Link href="/documents/compare" className="hover:text-foreground">
              Compare documents
            </Link>
            <Link href="/settings" className="hover:text-foreground">
              Settings
            </Link>
          </div>
        </div>

        <form
          method="GET"
          className="mt-4 grid gap-3 rounded-xl border border-border/60 bg-background/60 p-4 lg:grid-cols-[1fr_1fr_1fr_auto]"
        >
          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Status
            </span>
            <select
              name="status"
              defaultValue={status}
              className="h-9 rounded-lg border border-input/80 bg-background/70 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="ALL">All statuses</option>
              <option value="WISHLIST">Wishlist</option>
              <option value="PREPARING">Preparing</option>
              <option value="APPLIED">Applied</option>
              <option value="SCREEN">Screen</option>
              <option value="INTERVIEW">Interview</option>
              <option value="OFFER">Offer</option>
              <option value="REJECTED">Rejected</option>
              <option value="WITHDRAWN">Withdrawn</option>
            </select>
          </label>

          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Deadline
            </span>
            <select
              name="deadline"
              defaultValue={deadline}
              className="h-9 rounded-lg border border-input/80 bg-background/70 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="ALL">All deadlines</option>
              <option value="UPCOMING">Upcoming</option>
              <option value="OVERDUE">Overdue</option>
              <option value="NO_DEADLINE">No deadline</option>
            </select>
          </label>

          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sort
            </span>
            <select
              name="sort"
              defaultValue={sort}
              className="h-9 rounded-lg border border-input/80 bg-background/70 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="UPDATED_DESC">Updated (newest)</option>
              <option value="UPDATED_ASC">Updated (oldest)</option>
              <option value="DEADLINE_ASC">Deadline (earliest)</option>
              <option value="DEADLINE_DESC">Deadline (latest)</option>
              <option value="COMPANY_ASC">Company (A-Z)</option>
              <option value="COMPANY_DESC">Company (Z-A)</option>
            </select>
          </label>

          <div className="flex items-end gap-3">
            {selectedTags.length > 0 ? (
              <input type="hidden" name="tags" value={selectedTags.join(",")} />
            ) : null}
            <button
              type="submit"
              className="h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background"
            >
              Apply
            </button>
            {hasActiveFilters ? (
              <Link
                href="/applications"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Reset
              </Link>
            ) : null}
          </div>
        </form>

        {data.userTags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {data.userTags.map((tag) => {
              const active = selectedTags.includes(tag.name);
              return (
                <Link
                  key={tag.id}
                  href={buildApplicationsUrl({
                    status,
                    deadline,
                    sort,
                    tags: toggleTag(selectedTags, tag.name),
                  })}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tag.name}
                </Link>
              );
            })}
          </div>
        ) : null}

        <div className="mt-4">
          {data.applications.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                No applications in this view
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a manual entry or use the jobs feed to start building your tracker.
              </p>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-border/60">
              {data.applications.map((application) => (
                <li
                  key={application.id}
                  className="py-4 first:pt-0 last:pb-0"
                  id={`application-${application.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/applications/${application.id}`}
                          className="inline-block max-w-full truncate text-base font-semibold text-foreground transition hover:underline"
                        >
                          {application.company}
                        </Link>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${trackedStatusClass(application.status)}`}
                        >
                          {TRACKED_STATUS_LABEL[application.status]}
                        </span>
                        {application.canonicalJob ? (
                          <span className="text-xs text-muted-foreground">
                            Feed-linked
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        <Link
                          href={`/applications/${application.id}`}
                          className="transition hover:text-foreground"
                        >
                          {application.roleTitle}
                        </Link>
                        {application.canonicalJob?.location
                          ? ` · ${application.canonicalJob.location}`
                          : ""}
                        {application.canonicalJob?.workMode
                          ? ` · ${application.canonicalJob.workMode.toLowerCase()}`
                          : ""}
                      </p>
                      {application.roleUrl ? (
                        <a
                          className="mt-0.5 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          href={application.roleUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Posting
                        </a>
                      ) : null}
                      <p className="mt-2 text-sm text-muted-foreground">
                        Deadline: {formatTrackerDate(application.deadline)}
                      </p>
                      {application.notes ? (
                        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                          {application.notes}
                        </p>
                      ) : null}
                      {application.tags.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {application.tags.map(({ tag }) => (
                            <span
                              key={tag.id}
                              className="rounded-full border border-border/70 px-2.5 py-0.5 text-xs text-muted-foreground"
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                      <Link
                        href={`/applications/${application.id}`}
                        className="text-sm font-medium text-foreground hover:underline"
                      >
                        Open workspace
                      </Link>
                      {application.canonicalJobId ? (
                        <Link
                          href={`/jobs/${application.canonicalJobId}`}
                          className="text-sm text-muted-foreground hover:text-foreground"
                        >
                          Open job
                        </Link>
                      ) : null}
                      <DeleteApplicationButton
                        applicationId={application.id}
                        className="px-0 text-sm text-muted-foreground hover:text-destructive"
                        size="sm"
                        variant="ghost"
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
