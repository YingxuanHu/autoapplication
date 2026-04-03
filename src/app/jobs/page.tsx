import Link from "next/link";
import { connection } from "next/server";
import { X } from "lucide-react";
import { JobsFeedList } from "@/components/jobs/jobs-feed-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { serializeJobCardData } from "@/lib/job-serialization";
import { formatPostedAge } from "@/lib/job-display";
import { getJobs, getFeedStats, type JobFilterParams } from "@/lib/queries/jobs";
import { getIngestionStatus } from "@/lib/queries/ingestion";

type JobsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

const EXPERIENCE_LEVEL_GROUPS: Array<{ label: string; value: string }> = [
  { label: "Entry", value: "ENTRY" },
  { label: "Mid", value: "MID" },
  { label: "Senior", value: "SENIOR" },
  { label: "Staff+", value: "LEAD,EXECUTIVE" },
];

const ROLE_FAMILY_GROUPS: Array<{ label: string; value: string }> = [
  { label: "SWE", value: "SWE" },
  { label: "Design", value: "Design" },
  { label: "Research", value: "Research" },
  { label: "Product", value: "Product Management" },
  { label: "Data", value: "Data Science,Data Engineering,Data Analyst,Product Analyst,Business Analyst" },
  { label: "Solutions", value: "Solutions Architecture,Solutions Engineering" },
  { label: "Finance", value: "Financial Analyst,FP&A,Investment Banking,Risk,Credit,Wealth Management,Compliance" },
  { label: "Ops", value: "Operations" },
];

