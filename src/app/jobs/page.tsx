import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpDown, Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";

import { JobsAutoRefresh } from "@/components/jobs/jobs-auto-refresh";
import { JobsFeedList } from "@/components/jobs/jobs-feed-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getOptionalCurrentProfileId } from "@/lib/current-user";
import { normalizeCareerStageFilterValue } from "@/lib/career-stage";
import { formatPostedAge } from "@/lib/job-display";
import { serializeJobCardData } from "@/lib/job-serialization";
import { getIngestionStatus } from "@/lib/queries/ingestion";
import { getJobs, type JobFilterParams } from "@/lib/queries/jobs";

type JobsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const EXPERIENCE_LEVEL_GROUPS: Array<{ label: string; value: string }> = [
  { label: "Internship & Co-op", value: "INTERNSHIP" },
  { label: "Entry-Level", value: "ENTRY_LEVEL" },
  { label: "Associate / Junior", value: "ASSOCIATE" },
  { label: "Senior & Leadership", value: "SENIOR_LEVEL" },
  { label: "Administrative Support", value: "ADMINISTRATIVE_SUPPORT" },
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

const CATEGORY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Auto-apply", value: "AUTO_SUBMIT_READY" },
  { label: "Manual", value: "MANUAL_ONLY" },
];

const WORK_MODE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Remote", value: "REMOTE" },
  { label: "Hybrid", value: "HYBRID" },
  { label: "On-site", value: "ONSITE" },
  { label: "Flexible", value: "FLEXIBLE" },
];

const REGION_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "US", value: "US" },
  { label: "Canada", value: "CA" },
];

const INDUSTRY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Tech", value: "TECH" },
  { label: "Finance", value: "FINANCE" },
];

const EXPIRY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Expiring soon", value: "soon" },
];

const SORT_OPTIONS: Array<{ label: string; value: string | undefined }> = [
  { label: "Relevance", value: undefined },
  { label: "Newest", value: "newest" },
  { label: "Expiry date", value: "deadline" },
  { label: "Salary", value: "salary" },
];

