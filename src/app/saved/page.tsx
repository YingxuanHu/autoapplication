import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { SavedJobsList } from "@/components/jobs/saved-jobs-list";
import { serializeJobCardData } from "@/lib/job-serialization";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getSavedJobs } from "@/lib/queries/saved-jobs";
import type { SavedJobListItem } from "@/types";

type SavedPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SAVED_STATUS_FILTERS = [
  { value: "ACTIVE", label: "Active" },
  { value: "APPLIED", label: "Applied" },
  { value: "EXPIRED", label: "Expired" },
  { value: "DISMISSED", label: "Dismissed" },
] as const;

type SavedStatusFilter = (typeof SAVED_STATUS_FILTERS)[number]["value"];

export default async function SavedPage({ searchParams }: SavedPageProps) {
  await connection();
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const resolvedSearchParams = await searchParams;
  const selectedStatus = getSavedStatus(resolvedSearchParams.status);

  const [savedJobs, allSavedJobs] = await Promise.all([
    getSavedJobs(selectedStatus),
    getSavedJobs(),
  ]);

  const counts = SAVED_STATUS_FILTERS.map((filter) => ({
    ...filter,
    count: allSavedJobs.filter((j) => j.status === filter.value).length,
  }));
  const activeCount = counts.find((filter) => filter.value === "ACTIVE")?.count ?? 0;
  const appliedCount = counts.find((filter) => filter.value === "APPLIED")?.count ?? 0;

  const shortlistItems = savedJobs.map(serializeSavedJob);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Saved</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {allSavedJobs.length} saved job{allSavedJobs.length !== 1 ? "s" : ""} total
            {activeCount > 0 ? ` · ${activeCount} active` : ""}
            {appliedCount > 0 ? ` · ${appliedCount} in applications` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/applications"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Applications
          </Link>
          <Link
            href="/jobs"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Feed
          </Link>
        </div>
      </div>

      {/* Status filter pills */}
      <div className="flex items-center gap-1.5 border-b border-border pb-3">
        {counts.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === "ACTIVE" ? "/saved" : `/saved?status=${filter.value}`}
            className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm font-medium transition-colors ${
              selectedStatus === filter.value
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {filter.label}
            {filter.count > 0 ? (
              <span className="ml-1.5 text-xs opacity-60">{filter.count}</span>
            ) : null}
          </Link>
        ))}
      </div>

      {/* List */}
      <div className="pt-1">
        <SavedJobsList
          key={selectedStatus}
          initialSavedJobs={shortlistItems}
          statusFilter={selectedStatus}
          emptyHref={selectedStatus === "ACTIVE" ? "/jobs" : "/saved?status=ACTIVE"}
        />
      </div>
    </div>
  );
}

function getSavedStatus(value: string | string[] | undefined): SavedStatusFilter {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  return SAVED_STATUS_FILTERS.some((filter) => filter.value === normalizedValue)
    ? (normalizedValue as SavedStatusFilter)
    : "ACTIVE";
}

function serializeSavedJob(
  savedJob: Awaited<ReturnType<typeof getSavedJobs>>[number]
): SavedJobListItem {
  return {
    id: savedJob.id,
    status: savedJob.status,
    notes: savedJob.notes,
    createdAt: savedJob.createdAt.toISOString(),
    canonicalJob: serializeJobCardData({
      ...savedJob.canonicalJob,
      eligibility: savedJob.canonicalJob.eligibility
        ? {
            submissionCategory: savedJob.canonicalJob.eligibility.submissionCategory,
            reasonCode: savedJob.canonicalJob.eligibility.reasonCode,
            reasonDescription: savedJob.canonicalJob.eligibility.reasonDescription,
          }
        : null,
      isSaved: true,
    }),
  };
}
