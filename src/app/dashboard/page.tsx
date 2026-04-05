import Link from "next/link";
import { redirect } from "next/navigation";

import { CreateTrackedApplicationForm } from "@/components/dashboard/create-tracked-application-form";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getTrackedDashboardData, type TrackerDeadlineFilter, type TrackerSortFilter } from "@/lib/queries/tracker";
import {
  formatTrackerDate,
  TRACKED_STATUS_LABEL,
  trackedStatusClass,
} from "@/lib/tracker-ui";

type DashboardSearchParams = {
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

function buildDashboardUrl(input: {
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
  return query ? `/dashboard?${query}` : "/dashboard";
}

function toggleTag(selectedTags: string[], tag: string) {
  return selectedTags.includes(tag)
    ? selectedTags.filter((value) => value !== tag)
    : [...selectedTags, tag].sort((left, right) => left.localeCompare(right));
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
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
  const hasActiveFilters =
    status !== "ALL" ||
    deadline !== "ALL" ||
    sort !== "UPDATED_DESC" ||
    selectedTags.length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tracker</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manual applications, feed submissions, reminders, and follow-up notes
            in one place.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link href="/applications" className="hover:text-foreground">
            Apply history
          </Link>
          <Link href="/notifications" className="hover:text-foreground">
            Notifications
            {data.unreadNotificationCount > 0 ? ` (${data.unreadNotificationCount})` : ""}
          </Link>
          <Link href="/jobs" className="hover:text-foreground">
            Feed
          </Link>
        </div>
      </div>

      <section className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-6">
            <p className="text-sm text-muted-foreground">
              <span className="text-xl font-semibold text-foreground">
                {data.applications.length}
              </span>
              <span className="ml-1">shown</span>
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="text-xl font-semibold text-foreground">
                {data.totalApplicationCount}
              </span>
              <span className="ml-1">tracked</span>
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="text-xl font-semibold text-foreground">
                {data.activeCount}
              </span>
              <span className="ml-1">active</span>
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Add application</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use this for roles you applied to outside the feed or want to track manually.
          </p>
          <div className="mt-4">
            <CreateTrackedApplicationForm />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Tracked applications</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Feed-submitted jobs appear here automatically with linked resume context.
            </p>
          </div>
          <Link
            href="/documents/compare"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Compare documents
          </Link>
        </div>

        <form method="GET" className="mt-4 grid gap-3 rounded-lg border border-border/70 bg-background p-4 lg:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Status
            </span>
            <select
              name="status"
              defaultValue={status}
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="ALL">All statuses</option>
              <option value="WISHLIST">Wishlist</option>
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
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
              <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
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
                  href={buildDashboardUrl({
                    status,
                    deadline,
                    sort,
                    tags: toggleTag(selectedTags, tag.name),
                  })}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:text-foreground"
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
                No tracked applications in this view
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a manual entry or submit from the feed to start building your tracker.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {data.applications.map((application) => (
                <article key={application.id} className="py-4 first:pt-0 last:pb-0" id={`tracked-${application.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/dashboard/${application.id}`}
                          className="truncate text-base font-semibold text-foreground hover:underline"
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
                            Linked to feed job
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-1 text-sm text-muted-foreground">
                        {application.roleTitle}
                        {application.canonicalJob?.location ? ` · ${application.canonicalJob.location}` : ""}
                        {application.canonicalJob?.workMode ? ` · ${application.canonicalJob.workMode.toLowerCase()}` : ""}
                      </p>

                      <p className="mt-2 text-sm text-foreground/80">
                        Deadline: {formatTrackerDate(application.deadline)}
                      </p>

                      {application.notes ? (
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {application.notes}
                        </p>
                      ) : null}

                      {application.tags.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {application.tags.map(({ tag }) => (
                            <span
                              key={tag.id}
                              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-col items-end gap-2 text-sm">
                      <Link
                        href={`/dashboard/${application.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        Open workspace
                      </Link>
                      {application.canonicalJobId ? (
                        <Link
                          href={`/jobs/${application.canonicalJobId}`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Open job
                        </Link>
                      ) : application.roleUrl ? (
                        <a
                          href={application.roleUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Open posting
                        </a>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