export default async function JobsPage({ searchParams }: JobsPageProps) {
  // Note: `await searchParams` below already makes this page dynamic. We
  // previously also called `connection()` here, but that was redundant and
  // added a second opt-out marker that confused the runtime's cache
  // heuristics. Dropping it lets the in-process TTL caches in getJobs /
  // getIngestionStatus do their job on repeat tab/filter navigation.
  const viewerProfileId = await getOptionalCurrentProfileId();
  if (!viewerProfileId) {
    redirect("/sign-in");
  }

  const resolvedSearchParams = await searchParams;
  const filters = parseJobFilters(resolvedSearchParams);

  const [jobsResult, ingestionStatus] = await Promise.all([
    getJobs(filters, { viewerProfileId }),
    getIngestionStatus(),
  ]);
  const renderReferenceNow = new Date().toISOString();

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
      description: job.description,
      isSaved: job.isSaved,
    })
  );

  const activeFilterCount = countActiveFilters(filters);
  const hasScopedResults = activeFilterCount > 0 || Boolean(filters.search);
  const headlineCount = hasScopedResults
    ? jobsResult.total ?? jobsResult.data.length
    : jobsResult.summary.liveJobCount;
  const activeFilterChips = buildActiveFilterChips(filters);
  const currentSortLabel = getSortLabel(filters.sortBy);
  const currentPage = jobsResult.page;
  const totalPages =
    jobsResult.total !== null ? Math.max(1, Math.ceil(jobsResult.total / jobsResult.pageSize)) : null;
  const navigationKey = buildSearchParamSignature(resolvedSearchParams);
  const clearFiltersHref = buildJobsHref(resolvedSearchParams, {
    page: undefined,
    search: undefined,
    region: undefined,
    workMode: undefined,
    industry: undefined,
    roleFamily: undefined,
    salaryMin: undefined,
    experienceLevel: undefined,
    expiry: undefined,
    submissionCategory: undefined,
  });

  return (
    <div className="app-page space-y-6">
      <JobsAutoRefresh initialLastUpdatedAt={ingestionStatus.lastUpdatedAt} />

      <header className="page-header">
        <div>
          <h1 className="page-title">Jobs</h1>
          <p className="page-description">
            Review the live job pool first, then move the strongest matches into your wishlist or application flow.
          </p>
        </div>
      </header>

      <section className="surface-panel p-4 sm:p-5">
        <div>
          <p className="text-[2rem] font-semibold tracking-tight text-foreground sm:text-[2.5rem]">
            {headlineCount.toLocaleString()} {hasScopedResults ? "matching jobs" : "live jobs"}
          </p>
          {ingestionStatus.lastUpdatedAt ? (
            <p className="mt-2 text-sm text-muted-foreground sm:text-[15px]">
              Updated {formatPostedAge(ingestionStatus.lastUpdatedAt)}
              {ingestionStatus.activeSourceCount > 0
                ? ` · ${ingestionStatus.activeSourceCount} connector${ingestionStatus.activeSourceCount !== 1 ? "s" : ""} active`
                : ""}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:text-[15px]">
            <span className="text-foreground">
              <span className="font-medium">{jobsResult.summary.addedTodayCount.toLocaleString()}</span>{" "}
              first seen today
            </span>
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {jobsResult.summary.expiredTodayCount.toLocaleString()}
              </span>{" "}
              marked expired today
            </span>
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {jobsResult.summary.removedTodayCount.toLocaleString()}
              </span>{" "}
              removed today
            </span>
          </div>
          {hasScopedResults &&
          jobsResult.total !== null &&
          ingestionStatus.liveJobCount > jobsResult.total ? (
            <p className="mt-1 text-xs text-muted-foreground">
              From {ingestionStatus.liveJobCount.toLocaleString()} total live jobs in the pool
            </p>
          ) : null}
        </div>

        <div className="mt-5 space-y-4 border-t border-border/60 pt-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                <form className="flex min-w-0 flex-1 items-center gap-2" method="get">
                  {filters.status ? <input name="status" type="hidden" value={filters.status} /> : null}
                  {filters.sortBy ? <input name="sortBy" type="hidden" value={filters.sortBy} /> : null}
                  {filters.submissionCategory ? (
                    <input name="submissionCategory" type="hidden" value={filters.submissionCategory} />
                  ) : null}
                  {filters.roleFamily ? <input name="roleFamily" type="hidden" value={filters.roleFamily} /> : null}
                  {filters.experienceLevel ? (
                    <input name="experienceLevel" type="hidden" value={filters.experienceLevel} />
                  ) : null}
                  {filters.workMode ? <input name="workMode" type="hidden" value={filters.workMode} /> : null}
                  {filters.region ? <input name="region" type="hidden" value={filters.region} /> : null}
                  {filters.industry ? <input name="industry" type="hidden" value={filters.industry} /> : null}
                  {filters.salaryMin ? (
                    <input name="salaryMin" type="hidden" value={String(filters.salaryMin)} />
                  ) : null}
                  {filters.expiry ? <input name="expiry" type="hidden" value={filters.expiry} /> : null}

                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-10 pl-9 text-sm"
                      defaultValue={filters.search}
                      name="search"
                      placeholder="Search jobs, companies, or keywords"
                    />
                  </div>

                  <Button className="h-10 px-4" size="sm" type="submit">
                    Search
                  </Button>
                </form>

                <div className="flex flex-wrap items-center gap-2">
                  <details className="group relative" name="jobs-toolbar-dropdown">
                    <summary className="inline-flex h-10 list-none items-center gap-2 rounded-xl border border-border/70 bg-background/70 px-4 text-sm font-medium text-foreground transition hover:bg-muted/70 [&::-webkit-details-marker]:hidden">
                      <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                      Filters
                      {activeFilterCount > 0 ? (
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-medium text-background">
                          {activeFilterCount}
                        </span>
                      ) : null}
                      <ChevronDown className="h-4 w-4 text-muted-foreground transition group-open:rotate-180" />
                    </summary>

                    <div className="absolute left-0 top-[calc(100%+0.75rem)] z-30 w-[min(32rem,calc(100vw-3rem))] max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-border/70 bg-background/96 shadow-[0_24px_60px_rgba(15,23,42,0.14)] backdrop-blur">
                      <form className="space-y-4" method="get">
                        {filters.sortBy ? <input name="sortBy" type="hidden" value={filters.sortBy} /> : null}
                        {filters.status ? <input name="status" type="hidden" value={filters.status} /> : null}
                        {filters.search ? <input name="search" type="hidden" value={filters.search} /> : null}

                        <div className="border-b border-border/60 px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-base font-medium text-foreground">Refine the feed</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Keep each filter section collapsed until you want to open it.
                              </p>
                            </div>
                            {activeFilterCount > 0 ? (
                              <span className="inline-flex h-7 items-center rounded-full border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground">
                                {activeFilterCount} active
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="max-h-[min(65vh,34rem)] space-y-3 overflow-y-auto px-4 sm:px-5">
                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              submissionCategory: undefined,
                            })}
                            emptyLabel="All categories"
                            name="submissionCategory"
                            options={CATEGORY_OPTIONS}
                            selected={filters.submissionCategory}
                            title="Category"
                          />

                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              roleFamily: undefined,
                            })}
                            columnsClassName="sm:grid-cols-2"
                            emptyLabel="All roles"
                            name="roleFamily"
                            options={ROLE_FAMILY_GROUPS}
                            selected={filters.roleFamily}
                            title="Role"
                          />

                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              experienceLevel: undefined,
                            })}
                            columnsClassName="sm:grid-cols-2"
                            emptyLabel="All stages"
                            name="experienceLevel"
                            options={EXPERIENCE_LEVEL_GROUPS}
                            selected={filters.experienceLevel}
                            title="Career stage"
                          />

                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              workMode: undefined,
                            })}
                            columnsClassName="sm:grid-cols-2"
                            emptyLabel="Any work mode"
                            name="workMode"
                            options={WORK_MODE_OPTIONS}
                            selected={filters.workMode}
                            title="Work mode"
                          />

                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              region: undefined,
                            })}
                            columnsClassName="sm:grid-cols-2"
                            emptyLabel="All regions"
                            name="region"
                            options={REGION_OPTIONS}
                            selected={filters.region}
                            title="Region"
                          />

                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              industry: undefined,
                            })}
                            columnsClassName="sm:grid-cols-2"
                            emptyLabel="Any industry"
                            name="industry"
                            options={INDUSTRY_OPTIONS}
                            selected={filters.industry}
                            title="Industry"
                          />

                          <FilterDropdownField
                            clearHref={buildJobsHref(resolvedSearchParams, {
                              page: undefined,
                              expiry: undefined,
                            })}
                            emptyLabel="Any deadline"
                            name="expiry"
                            options={EXPIRY_OPTIONS}
                            selected={filters.expiry}
                            title="Deadline"
                          />

                          <div className="rounded-xl border border-border/60 bg-muted/15 p-3">
                            <FilterFieldLabel>Minimum salary</FilterFieldLabel>
                            <Input
                              className="mt-1 h-10 text-sm"
                              defaultValue={filters.salaryMin ? String(filters.salaryMin) : ""}
                              name="salaryMin"
                              placeholder="e.g. 120000"
                              type="number"
                            />
                          </div>
                        </div>

                        <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/15 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                          <div>
                            <p className="text-sm font-medium text-foreground">Apply the current selection</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Filters keep your search and sort, and reset the page.
                            </p>
                          </div>
                          <Button size="sm" type="submit">
                            Apply filters
                          </Button>
                        </div>
                      </form>
                    </div>
                  </details>

                  <details className="group relative self-start lg:self-auto" name="jobs-toolbar-dropdown">
                    <summary className="inline-flex h-10 list-none items-center gap-2 rounded-xl border border-border/70 bg-background/70 px-4 text-sm font-medium text-foreground transition hover:bg-muted/70 [&::-webkit-details-marker]:hidden">
                      <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
                      Sort
                      <span className="text-muted-foreground">{currentSortLabel}</span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground transition group-open:rotate-180" />
                    </summary>

                    <div className="absolute right-0 top-[calc(100%+0.75rem)] z-30 w-56 rounded-2xl border border-border/70 bg-background/96 p-2 shadow-[0_24px_60px_rgba(15,23,42,0.14)] backdrop-blur">
                      <div className="space-y-1">
                        {SORT_OPTIONS.map((option) => {
                          const active =
                            (!option.value && (!filters.sortBy || filters.sortBy === "relevance")) ||
                            filters.sortBy === option.value;

                          return (
                            <Link
                              className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm transition ${
                                active
                                  ? "bg-foreground text-background"
                                  : "text-foreground hover:bg-muted/70"
                              }`}
                              href={buildJobsHref(resolvedSearchParams, {
                                page: undefined,
                                sortBy: option.value,
                              })}
                              key={option.label}
                            >
                              <span>{option.label}</span>
                              {active ? <Check className="h-4 w-4" /> : null}
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  </details>

                  {hasScopedResults ? (
                    <Button className="h-10 px-3" render={<Link href={clearFiltersHref} />} size="sm" variant="ghost">
                      <X className="h-3.5 w-3.5" />
                      Clear
                    </Button>
                  ) : null}
                </div>
              </div>

              {activeFilterChips.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {activeFilterChips.map((chip) => (
                    <span
                      className="inline-flex h-9 items-center rounded-xl border border-border/70 bg-background/55 px-3 text-sm text-muted-foreground"
                      key={chip}
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="surface-panel p-3 sm:p-4 lg:p-5">
        {jobCards.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm font-medium text-foreground">
              {hasScopedResults ? "No jobs match these filters" : "No jobs available right now"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {hasScopedResults
                ? "Try widening your search or clearing filters."
                : "The live pool is refreshing. Check back in a moment."}
            </p>
            {hasScopedResults ? (
              <Button className="mt-4" render={<Link href="/jobs" />} size="sm" variant="outline">
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : (
          <JobsFeedList
            initialJobs={jobCards}
            key={navigationKey}
            referenceNow={renderReferenceNow}
          />
        )}

        {(currentPage > 1 || jobsResult.hasNextPage || (totalPages !== null && totalPages > 1)) ? (
          <div className="mt-5 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {totalPages !== null ? `Page ${currentPage} of ${totalPages}` : `Page ${currentPage}`}
            </p>
            <div className="flex items-center gap-2">
              <PaginationLink
                disabled={currentPage <= 1}
                href={buildJobsHref(resolvedSearchParams, {
                  page: currentPage > 1 ? String(currentPage - 1) : undefined,
                })}
              >
                Previous
              </PaginationLink>
              <PaginationLink
                disabled={totalPages !== null ? currentPage >= totalPages : !jobsResult.hasNextPage}
                href={buildJobsHref(resolvedSearchParams, {
                  page:
                    totalPages !== null
                      ? currentPage < totalPages
                        ? String(currentPage + 1)
                        : undefined
                      : jobsResult.hasNextPage
                        ? String(currentPage + 1)
                        : undefined,
                })}
              >
                Next
              </PaginationLink>
            </div>
          </div>
        ) : null}
      </section>
    </div>
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
      className="inline-flex h-8 items-center rounded-lg border border-input/80 bg-background/70 px-3 text-sm text-foreground hover:bg-muted"
      href={href}
    >
      {children}
    </Link>
  );
}

function parseJobFilters(
  searchParams: Record<string, string | string[] | undefined>
): JobFilterParams {
  const pageValue = getSearchParam(searchParams, "page");
  const parsedPage = pageValue ? Number.parseInt(pageValue, 10) : undefined;
  const rawSubmissionCategory = getMultiSearchParam(searchParams, "submissionCategory");

  return {
    search: getSearchParam(searchParams, "search"),
    region: getMultiSearchParam(searchParams, "region"),
    workMode: getMultiSearchParam(searchParams, "workMode"),
    industry: getMultiSearchParam(searchParams, "industry"),
    roleFamily: getMultiSearchParam(searchParams, "roleFamily"),
    salaryMin: getPositiveNumber(getSearchParam(searchParams, "salaryMin")),
    experienceLevel: normalizeCareerStageFilterValue(
      getMultiSearchParam(searchParams, "experienceLevel")
    ),
    expiry: getSearchParam(searchParams, "expiry"),
    submissionCategory: normalizeSubmissionCategoryFilter(rawSubmissionCategory),
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

function getMultiSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string
) {
  const value = searchParams[key];
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(",");
  }
  return value;
}

function normalizeSubmissionCategoryFilter(value?: string) {
  const categories = splitFilterValues(value).map((entry) =>
    entry === "AUTO_FILL_REVIEW" ? "MANUAL_ONLY" : entry
  );
  const unique = [...new Set(categories)];
  return unique.length > 0 ? unique.join(",") : undefined;
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
    const normalizedValue = Array.isArray(value) ? value.filter(Boolean).join(",") : value;
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
    const normalizedValue = Array.isArray(value) ? value.filter(Boolean).join(",") : value;
    if (normalizedValue) {
      params.set(key, normalizedValue);
    }
  }

  return params.toString();
}

function countActiveFilters(filters: JobFilterParams) {
  const keys: Array<keyof JobFilterParams> = [
    "region",
    "workMode",
    "industry",
    "salaryMin",
    "submissionCategory",
    "roleFamily",
    "experienceLevel",
    "expiry",
  ];

  return keys.filter((key) => {
    const value = filters[key];
    return value !== undefined && value !== "";
  }).length;
}

function FilterFieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </label>
  );
}

function FilterDropdownField({
  clearHref,
  columnsClassName,
  emptyLabel,
  name,
  options,
  selected,
  title,
}: {
  clearHref: string;
  columnsClassName?: string;
  emptyLabel: string;
  name: string;
  options: Array<{ label: string; value: string }>;
  selected: string | undefined;
  title: string;
}) {
  const selectedLabels = collectSelectedLabels(selected, options);
  const summary = getFilterSummaryText(selectedLabels, emptyLabel);

  return (
    <details className="group rounded-xl border border-border/60 bg-muted/15 transition open:border-border/80 open:bg-muted/25">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
          <p className="mt-1 truncate text-sm text-foreground">{summary}</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedLabels.length > 0 ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full border border-border/70 bg-background/80 px-1.5 text-[11px] font-medium text-foreground">
              {selectedLabels.length}
            </span>
          ) : null}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-180" />
        </div>
      </summary>

      <div className="border-t border-border/60 px-2.5 py-2.5">
        {selectedLabels.length > 0 ? (
          <div className="mb-2 flex justify-end">
            <Link
              className="text-xs font-medium text-muted-foreground transition hover:text-foreground"
              href={clearHref}
            >
              Clear filter
            </Link>
          </div>
        ) : null}
        <div className={`grid gap-1.5 ${columnsClassName ?? ""}`}>
          {options.map((option) => (
            <FilterDropdownOption
              checked={hasFilterValue(selected, option.value)}
              key={option.label}
              label={option.label}
              name={name}
              value={option.value}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

function FilterDropdownOption({
  checked,
  label,
  name,
  value,
}: {
  checked: boolean;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition hover:bg-background/65">
      <input
        className="size-4 shrink-0 rounded border-border/70 bg-background/80 accent-foreground"
        defaultChecked={checked}
        name={name}
        type="checkbox"
        value={value}
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}

function hasFilterValue(current: string | undefined, optionValue: string) {
  const currentValues = new Set(splitFilterValues(current));
  const optionValues = splitFilterValues(optionValue);
  return optionValues.length > 0 && optionValues.every((value) => currentValues.has(value));
}

function getSortLabel(sortBy?: string) {
  if (sortBy === "newest") return "Newest";
  if (sortBy === "deadline") return "Expiry date";
  if (sortBy === "salary") return "Salary";
  return "Relevance";
}

function buildActiveFilterChips(filters: JobFilterParams) {
  const chips: string[] = [];

  chips.push(...collectSelectedLabels(filters.submissionCategory, CATEGORY_OPTIONS));
  chips.push(...collectSelectedLabels(filters.roleFamily, ROLE_FAMILY_GROUPS));
  chips.push(...collectSelectedLabels(filters.experienceLevel, EXPERIENCE_LEVEL_GROUPS));
  chips.push(...collectSelectedLabels(filters.workMode, WORK_MODE_OPTIONS));
  chips.push(...collectSelectedLabels(filters.region, REGION_OPTIONS));
  chips.push(...collectSelectedLabels(filters.industry, INDUSTRY_OPTIONS));
  chips.push(...collectSelectedLabels(filters.expiry, EXPIRY_OPTIONS));

  if (filters.salaryMin) chips.push(`Min $${Number(filters.salaryMin).toLocaleString()}`);
  if (filters.search) chips.push(`Search: ${filters.search}`);

  return chips;
}

function collectSelectedLabels(
  current: string | undefined,
  options: Array<{ label: string; value: string }>
) {
  const remaining = new Set(splitFilterValues(current));
  const labels: string[] = [];

  for (const option of options) {
    const optionValues = splitFilterValues(option.value);
    if (optionValues.length > 0 && optionValues.every((value) => remaining.has(value))) {
      labels.push(option.label);
      for (const value of optionValues) {
        remaining.delete(value);
      }
    }
  }

  return labels.concat([...remaining]);
}

function getFilterSummaryText(selectedLabels: string[], emptyLabel: string) {
  if (selectedLabels.length === 0) return emptyLabel;
  if (selectedLabels.length <= 2) return selectedLabels.join(", ");
  return `${selectedLabels[0]}, ${selectedLabels[1]} +${selectedLabels.length - 2}`;
}

function splitFilterValues(value?: string) {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}