export default async function JobsPage({ searchParams }: JobsPageProps) {
  await connection();
  const resolvedSearchParams = await searchParams;
  const filters = parseJobFilters(resolvedSearchParams);

  const [jobsResult, ingestionStatus, feedStats] = await Promise.all([
    getJobs(filters),
    getIngestionStatus(),
    getFeedStats(),
  ]);

  const jobCards = jobsResult.data.map((job) =>
    serializeJobCardData({
      ...job,
      eligibility: job.eligibility
        ? {
            submissionCategory: job.eligibility.submissionCategory,
            reasonCode: job.eligibility.reasonCode,
            reasonDescription: job.eligibility.reasonDescription,
          }
        : null,
      isSaved: job.isSaved,
    })
  );

  const activeFilterCount = countActiveFilters(filters);
  const activeAdvancedCount = countAdvancedFilters(filters);
  const currentPage = jobsResult.page;
  const totalPages = Math.max(1, Math.ceil(jobsResult.total / jobsResult.pageSize));
  const navigationKey = buildSearchParamSignature(resolvedSearchParams);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header row */}
      <div className="pb-4">
        <h1 className="text-xl font-semibold tracking-tight">Jobs</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {jobsResult.total} live job{jobsResult.total !== 1 ? "s" : ""}
          {activeFilterCount > 0 ? " matching filters" : ""}
        </p>
        {ingestionStatus.lastUpdatedAt ? (
          <p className="mt-0.5 text-xs text-muted-foreground/50">
            Updated {formatPostedAge(ingestionStatus.lastUpdatedAt)}
            {ingestionStatus.activeSourceCount > 0
              ? ` · ${ingestionStatus.activeSourceCount} connector${ingestionStatus.activeSourceCount !== 1 ? "s" : ""} active`
              : ""}
            {ingestionStatus.liveJobCount > jobsResult.total
              ? ` · ${ingestionStatus.liveJobCount} total in pool`
              : ""}
          </p>
        ) : null}
      </div>

      {/* Stats bar */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        <StatCard
          label="Live jobs"
          value={feedStats.totalLive.toLocaleString()}
          detail={feedStats.newLast24h > 0 ? `+${feedStats.newLast24h.toLocaleString()} today` : undefined}
          accentClass="text-foreground"
        />
        <StatCard
          label="Auto-apply"
          value={feedStats.autoEligibleCount.toLocaleString()}
          detail="ready to submit"
          accentClass="text-emerald-600"
        />
        <StatCard
          label="Review"
          value={feedStats.reviewRequiredCount.toLocaleString()}
          detail="needs review"
          accentClass="text-amber-600"
        />
        <StatCard
          label="Saved"
          value={feedStats.savedCount.toLocaleString()}
          detail={feedStats.savedEndingSoonCount > 0 ? `${feedStats.savedEndingSoonCount} ending soon` : undefined}
          accentClass="text-blue-600"
        />
        <StatCard
          label="Manual"
          value={feedStats.manualOnlyCount.toLocaleString()}
          detail="manual apply"
          accentClass="text-muted-foreground"
        />
      </div>

      {/* Category pills + sort controls */}
      <div className="flex flex-wrap items-center gap-y-1.5 border-b border-border pb-3">
        <div className="flex flex-1 flex-wrap items-center gap-1">
          <FilterPill
            label="All"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              submissionCategory: undefined,
            })}
            active={!filters.submissionCategory}
          />
          <FilterPill
            label="Auto-apply"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              submissionCategory: "AUTO_SUBMIT_READY",
            })}
            active={filters.submissionCategory === "AUTO_SUBMIT_READY"}
          />
          <FilterPill
            label="Review"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              submissionCategory: "AUTO_FILL_REVIEW",
            })}
            active={filters.submissionCategory === "AUTO_FILL_REVIEW"}
          />
          <FilterPill
            label="Manual"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              submissionCategory: "MANUAL_ONLY",
            })}
            active={filters.submissionCategory === "MANUAL_ONLY"}
          />
        </div>

        {/* Sort controls — top-level, separate from filters */}
        <div className="flex shrink-0 items-center gap-0.5">
          <SortPill
            label="Relevance"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              sortBy: undefined,
            })}
            active={!filters.sortBy || filters.sortBy === "relevance"}
          />
          <SortPill
            label="Newest"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              sortBy: "newest",
            })}
            active={filters.sortBy === "newest"}
          />
          <SortPill
            label="Salary"
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              sortBy: "salary",
            })}
            active={filters.sortBy === "salary"}
          />
        </div>
      </div>

      {/* Role-family pills */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border py-2.5">
        <FilterPill
          label="All roles"
          href={buildJobsHref(resolvedSearchParams, {
            page: undefined,
            roleFamily: undefined,
          })}
          active={!filters.roleFamily}
        />
        {ROLE_FAMILY_GROUPS.map((group) => (
          <FilterPill
            key={group.value}
            label={group.label}
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              roleFamily: group.value,
            })}
            active={filters.roleFamily === group.value}
          />
        ))}
      </div>

      {/* Experience-level pills */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border py-2.5">
        <FilterPill
          label="All levels"
          href={buildJobsHref(resolvedSearchParams, {
            page: undefined,
            experienceLevel: undefined,
          })}
          active={!filters.experienceLevel}
        />
        {EXPERIENCE_LEVEL_GROUPS.map((group) => (
          <FilterPill
            key={group.value}
            label={group.label}
            href={buildJobsHref(resolvedSearchParams, {
              page: undefined,
              experienceLevel: group.value,
            })}
            active={filters.experienceLevel === group.value}
          />
        ))}
      </div>

      {/* Filters — collapsed by default, opens when any filter active */}
      <details className="border-b border-border" open={activeFilterCount > 0}>
        <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-sm text-muted-foreground hover:text-foreground">
          Filters
          {activeFilterCount > 0 ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[11px] font-medium text-background">
              {activeFilterCount}
            </span>
          ) : null}
        </summary>

        <form className="space-y-2 pb-3">
          {/* Preserve pill-selected params through form submission */}
          {filters.submissionCategory ? (
            <input type="hidden" name="submissionCategory" value={filters.submissionCategory} />
          ) : null}
          {filters.roleFamily ? (
            <input type="hidden" name="roleFamily" value={filters.roleFamily} />
          ) : null}
          {filters.experienceLevel ? (
            <input type="hidden" name="experienceLevel" value={filters.experienceLevel} />
          ) : null}
          {filters.sortBy ? (
            <input type="hidden" name="sortBy" value={filters.sortBy} />
          ) : null}
          {/* Search + buttons */}
          <div className="flex gap-2">
            <Input
              name="search"
              placeholder="Search jobs…"
              defaultValue={filters.search}
              className="h-8 flex-1 text-sm"
            />
            <Button type="submit" size="sm">
              Filter
            </Button>
            {activeFilterCount > 0 ? (
              <Button variant="ghost" size="sm" render={<Link href="/jobs" />}>
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>

          {/* Basic selects */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <select name="workMode" defaultValue={filters.workMode ?? ""} className={SELECT_CLASS}>
              <option value="">Work mode</option>
              <option value="REMOTE">Remote</option>
              <option value="HYBRID">Hybrid</option>
              <option value="ONSITE">On-site</option>
              <option value="FLEXIBLE">Flexible</option>
            </select>

            <select name="region" defaultValue={filters.region ?? ""} className={SELECT_CLASS}>
              <option value="">Region</option>
              <option value="US">US</option>
              <option value="CA">Canada</option>
            </select>
          </div>

          {/* Advanced filters — inner disclosure */}
          <details open={activeAdvancedCount > 0}>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 pt-0.5 text-xs text-muted-foreground/70 hover:text-muted-foreground">
              More filters
              {activeAdvancedCount > 0 ? (
                <span className="text-xs font-medium text-foreground">({activeAdvancedCount})</span>
              ) : null}
            </summary>

            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <select
                name="industry"
                defaultValue={filters.industry ?? ""}
                className={SELECT_CLASS}
              >
                <option value="">Industry</option>
                <option value="TECH">Tech</option>
                <option value="FINANCE">Finance</option>
              </select>

              <Input
                name="salaryMin"
                type="number"
                placeholder="Min salary"
                defaultValue={filters.salaryMin ? String(filters.salaryMin) : ""}
                className="h-8 text-sm"
              />
            </div>
          </details>
        </form>
      </details>

      {/* Feed */}
      <div className="pt-1">
        {jobCards.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm font-medium text-foreground">No jobs match these filters</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try widening your search or clearing filters.
            </p>
            <Button variant="outline" size="sm" className="mt-4" render={<Link href="/jobs" />}>
              Clear filters
            </Button>
          </div>
        ) : (
          <JobsFeedList key={navigationKey} initialJobs={jobCards} />
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-border pt-3 mt-2">
          <p className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex items-center gap-1.5">
            <PaginationLink
              href={buildJobsHref(resolvedSearchParams, {
                page: currentPage > 1 ? String(currentPage - 1) : undefined,
              })}
              disabled={currentPage <= 1}
            >
              Previous
            </PaginationLink>
            <PaginationLink
              href={buildJobsHref(resolvedSearchParams, {
                page: currentPage < totalPages ? String(currentPage + 1) : undefined,
              })}
              disabled={currentPage >= totalPages}
            >
              Next
            </PaginationLink>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Pills ──────────────────────────────────────────────────────────────────

function FilterPill({ active, href, label }: { active: boolean; href: string; label: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function SortPill({ active, href, label }: { active: boolean; href: string; label: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-6 items-center rounded px-2 text-xs font-medium transition-colors ${
        active
          ? "text-foreground"
          : "text-muted-foreground/60 hover:text-muted-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function PaginationLink({
  children,
  disabled,
  href,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  href: string;
}) {
  if (disabled) {
    return (
      <span className="inline-flex h-7 items-center rounded-md border border-input px-2.5 text-sm text-muted-foreground opacity-40">
        {children}
      </span>
    );
  }

  return (
    <Link
      href={href}
      className="inline-flex h-7 items-center rounded-md border border-input px-2.5 text-sm text-foreground hover:bg-muted"
    >
      {children}
    </Link>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJobFilters(
  searchParams: Record<string, string | string[] | undefined>
): JobFilterParams {
  const pageValue = getSearchParam(searchParams, "page");
  const parsedPage = pageValue ? Number.parseInt(pageValue, 10) : undefined;

  return {
    search: getSearchParam(searchParams, "search"),
    region: getSearchParam(searchParams, "region"),
    workMode: getSearchParam(searchParams, "workMode"),
    industry: getSearchParam(searchParams, "industry"),
    roleFamily: getSearchParam(searchParams, "roleFamily"),
    salaryMin: getPositiveNumber(getSearchParam(searchParams, "salaryMin")),
    experienceLevel: getSearchParam(searchParams, "experienceLevel"),
    submissionCategory: getSearchParam(searchParams, "submissionCategory"),
    status: getSearchParam(searchParams, "status"),
    sortBy: getSearchParam(searchParams, "sortBy"),
    page: parsedPage && parsedPage > 0 ? parsedPage : undefined,
  };
}

function getSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string
) {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function getPositiveNumber(value?: string) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

function buildJobsHref(
  currentParams: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | undefined>
) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(currentParams)) {
    const normalizedValue = Array.isArray(value) ? value[0] : value;
    if (normalizedValue) params.set(key, normalizedValue);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }

  const queryString = params.toString();
  return queryString ? `/jobs?${queryString}` : "/jobs";
}

function buildSearchParamSignature(
  searchParams: Record<string, string | string[] | undefined>
) {
  const params = new URLSearchParams();

  for (const key of Object.keys(searchParams).sort()) {
    const value = searchParams[key];
    const normalizedValue = Array.isArray(value) ? value[0] : value;
    if (normalizedValue) {
      params.set(key, normalizedValue);
    }
  }

  return params.toString();
}

/** Counts non-sort, non-category filters for the badge on the filter drawer */
function countActiveFilters(filters: JobFilterParams) {
  const keys: Array<keyof JobFilterParams> = [
    "search",
    "region",
    "workMode",
    "industry",
    "salaryMin",
    // submissionCategory is handled by the category pills, not shown in count
    // roleFamily is handled by the role-family pills, not shown in count
    // experienceLevel is handled by the experience-level pills, not shown in count
    // sortBy is handled by the sort pills, not shown in count
  ];

  return keys.filter((key) => {
    const value = filters[key];
    return value !== undefined && value !== "";
  }).length;
}

/** Counts only advanced-section filters for the inner disclosure badge */
function countAdvancedFilters(filters: JobFilterParams) {
  const keys: Array<keyof JobFilterParams> = ["industry", "salaryMin"];
  return keys.filter((key) => {
    const value = filters[key];
    return value !== undefined && value !== "";
  }).length;
}

function StatCard({
  label,
  value,
  detail,
  accentClass,
}: {
  label: string;
  value: string;
  detail?: string;
  accentClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${accentClass ?? "text-foreground"}`}>
        {value}
      </p>
      {detail ? (
        <p className="text-xs text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}
