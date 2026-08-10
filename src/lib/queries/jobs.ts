import { prisma } from "@/lib/db";
import { PAGE_SIZE } from "@/lib/constants";
import {
  Prisma,
  type Prisma as PrismaTypes,
  type SubmissionCategory,
  type TrackedApplicationStatus,
} from "@/generated/prisma/client";
import { splitFilterValues } from "@/lib/filter-values";
import { expandLocationSearchTerm } from "@/lib/location-search";
import { DEMO_SOURCE_NAMES } from "@/lib/job-links";
import {
  sanitizeCompanyName,
  sanitizeJobDescriptionText,
  sanitizeJobTitle,
} from "@/lib/job-cleanup";
import { isClearlyNonJobPosting } from "@/lib/job-integrity";
import { hasBadApplyLinkValidationStatus } from "@/lib/ingestion/apply-link-quality";
import {
  getOptionalCurrentAuthUserId,
  getOptionalCurrentProfileId,
} from "@/lib/current-user";
import { getIngestionHeartbeat } from "@/lib/queries/ingestion";
import { inferGeoScope } from "@/lib/geo-scope";
import {
  JOB_BOARD_MIN_AVAILABILITY_SCORE,
  buildDefaultCanonicalVisibilityWhere,
} from "@/lib/jobs/visibility";
import {
  getStartOfTodayInTimeZone,
  normalizeUserTimeZone,
} from "@/lib/time-zone";
import {
  CAREER_STAGE_FILTER_CONFIDENCE_THRESHOLD,
  METADATA_FIELD_FILTER_CONFIDENCE_THRESHOLD,
  INDUSTRY_FILTER_CONFIDENCE_THRESHOLD,
  ROLE_CATEGORY_FILTER_CONFIDENCE_THRESHOLD,
  expandNormalizedRoleCategoryFilterValue,
  normalizeEmploymentTypeGroupFilterValue,
  normalizeExperienceLevelGroupFilterValue,
  normalizeIndustryFilterValue,
} from "@/lib/job-metadata";
import {
  assertJobFilterContract,
  getActiveRoleCategoryFilters,
  type FilterContractJob,
} from "@/lib/job-filter-contract";
import { computeRankingScore } from "@/lib/ingestion/quality";
import {
  convertSalaryAmount,
  convertSalaryRange,
  FALLBACK_SALARY_EXCHANGE_RATES,
  normalizeSalaryCurrency,
  SALARY_COMPARISON_CURRENCIES,
  type SalaryComparisonCurrency,
  type SalaryExchangeRates,
} from "@/lib/currency-conversion";
import { loadSalaryExchangeRates } from "@/lib/salary-exchange-rates";
import {
  buildCanonicalFeedOrderBy,
  buildJobFeedIndexOrderBy,
} from "@/lib/queries/job-feed-order";

// ─── Full-text search ────────────────────────────────────────────────────────

/**
 * Convert a user search string into a PostgreSQL tsquery.
 * Splits on whitespace, strips non-alphanumeric chars, joins with &.
 * Each token is suffixed with :* for prefix matching ("eng" → "eng:*").
 */
const MAX_SEARCH_LENGTH = 200;
const MAX_SEARCH_TOKENS = 12;
const NO_VIEWER_PROFILE_ID = "__viewer_none__";
const NO_AUTH_USER_ID = "__auth_user_none__";
const DEFAULT_VISIBLE_JOB_STATUSES = ["LIVE"] as const;
const DEFAULT_SEARCH_VISIBLE_JOB_STATUSES = DEFAULT_VISIBLE_JOB_STATUSES;
const DEFAULT_MIN_AVAILABILITY_SCORE = JOB_BOARD_MIN_AVAILABILITY_SCORE;
const DEFAULT_SEARCH_MIN_AVAILABILITY_SCORE = DEFAULT_MIN_AVAILABILITY_SCORE;
const JOB_STATUS_FILTER_VALUES = new Set([
  "AGING",
  "LIVE",
  "EXPIRED",
  "REMOVED",
  "STALE",
]);
const FILTERABLE_CLASSIFICATION_STATUSES = [
  "CONFIDENT",
  "PARTIAL",
  "NEEDS_REVIEW",
] as const;
const UNKNOWN_COMPANY_VISIBILITY_BLOCKLIST = [
  "",
  "0",
  "00",
  "000",
  "n/a",
  "na",
  "none",
  "not available",
  "not specified",
  "unknown",
  "unknown company",
  "jooble",
  "jooble.org",
];
const GENERIC_ATS_COMPANY_VISIBILITY_BLOCKS = [
  { company: "ashbyhq", applyUrlContains: "ashbyhq.com" },
  { company: "greenhouse", applyUrlContains: "greenhouse.io" },
  { company: "lever", applyUrlContains: "lever.co" },
  { company: "myworkdayjobs", applyUrlContains: "myworkdayjobs.com" },
  { company: "smartrecruiters", applyUrlContains: "smartrecruiters.com" },
  { company: "workable", applyUrlContains: "workable.com" },
  { company: "icims", applyUrlContains: "icims.com" },
  { company: "jobvite", applyUrlContains: "jobvite.com" },
  { company: "bamboohr", applyUrlContains: "bamboohr.com" },
];
// Cache TTLs tuned for tab-switching speed. The 4 visible counts + 4 hidden
// demo counts that drive the header summary are the slowest part of /jobs;
// they're stable on the order of minutes (lifecycle sweep runs every 30min),
// so a 5-min TTL is safe and removes most cold-cache latency from tab
// navigation. The feed query (paginated job list) is also invalidated by the
// ingestion heartbeat for the default feed, while filtered views can safely
// stay warm for five minutes. This avoids repeated cold reads when a user
// switches filters or pages and then returns to a recent view.
const JOB_FEED_SUMMARY_TTL_MS = 300_000;
const JOB_FEED_QUERY_TTL_MS = 300_000;
const HOT_FEED_QUERY_TTL_MS = 300_000;
const FEED_INDEX_SEARCH_MATCH_ID_LIMIT = 10_000;
// A sole title/company search for a SELECTIVE term (few matches relative to the
// pool) is pathologically slow on the default feed path: Postgres scans the
// rankingScore-ordered index and filters the text per-row, discarding hundreds
// of thousands of non-matching rows before it finds one page (e.g. company
// "google" → ~21s, scanning 228k rows). When the match set is small we can
// instead pull the matching ids via the trigram index (bitmap, milliseconds)
// and constrain the feed query to them, which makes ranking, pagination, AND
// the exact count fast. Broad/dense terms (e.g. "engineer") keep the existing
// path — there the rank-ordered scan finds a page almost immediately.
const SELECTIVE_SCOPED_SEARCH_THRESHOLD = 8_000;
const TIMED_CACHE_MAX_ENTRIES = 128;
const DIVERSIFICATION_OVERSCAN = 80;
const DEMO_SOURCE_NAME_SET = new Set<string>(DEMO_SOURCE_NAMES);
const timedCacheStore = new Map<string, { expiresAt: number; value: unknown }>();
export type JobSearchScope = "all" | "title" | "company" | "location";
type ScopedJobSearchScope = Exclude<JobSearchScope, "all">;
export type JobSortBy = "relevance" | "newest" | "deadline" | "company";
const JOB_SORT_VALUES = new Set<string>(["relevance", "newest", "deadline", "company"]);
const SEARCH_SCOPE_COLUMNS: Record<ScopedJobSearchScope, string> = {
  title: "title",
  company: "company",
  location: "location",
};

const inflightJobsQueryStore = new Map<string, Promise<JobsResult>>();
const TRACKED_APPLICATION_NOT_APPLIED_STATUSES: TrackedApplicationStatus[] = [
  "WISHLIST",
  "PREPARING",
];

const JOB_CARD_INCLUDE = (
  viewerProfileId: string | null,
  authUserId: string | null
) =>
  ({
    eligibility: true,
    feedIndex: {
      select: { status: true },
    },
    sourceMappings: true,
    savedJobs: {
      where: {
        userId: viewerProfileId ?? NO_VIEWER_PROFILE_ID,
        status: "ACTIVE",
      },
      select: { id: true },
    },
    trackedApplications: {
      where: {
        userId: authUserId ?? NO_AUTH_USER_ID,
        status: { notIn: TRACKED_APPLICATION_NOT_APPLIED_STATUSES },
      },
      select: { id: true },
      take: 1,
    },
  }) satisfies PrismaTypes.JobCanonicalInclude;

const JOB_FEED_CARD_SELECT = (
  viewerProfileId: string | null,
  authUserId: string | null = null
) =>
  ({
    id: true,
    title: true,
    company: true,
    location: true,
    region: true,
    workMode: true,
    industry: true,
    status: true,
    roleFamily: true,
    normalizedRoleCategory: true,
    normalizedRoleCategoryConfidence: true,
    normalizedIndustry: true,
    normalizedIndustries: true,
    normalizedIndustryConfidence: true,
    classificationStatus: true,
    experienceLevel: true,
    salaryMin: true,
    salaryMax: true,
    salaryCurrency: true,
    shortSummary: true,
    applyUrl: true,
    postedAt: true,
    deadline: true,
    lastConfirmedAliveAt: true,
    lastSourceSeenAt: true,
    eligibility: {
      select: {
        submissionCategory: true,
        reasonCode: true,
        reasonDescription: true,
      },
    },
    sourceMappings: {
      where: { removedAt: null },
      orderBy: [{ isPrimary: "desc" }, { sourceQualityRank: "desc" }, { lastSeenAt: "desc" }],
      take: 5,
      select: {
        sourceName: true,
        sourceUrl: true,
        isPrimary: true,
      },
    },
    savedJobs: {
      where: {
        userId: viewerProfileId ?? NO_VIEWER_PROFILE_ID,
        status: "ACTIVE",
      },
      select: { id: true },
    },
    trackedApplications: {
      where: {
        userId: authUserId ?? NO_AUTH_USER_ID,
        status: { notIn: TRACKED_APPLICATION_NOT_APPLIED_STATUSES },
      },
      select: { id: true },
      take: 1,
    },
  }) satisfies PrismaTypes.JobCanonicalSelect;

function isClearlyVisibleJobPosting(input: {
  title: string;
  description?: string | null;
  shortSummary?: string | null;
  applyUrl?: string | null;
}) {
  return !isClearlyNonJobPosting({
    title: input.title,
    description: input.description ?? input.shortSummary ?? null,
    applyUrl: input.applyUrl ?? null,
  });
}

type SanitizedJobPresentationInput = {
  title: string;
  company: string;
  description: string;
  location: string;
  applyUrl: string | null;
  shortSummary?: string | null;
  eligibility?: {
    submissionCategory: string;
    reasonCode: string;
    reasonDescription: string;
  } | null;
};

function withSanitizedJobPresentation<T extends SanitizedJobPresentationInput>(
  job: T,
  options: { sanitizeDescription?: boolean } = {}
): T {
  const title = sanitizeJobTitle(job.title);
  const company = sanitizeCompanyName(job.company, {
    urls: [job.applyUrl],
  });
  const description =
    options.sanitizeDescription === false
      ? job.description
      : sanitizeJobDescriptionText(job.description, {
          title,
          location: job.location,
        });
  const shortSummary = job.shortSummary
    ? sanitizeJobDescriptionText(job.shortSummary, {
        title,
        location: job.location,
      })
    : job.shortSummary;
  return {
    ...job,
    title,
    company,
    description,
    shortSummary,
  };
}

function withSanitizedJobFeedPresentation<
  T extends Omit<SanitizedJobPresentationInput, "description"> & {
    description?: string;
  },
>(job: T): T & { description: string } {
  return withSanitizedJobPresentation(
    {
      ...job,
      description: "",
    },
    { sanitizeDescription: false }
  );
}

function buildGlobalVisibilityWhere(): PrismaTypes.JobCanonicalWhereInput {
  return {};
}

function buildCompanyVisibilityWhere(): PrismaTypes.JobCanonicalWhereInput {
  return {
    NOT: {
      OR: [
        ...UNKNOWN_COMPANY_VISIBILITY_BLOCKLIST.map((company) => ({
          company: { equals: company, mode: "insensitive" as const },
        })),
        ...GENERIC_ATS_COMPANY_VISIBILITY_BLOCKS.map((entry) => ({
          AND: [
            { company: { equals: entry.company, mode: "insensitive" as const } },
            { applyUrl: { contains: entry.applyUrlContains, mode: "insensitive" as const } },
          ],
        })),
      ],
    },
  };
}

function buildFeedIndexCompanyVisibilityWhere(): PrismaTypes.JobFeedIndexWhereInput {
  return {
    NOT: {
      OR: [
        ...UNKNOWN_COMPANY_VISIBILITY_BLOCKLIST.map((company) => ({
          company: { equals: company, mode: "insensitive" as const },
        })),
        ...GENERIC_ATS_COMPANY_VISIBILITY_BLOCKS.map((entry) => ({
          AND: [
            { company: { equals: entry.company, mode: "insensitive" as const } },
            { applyUrl: { contains: entry.applyUrlContains, mode: "insensitive" as const } },
          ],
        })),
      ],
    },
  };
}

function buildDefaultJobBoardVisibilityWhere(
  now: Date = new Date(),
  minAvailabilityScore: number = DEFAULT_MIN_AVAILABILITY_SCORE
): PrismaTypes.JobCanonicalWhereInput {
  return {
    AND: [
      buildDefaultCanonicalVisibilityWhere(now, minAvailabilityScore),
      buildCompanyVisibilityWhere(),
      buildGlobalVisibilityWhere(),
    ],
  };
}

function toTsQuery(raw: string, operator: "&" | "|" = "&"): string {
  const tokens = raw
    .slice(0, MAX_SEARCH_LENGTH)
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((t) => t.length > 0)
    .slice(0, MAX_SEARCH_TOKENS);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}:*`).join(` ${operator} `);
}

function buildLooseSearchTerms(raw: string | undefined) {
  const phrase = raw?.slice(0, MAX_SEARCH_LENGTH).replace(/\s+/g, " ").trim();
  if (!phrase) return [];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of [
    phrase,
    ...phrase
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, MAX_SEARCH_TOKENS),
  ]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  return terms;
}

function buildLooseSearchTokens(raw: string | undefined) {
  const phrase = raw?.slice(0, MAX_SEARCH_LENGTH).replace(/\s+/g, " ").trim();
  if (!phrase) return [];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of phrase
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS)) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  return terms;
}

function escapeLikePattern(value: string) {
  return value.replace(/[%_\\]/g, "\\$&");
}

function buildSearchTermVariants(term: string) {
  const variants: string[] = [term];
  const seen = new Set([term.toLowerCase()]);

  for (const match of term.matchAll(/([a-zA-Z0-9])\1{2,}/g)) {
    if (match.index == null) continue;

    const repeated = match[0];
    const corrected = `${term.slice(0, match.index)}${match[1].repeat(
      repeated.length - 1
    )}${term.slice(match.index + repeated.length)}`;
    const key = corrected.toLowerCase();

    if (corrected.length > 1 && !seen.has(key)) {
      seen.add(key);
      variants.push(corrected);
    }
  }

  return variants;
}

function buildLooseSearchTermGroups(raw: string | undefined) {
  return buildLooseSearchTerms(raw).map(buildSearchTermVariants);
}

function buildLooseSearchTokenGroups(raw: string | undefined) {
  return buildLooseSearchTokens(raw).map(buildSearchTermVariants);
}

function buildSearchLikePatternGroups(raw: string | undefined) {
  return buildLooseSearchTokenGroups(raw).map((variants) =>
    variants.map((variant) => `%${escapeLikePattern(variant)}%`)
  );
}

function getPostedAfterDate(value?: string, now: Date = new Date()) {
  const days =
    value === "1d"
      ? 1
      : value === "3d"
        ? 3
        : value === "7d"
          ? 7
          : value === "14d"
            ? 14
            : value === "30d"
              ? 30
              : null;

  return days ? new Date(now.getTime() - days * 86_400_000) : null;
}

function normalizeJobStatusFilter(value?: string) {
  if (!value || !JOB_STATUS_FILTER_VALUES.has(value)) return null;
  return value as "AGING" | "LIVE" | "EXPIRED" | "REMOVED" | "STALE";
}

function hasNonDefaultJobStatusFilter(value?: string) {
  return Boolean(value && normalizeJobStatusFilter(value) !== "LIVE");
}

export function normalizeJobSortBy(value?: string): JobSortBy | undefined {
  if (!value || !JOB_SORT_VALUES.has(value)) return undefined;
  return value as JobSortBy;
}

function appendAndCondition(
  where: Prisma.JobCanonicalWhereInput,
  condition: Prisma.JobCanonicalWhereInput
) {
  const existingAnd = where.AND
    ? Array.isArray(where.AND)
      ? where.AND
      : [where.AND]
    : [];
  where.AND = [...existingAnd, condition];
}

function appendFeedIndexAndCondition(
  where: Prisma.JobFeedIndexWhereInput,
  condition: Prisma.JobFeedIndexWhereInput
) {
  const existingAnd = where.AND
    ? Array.isArray(where.AND)
      ? where.AND
      : [where.AND]
    : [];
  where.AND = [...existingAnd, condition];
}

function withoutUnknownFilterValues(values: string[], unknownValue: string) {
  return values.filter((value) => value !== unknownValue);
}

// Region and WorkMode are Prisma enums; a value that is not an exact member
// (e.g. lowercase "us"/"remote" from a hand-edited or shared URL) makes Prisma
// reject the whole query and surface a 500 on the primary feed. Normalize to
// upper-case and keep only real members so malformed input is ignored, never a
// crash. Returns null when nothing valid remains (filter omitted).
const VALID_REGION_VALUES = new Set(["US", "CA"]);
const VALID_WORK_MODE_VALUES = new Set(["REMOTE", "HYBRID", "ONSITE", "FLEXIBLE"]);

function parseEnumCsv(raw: string, allowed: Set<string>): string[] | null {
  const values = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => allowed.has(value));
  return values.length > 0 ? values : null;
}

function shouldDebugJobFilters(filters: JobFilterParams) {
  return filters.debugFilters || process.env.JOB_FILTER_DEBUG === "1";
}

function logJobFilterDebug(
  filters: JobFilterParams,
  jobs: FilterContractJob[],
  source: string
) {
  if (!shouldDebugJobFilters(filters)) return;

  console.info(
    "[jobs-filter-debug]",
    JSON.stringify(
      {
        source,
        activeFilters: {
          roleCategory: getActiveRoleCategoryFilters(filters),
          industry: splitFilterValues(normalizeIndustryFilterValue(filters.industry)),
          search: filters.search ?? null,
          titleSearch: filters.titleSearch ?? null,
          companySearch: filters.companySearch ?? null,
          locationSearch: filters.locationSearch ?? null,
        },
        rows: jobs.slice(0, 25).map((job) => ({
          id: job.id,
          title: job.title,
          company: job.company,
          roleFamily: job.roleFamily,
          normalizedRoleCategory: job.normalizedRoleCategory ?? null,
          normalizedRoleCategoryConfidence: job.normalizedRoleCategoryConfidence ?? null,
          normalizedIndustry: job.normalizedIndustry ?? null,
          normalizedIndustries: job.normalizedIndustries ?? [],
          normalizedIndustryConfidence: job.normalizedIndustryConfidence ?? null,
          classificationStatus: job.classificationStatus ?? null,
          matchedBy: "base_visible_jobs_and_structured_filters_then_search",
          metadataSource: source,
        })),
      },
      null,
      2
    )
  );
}

function finalizeJobsResult<T extends { data: FilterContractJob[] }>(
  filters: JobFilterParams,
  result: T,
  source: string
): T {
  assertJobFilterContract(filters, result.data, source);
  logJobFilterDebug(filters, result.data, source);
  return result;
}

function shouldUseJobFeedIndex(filters: JobFilterParams, viewerProfileId: string | null) {
  void viewerProfileId;
  return (
    process.env.USE_JOB_FEED_INDEX !== "0" &&
    !filters.source
  );
}

async function getPassedJobIdSet(
  viewerProfileId: string | null,
  canonicalJobIds?: string[]
) {
  if (!viewerProfileId) return new Set<string>();
  if (canonicalJobIds && canonicalJobIds.length === 0) return new Set<string>();

  const passedRows = await prisma.userBehaviorSignal.findMany({
    where: {
      userId: viewerProfileId,
      action: "PASS",
      ...(canonicalJobIds ? { canonicalJobId: { in: canonicalJobIds } } : {}),
    },
    select: { canonicalJobId: true },
  });

  return new Set(passedRows.map((row) => row.canonicalJobId));
}

function buildNotPassedCanonicalWhere(
  viewerProfileId: string
): Prisma.JobCanonicalWhereInput {
  return {
    behaviorSignals: {
      none: {
        userId: viewerProfileId,
        action: "PASS",
      },
    },
  };
}

function buildNotAppliedCanonicalWhere(
  authUserId: string
): Prisma.JobCanonicalWhereInput {
  return {
    trackedApplications: {
      none: {
        userId: authUserId,
        status: { notIn: TRACKED_APPLICATION_NOT_APPLIED_STATUSES },
      },
    },
  };
}

async function countJobFeedIndexMatches(where: Prisma.JobFeedIndexWhereInput) {
  return prisma.jobFeedIndex.count({ where });
}

// Prisma binds enum filters as parameters, which prevents PostgreSQL from
// proving the LIVE-only index predicate. Keep this default lookup's status
// literal while parameterizing all request-derived values.
function buildRawCompanyVisibilitySql(alias: "jfi" | "jc") {
  const company = Prisma.raw(`${alias}.company`);
  const applyUrl = Prisma.raw(`${alias}."applyUrl"`);
  const unknownCompanies = Prisma.join(
    UNKNOWN_COMPANY_VISIBILITY_BLOCKLIST.map((value) => Prisma.sql`${value}`)
  );
  const genericAtsBlocks = Prisma.join(
    GENERIC_ATS_COMPANY_VISIBILITY_BLOCKS.map(
      ({ company: blockedCompany, applyUrlContains }) =>
        Prisma.sql`(lower(${company}) = ${blockedCompany} AND ${applyUrl} ILIKE ${`%${applyUrlContains}%`})`
    ),
    " OR "
  );

  return Prisma.sql`
    NOT (
      lower(${company}) IN (${unknownCompanies})
      OR ${genericAtsBlocks}
    )
  `;
}

async function getDefaultPublicFeedIndexRows(input: {
  now: Date;
  viewerProfileId: string | null;
  skip: number;
}) {
  const { now, viewerProfileId, skip } = input;
  const recentSourceCutoff = new Date(now.getTime() - 14 * 86_400_000);
  const recentAliveCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const excludedApplyLinkStatuses = [
    "EXPIRED",
    "BROKEN_APPLY_LINK",
    "GENERIC_APPLY_PAGE",
    "SOURCE_STALE",
    "HIDDEN_LOW_QUALITY",
  ];
  const passedJobFilter = viewerProfileId
    ? Prisma.sql`
        AND NOT EXISTS (
          SELECT 1
          FROM "UserBehaviorSignal" AS signal
          WHERE signal."canonicalJobId" = jc.id
            AND signal."userId" = ${viewerProfileId}
            AND signal.action = 'PASS'::"UserAction"
        )
      `
    : Prisma.empty;

  return prisma.$queryRaw<Array<{ canonicalJobId: string }>>(Prisma.sql`
    SELECT jfi."canonicalJobId"
    FROM "JobFeedIndex" AS jfi
    INNER JOIN "JobCanonical" AS jc ON jc.id = jfi."canonicalJobId"
    WHERE jfi.status = 'LIVE'::"JobStatus"
      AND ${buildRawCompanyVisibilitySql("jfi")}
      AND jc.status = 'LIVE'::"JobStatus"
      AND jc."availabilityScore" >= ${DEFAULT_MIN_AVAILABILITY_SCORE}
      AND jc."deadSignalAt" IS NULL
      AND (jc."applyUrl" LIKE 'http://%' OR jc."applyUrl" LIKE 'https://%')
      AND (
        jc."applyUrlValidationStatus" IS NULL
        OR jc."applyUrlValidationStatus"::text NOT IN (${Prisma.join(
          excludedApplyLinkStatuses.map((value) => Prisma.sql`${value}`)
        )})
      )
      AND (jc.deadline IS NULL OR jc.deadline >= ${now})
      AND (
        jc."lastSourceSeenAt" >= ${recentSourceCutoff}
        OR jc."lastConfirmedAliveAt" >= ${recentAliveCutoff}
      )
      AND ${buildRawCompanyVisibilitySql("jc")}
      ${passedJobFilter}
    ORDER BY
      jfi."rankingScore" DESC,
      jfi."freshnessScore" DESC,
      jfi."qualityScore" DESC,
      jfi."trustScore" DESC,
      jfi."postedAt" DESC,
      jfi."canonicalJobId" DESC
    LIMIT ${PAGE_SIZE + 1}
    OFFSET ${skip}
  `);
}

async function getJobsFromFeedIndex(input: {
  filters: JobFilterParams;
  viewerProfileId: string | null;
  authUserId: string | null;
  salaryExchangeRates: SalaryExchangeRates;
  summaryPromise: Promise<JobFeedSummary>;
  includeExactTotal: boolean;
  useSqlDemoVisibilityFilter: boolean;
}) {
  const {
    filters,
    viewerProfileId,
    authUserId,
    salaryExchangeRates,
    summaryPromise,
    includeExactTotal,
    useSqlDemoVisibilityFilter,
  } = input;
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;
  const now = new Date();
  const where: Prisma.JobFeedIndexWhereInput = {};
  const canonicalRelationWhere: Prisma.JobCanonicalWhereInput = {};

  appendFeedIndexAndCondition(where, buildFeedIndexCompanyVisibilityWhere());

  if (useSqlDemoVisibilityFilter) {
    canonicalRelationWhere.sourceMappings = {
      some: {
        sourceName: {
          notIn: [...DEMO_SOURCE_NAMES],
        },
      },
    };
  }

  const searchScope = filters.searchScope ?? "all";
  let searchPrefilterIds: string[] | null = null;
  const hasStructuredFeedFilters = Boolean(
    filters.location ||
      filters.region ||
      filters.workMode ||
      filters.employmentType ||
      filters.industry ||
      filters.roleCategory ||
      filters.roleFamily ||
      filters.salaryMin ||
      filters.salaryMax ||
      filters.careerStage ||
      filters.experienceLevel ||
      filters.expiry ||
      filters.posted ||
      filters.submissionCategory ||
      filters.hideApplied
  );
  // Direct in-app pagination (slicing the prefiltered id list) is valid only
  // when nothing else narrows the set further — then the id list IS the full
  // ordered result and we can paginate it without re-querying the index.
  const canSlicePrefilterIds =
    !hasStructuredFeedFilters &&
    !hasNonDefaultJobStatusFilter(filters.status) &&
    !filters.hideApplied &&
    !useSqlDemoVisibilityFilter &&
    (!filters.sortBy || filters.sortBy === "relevance");
  let useDirectPrefilterSlice = false;

  if (filters.search && !hasNonDefaultJobStatusFilter(filters.status)) {
    const searchPrefilterLimit = hasStructuredFeedFilters
      ? FEED_INDEX_SEARCH_MATCH_ID_LIMIT
      : Math.min(
          FEED_INDEX_SEARCH_MATCH_ID_LIMIT,
          Math.max(PAGE_SIZE * ((filters.page ?? 1) + 2), 500)
        );
    searchPrefilterIds = await searchJobFeedIndexIds(
      filters.search,
      searchScope,
      searchPrefilterLimit
    );
    if (searchPrefilterIds !== null) {
      useDirectPrefilterSlice =
        canSlicePrefilterIds &&
        !filters.titleSearch &&
        !filters.companySearch &&
        !filters.locationSearch;
    }
  }

  // Accelerate a single SELECTIVE scoped title/company search. The default
  // rank-ordered scan is pathological for selective terms — it discards
  // hundreds of thousands of high-rank non-matching rows per page (e.g.
  // company "google" → ~21s). When the term is selective we pull its full
  // ordered match set through the trigram index and paginate it in app, which
  // is fast and yields an exact total. With structured filters, we still use
  // the selective id list as a prefilter and let the normal indexed query apply
  // the hard filters. Only the sole-text-search case can paginate the id list
  // directly because then the id list is the whole ordered result.
  let acceleratedScopedField: "title" | "company" | null = null;
  if (
    searchPrefilterIds === null &&
    !filters.search &&
    !filters.locationSearch
  ) {
    const soleScopedSearch =
      filters.titleSearch && !filters.companySearch
        ? ({ field: "title", query: filters.titleSearch } as const)
        : filters.companySearch && !filters.titleSearch
          ? ({ field: "company", query: filters.companySearch } as const)
          : null;
    if (soleScopedSearch) {
      const orderedIds = await getSelectiveScopedSearchIds(
        soleScopedSearch.field,
        soleScopedSearch.query,
        SELECTIVE_SCOPED_SEARCH_THRESHOLD
      );
      if (orderedIds !== null) {
        searchPrefilterIds = orderedIds;
        acceleratedScopedField = soleScopedSearch.field;
        useDirectPrefilterSlice = canSlicePrefilterIds;
      }
    }
  }

  if (searchPrefilterIds !== null) {
    if (searchPrefilterIds.length === 0) {
      return {
        data: [],
        total: 0,
        hasNextPage: false,
        page,
        pageSize: PAGE_SIZE,
        summary: await summaryPromise,
      } satisfies JobsResult;
    }
    where.canonicalJobId = { in: searchPrefilterIds };
  } else if (filters.search) {
    appendFeedIndexTextSearchWhere(
      where,
      searchScope === "title"
        ? "title"
        : searchScope === "company"
          ? "company"
          : searchScope === "location"
            ? "location"
            : "searchText",
      filters.search
    );
  }

  if (acceleratedScopedField !== "title") {
    appendFeedIndexTextSearchWhere(where, "title", filters.titleSearch);
  }
  if (acceleratedScopedField !== "company") {
    appendFeedIndexTextSearchWhere(where, "company", filters.companySearch);
  }
  appendFeedIndexLocationSearchWhere(where, filters.locationSearch);

  if (filters.region) {
    const regions = parseEnumCsv(filters.region, VALID_REGION_VALUES);
    if (regions) {
      where.region = { in: regions as ("US" | "CA")[] };
    }
  }

  if (filters.workMode) {
    const modes = parseEnumCsv(filters.workMode, VALID_WORK_MODE_VALUES);
    if (modes) {
      appendFeedIndexAndCondition(where, {
        workMode: {
          in: modes as ("REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE")[],
        },
        workModeConfidence: { gte: METADATA_FIELD_FILTER_CONFIDENCE_THRESHOLD },
      });
    }
  }

  if (filters.industry) {
    const industries = withoutUnknownFilterValues(
      splitFilterValues(normalizeIndustryFilterValue(filters.industry)),
      "UNKNOWN"
    );
    appendFeedIndexAndCondition(where, {
      OR:
        industries.length > 0
          ? [
              { normalizedIndustries: { hasSome: industries } },
              { normalizedIndustry: { in: industries } },
            ]
          : [{ normalizedIndustry: { in: [] } }],
      normalizedIndustryConfidence: { gte: INDUSTRY_FILTER_CONFIDENCE_THRESHOLD },
    });
  }

  if (filters.roleCategory) {
    const selectedRoleCategories = splitFilterValues(
      expandNormalizedRoleCategoryFilterValue(filters.roleCategory)
    );
    const roleCategories = withoutUnknownFilterValues(selectedRoleCategories, "OTHER_UNKNOWN");
    const roleConditions: Prisma.JobFeedIndexWhereInput[] = [];
    if (roleCategories.length > 0) {
      roleConditions.push({
        normalizedRoleCategory: { in: roleCategories },
        normalizedRoleCategoryConfidence: { gte: ROLE_CATEGORY_FILTER_CONFIDENCE_THRESHOLD },
        classificationStatus: { in: [...FILTERABLE_CLASSIFICATION_STATUSES] },
      });
    }
    if (selectedRoleCategories.includes("OTHER_UNKNOWN")) {
      roleConditions.push({ normalizedRoleCategory: "OTHER_UNKNOWN" });
    }
    appendFeedIndexAndCondition(
      where,
      roleConditions.length === 0
        ? { normalizedRoleCategory: { in: [] } }
        : roleConditions.length === 1
          ? roleConditions[0]
          : { OR: roleConditions }
    );
  }

  if (filters.roleFamily) {
    const families = filters.roleFamily.split(",").map((f) => f.trim()).filter(Boolean);
    if (families.length === 1) {
      where.roleFamily = { contains: families[0], mode: "insensitive" };
    } else if (families.length > 1) {
      where.roleFamily = { in: families };
    }
  }

  if (filters.location) {
    appendFeedIndexLocationSearchWhere(where, filters.location);
  }

  if (filters.employmentType) {
    const employmentTypeGroups = withoutUnknownFilterValues(
      splitFilterValues(normalizeEmploymentTypeGroupFilterValue(filters.employmentType)),
      "UNKNOWN"
    );
    appendFeedIndexAndCondition(where, {
      employmentTypeGroup:
        employmentTypeGroups.length > 0 ? { in: employmentTypeGroups } : { in: [] },
      employmentTypeConfidence: { gte: METADATA_FIELD_FILTER_CONFIDENCE_THRESHOLD },
    });
  }

  const postedAfter = getPostedAfterDate(filters.posted);
  if (postedAfter) {
    where.postedAt = { gte: postedAfter };
  }

    const salaryRangeWhere = buildSalaryRangeIndexWhere(
      filters.salaryMin,
      filters.salaryMax,
      filters.salaryCurrency ?? "USD",
      salaryExchangeRates,
      Boolean(filters.includeUnknownSalary)
    );
  if (salaryRangeWhere) {
    const existingAnd = where.AND
      ? Array.isArray(where.AND)
        ? where.AND
        : [where.AND]
      : [];
    where.AND = [...existingAnd, salaryRangeWhere];
  }

  if (filters.expiry === "soon") {
    const soonDeadline = new Date(now.getTime() + 5 * 86_400_000);
    where.deadline = {
      gte: now,
      lte: soonDeadline,
    };
  }

  if (filters.careerStage || filters.experienceLevel) {
    const groups = splitFilterValues(
      normalizeExperienceLevelGroupFilterValue(filters.careerStage ?? filters.experienceLevel)
    );
    const knownGroups = withoutUnknownFilterValues(groups, "UNKNOWN");
    appendFeedIndexAndCondition(where, {
      experienceLevelGroup: knownGroups.length > 0 ? { in: knownGroups } : { in: [] },
      normalizedCareerStageConfidence: { gte: CAREER_STAGE_FILTER_CONFIDENCE_THRESHOLD },
    });
  }

  if (filters.submissionCategory) {
    const selectedCategories = filters.submissionCategory
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const expandedCategories = new Set<"READY_TO_APPLY" | "REVIEW_REQUIRED" | "MANUAL_ONLY">();

    for (const category of selectedCategories) {
      if (category === "READY_TO_APPLY") {
        expandedCategories.add("READY_TO_APPLY");
      } else if (category === "MANUAL_ONLY" || category === "REVIEW_REQUIRED") {
        expandedCategories.add("MANUAL_ONLY");
        expandedCategories.add("REVIEW_REQUIRED");
      }
    }

    const categoryList = [...expandedCategories];

    if (categoryList.length === 1) {
      where.submissionCategory = categoryList[0];
    } else if (categoryList.length > 1) {
      where.submissionCategory = {
        in: categoryList,
      };
    }
  }

  const requestedStatus = normalizeJobStatusFilter(filters.status);
  if (hasNonDefaultJobStatusFilter(filters.status)) {
    where.status = requestedStatus ?? { in: [] };
  } else {
    where.status = {
      in: [...DEFAULT_VISIBLE_JOB_STATUSES],
    };
  }
  const requireLiveCanonicalJobs = !hasNonDefaultJobStatusFilter(filters.status);
  if (requireLiveCanonicalJobs) {
    appendAndCondition(
      canonicalRelationWhere,
      buildDefaultJobBoardVisibilityWhere(now, DEFAULT_MIN_AVAILABILITY_SCORE)
    );
  }
  if (viewerProfileId) {
    appendAndCondition(
      canonicalRelationWhere,
      buildNotPassedCanonicalWhere(viewerProfileId)
    );
  }
  if (filters.hideApplied && authUserId) {
    appendAndCondition(
      canonicalRelationWhere,
      buildNotAppliedCanonicalWhere(authUserId)
    );
  }
  if (Object.keys(canonicalRelationWhere).length > 0) {
    where.canonicalJob = {
      is: canonicalRelationWhere,
    };
  }

  const orderBy = buildJobFeedIndexOrderBy(filters.sortBy);

  const totalPromise = includeExactTotal
    ? countJobFeedIndexMatches(where)
    : Promise.resolve(null);
  const useRawDefaultPublicFeedLookup =
    !includeExactTotal &&
    !useSqlDemoVisibilityFilter &&
    !useDirectPrefilterSlice &&
    searchPrefilterIds === null &&
    !hasScopedFeedRequest(filters) &&
    (!filters.sortBy || filters.sortBy === "relevance");

  const indexedRows =
    useDirectPrefilterSlice && searchPrefilterIds !== null
      ? searchPrefilterIds
          .slice(skip, skip + PAGE_SIZE + 1)
          .map((canonicalJobId) => ({ canonicalJobId }))
      : useRawDefaultPublicFeedLookup
        ? await getDefaultPublicFeedIndexRows({
            now,
            viewerProfileId,
            skip,
          })
      : await prisma.jobFeedIndex.findMany({
          where,
          select: { canonicalJobId: true },
          orderBy,
          skip,
          take: PAGE_SIZE + 1,
        });

  let canonicalJobIds = indexedRows.map((row) => row.canonicalJobId);
  if (
    viewerProfileId &&
    canonicalJobIds.length > 0 &&
    useDirectPrefilterSlice
  ) {
    const passedJobIds = await getPassedJobIdSet(viewerProfileId, canonicalJobIds);
    canonicalJobIds = canonicalJobIds.filter((id) => !passedJobIds.has(id));
  }

  if (canonicalJobIds.length === 0) {
    const total = includeExactTotal ? await totalPromise : null;
    return {
      data: [],
      total: total ?? (includeExactTotal ? 0 : null),
      hasNextPage: false,
      page,
      pageSize: PAGE_SIZE,
      summary: await summaryPromise,
    } satisfies JobsResult;
  }

  const jobs = await prisma.jobCanonical.findMany({
    where: {
      AND: [
        { id: { in: canonicalJobIds } },
        ...(requireLiveCanonicalJobs
          ? [buildDefaultJobBoardVisibilityWhere(now, DEFAULT_MIN_AVAILABILITY_SCORE)]
          : []),
      ],
    },
    select: JOB_FEED_CARD_SELECT(viewerProfileId, authUserId),
  });
  const order = new Map(canonicalJobIds.map((id, index) => [id, index]));
  const visibleJobs = jobs.sort(
    (left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  );
  const data = visibleJobs.slice(0, PAGE_SIZE).map((job) => {
    const { savedJobs, trackedApplications, ...rest } = job;
    return withSanitizedJobFeedPresentation({
      ...rest,
      isSaved: savedJobs.length > 0,
      hasApplied: trackedApplications.length > 0,
    });
  });

  if (!includeExactTotal) {
    return {
      data,
      total: null,
      hasNextPage: indexedRows.length > PAGE_SIZE,
      page,
      pageSize: PAGE_SIZE,
      summary: await summaryPromise,
    } satisfies JobsResult;
  }

  const total = await totalPromise;

  return {
    data,
    total,
    hasNextPage: total !== null ? skip + PAGE_SIZE < total : data.length === PAGE_SIZE,
    page,
    pageSize: PAGE_SIZE,
    summary: await summaryPromise,
  } satisfies JobsResult;
}

/**
 * Search for matching job IDs using PostgreSQL full-text search.
 *
 * Strategy:
 *  1. Try tsvector full-text search first (fast, uses GIN index).
 *  2. If no results are found, fall back to loose substring matching on
 *     title, company, role family, and location, including conservative
 *     repeated-character typo variants ("engineeer" -> "engineer").
 *
 * Returns up to `limit` matching job IDs, ordered by relevance.
 */
async function searchJobIds(
  query: string,
  scope: JobSearchScope = "all",
  limit: number = SEARCH_MATCH_ID_LIMIT
): Promise<string[] | null> {
  const tsQuery = toTsQuery(query);
  if (!tsQuery) return null;

  const escapedLikeQuery = escapeLikePattern(query);
  const companyLikePattern = `%${escapedLikeQuery}%`;
  const likePatternGroups = buildSearchLikePatternGroups(query);

  if (scope !== "all") {
    const column = SEARCH_SCOPE_COLUMNS[scope];
    const scopedFtsResults = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "JobCanonical"
       WHERE to_tsvector('english', coalesce("${column}", '')) @@ to_tsquery('english', $1)
       ORDER BY
         CASE
           WHEN lower("${column}") = lower($3) THEN 0
           WHEN "${column}" ILIKE $4 THEN 1
           ELSE 2
         END,
         ts_rank(to_tsvector('english', coalesce("${column}", '')), to_tsquery('english', $1)) DESC
       LIMIT $2`,
      tsQuery,
      limit,
      query,
      companyLikePattern
    );

    if (scopedFtsResults.length > 0) {
      return scopedFtsResults.map((r) => r.id);
    }

    if (likePatternGroups.length === 0) return [];

    const scopedParams: string[] = [];
    const scopedWhere = likePatternGroups
      .map((patterns) => {
        const groupWhere = patterns.map((pattern) => {
          scopedParams.push(pattern);
          return `"${column}" ILIKE $${scopedParams.length}`;
        });
        return `(${groupWhere.join(" OR ")})`;
      })
      .join(" AND ");
    const exactQueryParam = scopedParams.length + 1;
    const limitParam = scopedParams.length + 2;
    const scopedLikeResults = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "JobCanonical"
       WHERE ${scopedWhere}
       ORDER BY
         CASE
           WHEN lower("${column}") = lower($${exactQueryParam}) THEN 0
           WHEN "${column}" ILIKE $1 THEN 1
           ELSE 2
         END
       LIMIT $${limitParam}`,
      ...scopedParams,
      query,
      limit
    );

    return scopedLikeResults.length > 0
      ? scopedLikeResults.map((r) => r.id)
      : [];
  }

  // Try full-text search first
  const ftsResults = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "JobCanonical"
     WHERE "searchVector" @@ to_tsquery('english', $1)
     ORDER BY
       CASE
         WHEN lower(company) = lower($3) THEN 0
         WHEN company ILIKE $4 THEN 1
         ELSE 2
       END,
       CASE
         WHEN EXISTS (
           SELECT 1
           FROM "JobSourceMapping" jsm
           WHERE jsm."canonicalJobId" = "JobCanonical".id
             AND jsm."removedAt" IS NULL
             AND jsm."sourceName" ILIKE 'OfficialCompany:%'
         ) THEN 0
         ELSE 1
       END,
       ts_rank("searchVector", to_tsquery('english', $1)) DESC
     LIMIT $2`,
    tsQuery,
    limit,
    query,
    companyLikePattern
  );

  if (ftsResults.length > 0) {
    return ftsResults.map((r) => r.id);
  }

  // Fallback for acronyms, company names, misspellings, and terms not in the
  // English dictionary.
  if (likePatternGroups.length === 0) return [];

  const allSearchParams: string[] = [];
  const allSearchWhere = likePatternGroups
    .map((patterns) => {
      const groupWhere = patterns.map((pattern) => {
        allSearchParams.push(pattern);
        const param = `$${allSearchParams.length}`;
        return `(title ILIKE ${param}
          OR company ILIKE ${param}
          OR "roleFamily" ILIKE ${param}
          OR location ILIKE ${param})`;
      });
      return `(${groupWhere.join(" OR ")})`;
    })
    .join("\n        AND ");
  const exactQueryParam = allSearchParams.length + 1;
  const limitParam = allSearchParams.length + 2;
  const trigramResults = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "JobCanonical"
     WHERE ${allSearchWhere}
     ORDER BY
       CASE
         WHEN lower(company) = lower($${exactQueryParam}) THEN 0
         WHEN company ILIKE $1 THEN 1
         ELSE 2
       END,
       CASE
         WHEN EXISTS (
           SELECT 1
           FROM "JobSourceMapping" jsm
           WHERE jsm."canonicalJobId" = "JobCanonical".id
             AND jsm."removedAt" IS NULL
             AND jsm."sourceName" ILIKE 'OfficialCompany:%'
         ) THEN 0
         ELSE 1
       END
     LIMIT $${limitParam}`,
    ...allSearchParams,
    query,
    limit
  );

  return trigramResults.length > 0
    ? trigramResults.map((r) => r.id)
    : [];
}

function hasSearchFilters(filters: JobFilterParams) {
  return Boolean(
    filters.search ||
      filters.titleSearch ||
      filters.companySearch ||
      filters.locationSearch
  );
}

type ScopedTextSearchMode = "any-term" | "all-terms";

function buildScopedTextSearchWhere(
  field: ScopedJobSearchScope,
  query: string | undefined,
  mode: ScopedTextSearchMode = "all-terms"
): PrismaTypes.JobCanonicalWhereInput | null {
  const termGroups =
    mode === "all-terms"
      ? buildLooseSearchTokenGroups(query)
      : buildLooseSearchTermGroups(query);
  if (termGroups.length === 0) return null;

  const clauses = termGroups.map((terms) => {
    const variantClauses = terms.map((term) => ({
      [field]: {
        contains: term,
        mode: "insensitive" as const,
      },
    })) as PrismaTypes.JobCanonicalWhereInput[];

    return variantClauses.length === 1 ? variantClauses[0] : { OR: variantClauses };
  }) as PrismaTypes.JobCanonicalWhereInput[];

  if (clauses.length === 1) return clauses[0];
  return mode === "all-terms" ? { AND: clauses } : { OR: clauses };
}

function appendScopedTextSearchWhere(
  where: Prisma.JobCanonicalWhereInput,
  field: ScopedJobSearchScope,
  query: string | undefined
) {
  const condition = buildScopedTextSearchWhere(field, query);
  if (condition) appendAndCondition(where, condition);
}

type FeedIndexSearchField = ScopedJobSearchScope | "searchText";

const FEED_INDEX_SEARCH_SQL_COLUMNS: Record<FeedIndexSearchField, string> = {
  title: `"title"`,
  company: `"company"`,
  location: `"location"`,
  searchText: `"searchText"`,
};

function buildFeedIndexTextSearchWhere(
  field: FeedIndexSearchField,
  query: string | undefined,
  mode: ScopedTextSearchMode = "all-terms"
): PrismaTypes.JobFeedIndexWhereInput | null {
  const termGroups =
    mode === "all-terms"
      ? buildLooseSearchTokenGroups(query)
      : buildLooseSearchTermGroups(query);
  if (termGroups.length === 0) return null;

  const clauses = termGroups.map((terms) => {
    const variantClauses = terms.map((term) => ({
      [field]: {
        contains: term,
        mode: "insensitive" as const,
      },
    })) as PrismaTypes.JobFeedIndexWhereInput[];

    return variantClauses.length === 1 ? variantClauses[0] : { OR: variantClauses };
  }) as PrismaTypes.JobFeedIndexWhereInput[];

  if (clauses.length === 1) return clauses[0];
  return mode === "all-terms" ? { AND: clauses } : { OR: clauses };
}

function appendFeedIndexTextSearchWhere(
  where: Prisma.JobFeedIndexWhereInput,
  field: FeedIndexSearchField,
  query: string | undefined
) {
  const condition = buildFeedIndexTextSearchWhere(field, query);
  if (condition) appendFeedIndexAndCondition(where, condition);
}

async function searchJobFeedIndexIds(
  query: string,
  scope: JobSearchScope = "all",
  limit: number = FEED_INDEX_SEARCH_MATCH_ID_LIMIT
): Promise<string[] | null> {
  const tsQuery = toTsQuery(query);
  if (!tsQuery) return null;

  const field: FeedIndexSearchField =
    scope === "title"
      ? "title"
      : scope === "company"
        ? "company"
        : scope === "location"
          ? "location"
          : "searchText";
  const column = FEED_INDEX_SEARCH_SQL_COLUMNS[field];
  const exactMatchColumn =
    field === "searchText" ? FEED_INDEX_SEARCH_SQL_COLUMNS.company : column;
  const partialMatchPattern = `%${escapeLikePattern(query)}%`;
  const likePatternGroups = buildSearchLikePatternGroups(query);

  if (field === "searchText" || field === "company") {
    const exactCompanyIds = await searchJobFeedIndexExactCompanyIds(query, limit);
    if (exactCompanyIds.length > 0) return exactCompanyIds;
  }

  if (field === "searchText") {
    return searchJobFeedIndexLikeIds({
      query,
      likePatternGroups,
      searchableColumns: [
        FEED_INDEX_SEARCH_SQL_COLUMNS.company,
        FEED_INDEX_SEARCH_SQL_COLUMNS.title,
        FEED_INDEX_SEARCH_SQL_COLUMNS.location,
        `"roleFamily"`,
      ],
      exactMatchColumn,
      partialMatchPattern,
      limit,
    });
  }

  const ftsRows = await prisma.$queryRawUnsafe<Array<{ canonicalJobId: string }>>(
    `SELECT "canonicalJobId"
     FROM "JobFeedIndex"
     WHERE
       status = 'LIVE'
       AND to_tsvector('english', coalesce(${column}, '')) @@ to_tsquery('english', $1)
     ORDER BY
       CASE
         WHEN lower(${exactMatchColumn}) = lower($3) THEN 0
         WHEN ${exactMatchColumn} ILIKE $4 ESCAPE '\\' THEN 1
         ELSE 2
       END,
       ts_rank_cd(to_tsvector('english', coalesce(${column}, '')), to_tsquery('english', $1)) DESC,
       "rankingScore" DESC,
       "postedAt" DESC
     LIMIT $2`,
    tsQuery,
    limit,
    query,
    partialMatchPattern
  );

  if (ftsRows.length > 0) {
    return ftsRows.map((row) => row.canonicalJobId);
  }

  return searchJobFeedIndexLikeIds({
    query,
    likePatternGroups,
    searchableColumns: [column],
    exactMatchColumn,
    partialMatchPattern,
    limit,
  });
}

async function searchJobFeedIndexLikeIds(input: {
  query: string;
  likePatternGroups: string[][];
  searchableColumns: string[];
  exactMatchColumn: string;
  partialMatchPattern: string;
  limit: number;
}) {
  const {
    query,
    likePatternGroups,
    searchableColumns,
    exactMatchColumn,
    partialMatchPattern,
    limit,
  } = input;
  if (likePatternGroups.length === 0) return [];

  const params: string[] = [];
  const fallbackWhere = likePatternGroups
    .map((patterns) => {
      const patternClauses = patterns.map((pattern) => {
        params.push(pattern);
        const placeholder = `$${params.length}`;
        return `(${searchableColumns
          .map((searchColumn) => `${searchColumn} ILIKE ${placeholder} ESCAPE '\\'`)
          .join(" OR ")})`;
      });
      return `(${patternClauses.join(" OR ")})`;
    })
    .join(" AND ");
  const exactQueryParam = params.length + 1;
  const partialQueryParam = params.length + 2;
  const limitParam = params.length + 3;

  const fallbackRows = await prisma.$queryRawUnsafe<Array<{ canonicalJobId: string }>>(
    `SELECT "canonicalJobId"
     FROM "JobFeedIndex"
     WHERE
       status = 'LIVE'
       AND ${fallbackWhere}
     ORDER BY
       CASE
         WHEN lower(${exactMatchColumn}) = lower($${exactQueryParam}) THEN 0
         WHEN ${exactMatchColumn} ILIKE $${partialQueryParam} ESCAPE '\\' THEN 1
         ELSE 2
       END,
       "rankingScore" DESC,
       "postedAt" DESC
     LIMIT $${limitParam}`,
    ...params,
    query,
    partialMatchPattern,
    limit
  );

  return fallbackRows.map((row) => row.canonicalJobId);
}

async function searchJobFeedIndexExactCompanyIds(query: string, limit: number) {
  const normalized = query.slice(0, MAX_SEARCH_LENGTH).replace(/\s+/g, " ").trim();
  if (!normalized || buildLooseSearchTokens(normalized).length > 4) return [];

  const rows = await prisma.$queryRawUnsafe<Array<{ canonicalJobId: string }>>(
    `SELECT "canonicalJobId"
     FROM "JobFeedIndex"
     WHERE
       status = 'LIVE'
       AND lower(company) = lower($1)
     ORDER BY
       "rankingScore" DESC,
       "postedAt" DESC
     LIMIT $2`,
    normalized,
    limit
  );

  return rows.map((row) => row.canonicalJobId);
}

/**
 * Cheap selectivity probe for a single scoped title/company search.
 *
 * Runs the same substring match the feed `contains` filter uses, but with NO
 * ordering and a hard `LIMIT threshold + 1`, so the trigram bitmap can stop
 * early. Returns:
 *  - `null` when the term is broad (more than `threshold` matches) — the caller
 *    should keep the default rank-ordered path, which is fast for dense terms.
 *  - the full list of matching canonical job ids when the term is selective.
 *    The caller constrains the feed query to these ids (a primary-key lookup),
 *    so ranking/pagination/count are all fast and the total is exact.
 */
async function getSelectiveScopedSearchIds(
  field: "title" | "company",
  query: string | undefined,
  threshold: number
): Promise<string[] | null> {
  const likePatternGroups = buildSearchLikePatternGroups(query);
  if (likePatternGroups.length === 0) return null;

  const column = field === "title" ? `"title"` : `"company"`;
  const params: string[] = [];
  const whereSql = likePatternGroups
    .map((patterns) => {
      const variantSql = patterns.map((pattern) => {
        params.push(pattern);
        return `${column} ILIKE $${params.length} ESCAPE '\\'`;
      });
      return `(${variantSql.join(" OR ")})`;
    })
    .join(" AND ");
  const limitParam = params.length + 1;

  // No ORDER BY here: the trigram bitmap can stop early at the LIMIT, so the
  // probe is fast even for broad terms (which we then reject). For selective
  // terms we get the full match set and order it in app by the same key the
  // feed uses (rankingScore desc, postedAt desc) — cheap for <= threshold rows.
  const rows = await prisma.$queryRawUnsafe<
    Array<{ canonicalJobId: string; rankingScore: number; postedAt: Date }>
  >(
    `SELECT "canonicalJobId", "rankingScore", "postedAt" FROM "JobFeedIndex"
     WHERE status = 'LIVE' AND ${whereSql}
     LIMIT $${limitParam}`,
    ...params,
    threshold + 1
  );

  if (rows.length > threshold) return null;
  rows.sort(
    (left, right) =>
      right.rankingScore - left.rankingScore ||
      right.postedAt.getTime() - left.postedAt.getTime()
  );
  return rows.map((row) => row.canonicalJobId);
}

function buildLocationSearchWhere(
  query: string | undefined
): PrismaTypes.JobCanonicalWhereInput | null {
  const locations = splitFilterValues(query);
  if (locations.length === 0) return null;

  const clauses = locations.flatMap((location) => {
    const expanded = expandLocationSearchTerm(location);
    const textCondition = buildScopedTextSearchWhere("location", location, "all-terms");
    const locationClauses: PrismaTypes.JobCanonicalWhereInput[] = [];

    if (textCondition) locationClauses.push(textCondition);

    for (const term of expanded.containsTerms) {
      locationClauses.push({
        location: { contains: term, mode: "insensitive" },
      });
    }

    if (expanded.region) {
      locationClauses.push({ region: expanded.region });
    }

    if (locationClauses.length === 0) return [];
    return locationClauses.length === 1 ? locationClauses : [{ OR: locationClauses }];
  });

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

function appendLocationSearchWhere(
  where: Prisma.JobCanonicalWhereInput,
  query: string | undefined
) {
  const condition = buildLocationSearchWhere(query);
  if (condition) appendAndCondition(where, condition);
}

function buildFeedIndexLocationSearchWhere(
  query: string | undefined
): PrismaTypes.JobFeedIndexWhereInput | null {
  const locations = splitFilterValues(query);
  if (locations.length === 0) return null;

  const clauses = locations.flatMap((location) => {
    const expanded = expandLocationSearchTerm(location);
    const textCondition = buildFeedIndexTextSearchWhere("location", location, "all-terms");
    const locationClauses: PrismaTypes.JobFeedIndexWhereInput[] = [];

    if (textCondition) locationClauses.push(textCondition);

    for (const term of expanded.containsTerms) {
      locationClauses.push({
        location: { contains: term, mode: "insensitive" },
      });
    }

    if (expanded.region) {
      locationClauses.push({ region: expanded.region });
    }

    if (locationClauses.length === 0) return [];
    return locationClauses.length === 1 ? locationClauses : [{ OR: locationClauses }];
  });

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

function appendFeedIndexLocationSearchWhere(
  where: Prisma.JobFeedIndexWhereInput,
  query: string | undefined
) {
  const condition = buildFeedIndexLocationSearchWhere(query);
  if (condition) appendFeedIndexAndCondition(where, condition);
}

function buildNumericSalaryRangeWhere(
  salaryMin: number | undefined,
  salaryMax: number | undefined
): PrismaTypes.JobCanonicalWhereInput | null {
  const clauses: PrismaTypes.JobCanonicalWhereInput[] = [];

  if (salaryMin) {
    clauses.push({
      OR: [{ salaryMax: { gte: salaryMin } }, { salaryMin: { gte: salaryMin } }],
    });
  }

  if (salaryMax) {
    clauses.push({
      OR: [
        { salaryMin: { lte: salaryMax } },
        {
          AND: [{ salaryMin: null }, { salaryMax: { lte: salaryMax } }],
        },
      ],
    });
  }

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

function buildNumericSalaryRangeIndexWhere(
  salaryMin: number | undefined,
  salaryMax: number | undefined
): PrismaTypes.JobFeedIndexWhereInput | null {
  const clauses: PrismaTypes.JobFeedIndexWhereInput[] = [];

  if (salaryMin) {
    clauses.push({
      OR: [{ salaryMax: { gte: salaryMin } }, { salaryMin: { gte: salaryMin } }],
    });
  }

  if (salaryMax) {
    clauses.push({
      OR: [
        { salaryMin: { lte: salaryMax } },
        {
          AND: [{ salaryMin: null }, { salaryMax: { lte: salaryMax } }],
        },
      ],
    });
  }

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

function buildSalaryRangeWhere(
  salaryMin: number | undefined,
  salaryMax: number | undefined,
  comparisonCurrency: SalaryComparisonCurrency,
  exchangeRates: SalaryExchangeRates,
  includeUnknownSalary: boolean = false
): PrismaTypes.JobCanonicalWhereInput | null {
  if (!salaryMin && !salaryMax) return null;

  const clauses: PrismaTypes.JobCanonicalWhereInput[] = [];

  for (const jobCurrency of SALARY_COMPARISON_CURRENCIES) {
    const convertedMin =
      salaryMin != null
        ? convertSalaryAmount(salaryMin, comparisonCurrency, jobCurrency, exchangeRates) ??
          undefined
        : undefined;
    const convertedMax =
      salaryMax != null
        ? convertSalaryAmount(salaryMax, comparisonCurrency, jobCurrency, exchangeRates) ??
          undefined
        : undefined;
    const rangeWhere = buildNumericSalaryRangeWhere(convertedMin, convertedMax);
    if (!rangeWhere) continue;

    clauses.push({
      AND: [{ salaryCurrency: jobCurrency }, rangeWhere],
    });
  }

  const rawFallback = buildNumericSalaryRangeWhere(salaryMin, salaryMax);
  if (rawFallback && comparisonCurrency === "USD") {
    clauses.push({
      AND: [{ salaryCurrency: null }, rawFallback],
    });
  }

  if (clauses.length === 0) return null;
  const salaryWhere = clauses.length === 1 ? clauses[0] : { OR: clauses };

  if (!includeUnknownSalary) return salaryWhere;

  return {
    OR: [
      salaryWhere,
      {
        AND: [{ salaryMin: null }, { salaryMax: null }],
      },
    ],
  };
}

function buildSalaryRangeIndexWhere(
  salaryMin: number | undefined,
  salaryMax: number | undefined,
  comparisonCurrency: SalaryComparisonCurrency,
  exchangeRates: SalaryExchangeRates,
  includeUnknownSalary: boolean = false
): PrismaTypes.JobFeedIndexWhereInput | null {
  if (!salaryMin && !salaryMax) return null;

  const clauses: PrismaTypes.JobFeedIndexWhereInput[] = [];

  for (const jobCurrency of SALARY_COMPARISON_CURRENCIES) {
    const convertedMin =
      salaryMin != null
        ? convertSalaryAmount(salaryMin, comparisonCurrency, jobCurrency, exchangeRates) ??
          undefined
        : undefined;
    const convertedMax =
      salaryMax != null
        ? convertSalaryAmount(salaryMax, comparisonCurrency, jobCurrency, exchangeRates) ??
          undefined
        : undefined;
    const rangeWhere = buildNumericSalaryRangeIndexWhere(convertedMin, convertedMax);
    if (!rangeWhere) continue;

    clauses.push({
      AND: [{ salaryCurrency: jobCurrency }, rangeWhere],
    });
  }

  const rawFallback = buildNumericSalaryRangeIndexWhere(salaryMin, salaryMax);
  if (rawFallback && comparisonCurrency === "USD") {
    clauses.push({
      AND: [{ salaryCurrency: null }, rawFallback],
    });
  }

  if (clauses.length === 0) return null;
  const salaryWhere = clauses.length === 1 ? clauses[0] : { OR: clauses };

  if (!includeUnknownSalary) return salaryWhere;

  return {
    OR: [
      salaryWhere,
      {
        AND: [{ salaryMin: null }, { salaryMax: null }],
      },
    ],
  };
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

type FeedPrefs = {
  roleFamilies: string[]; // e.g. ["SWE", "Data Analyst"]
  workModes: string[]; // e.g. ["REMOTE", "HYBRID"]
};

type ProfileMatchSignals = {
  location: string | null;
  locationRegion: "US" | "CA" | null;
  preferredWorkMode: string | null;
  experienceLevel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: SalaryComparisonCurrency;
  summaryPhrases: string[];
  summaryTokens: Set<string>;
  experiencePhrases: string[];
  experienceTokens: Set<string>;
  skillPhrases: string[];
  educationPhrases: string[];
};

type SearchBoostJob = {
  title: string;
  company: string;
  location: string;
  sourceMappings: Array<{
    sourceName: string;
    removedAt: Date | null;
  }>;
};

const EMPTY_PROFILE_MATCH_SIGNALS: ProfileMatchSignals = {
  location: null,
  locationRegion: null,
  preferredWorkMode: null,
  experienceLevel: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: "USD",
  summaryPhrases: [],
  summaryTokens: new Set<string>(),
  experiencePhrases: [],
  experienceTokens: new Set<string>(),
  skillPhrases: [],
  educationPhrases: [],
};

function scoreSearchResultBoost(
  job: SearchBoostJob,
  query: string | undefined,
  scope: JobSearchScope = "all"
) {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) return 0;

  const company = job.company.toLowerCase();
  const title = job.title.toLowerCase();
  const location = job.location.toLowerCase();
  const hasOfficialSource = job.sourceMappings.some(
    (mapping) =>
      mapping.removedAt === null &&
      mapping.sourceName.toLowerCase().startsWith("officialcompany:")
  );

  let score = 0;
  if (scope === "company") {
    if (company === normalizedQuery) score += 1000;
    else if (company.includes(normalizedQuery)) score += 600;
  } else if (scope === "title") {
    if (title === normalizedQuery) score += 800;
    else if (title.includes(normalizedQuery)) score += 500;
  } else if (scope === "location") {
    if (location === normalizedQuery) score += 700;
    else if (location.includes(normalizedQuery)) score += 450;
  } else {
    if (company === normalizedQuery) score += 1000;
    else if (company.includes(normalizedQuery)) score += 600;
    else if (title.includes(normalizedQuery)) score += 100;
    else if (location.includes(normalizedQuery)) score += 80;
  }

  if (hasOfficialSource) score += 75;
  return score;
}

function scoreSearchFiltersBoost(job: SearchBoostJob, filters: JobFilterParams) {
  const locationBoost = splitFilterValues(filters.locationSearch).reduce(
    (score, location) => Math.max(score, scoreSearchResultBoost(job, location, "location")),
    0
  );

  return (
    scoreSearchResultBoost(job, filters.search, filters.searchScope ?? "all") +
    scoreSearchResultBoost(job, filters.titleSearch, "title") +
    scoreSearchResultBoost(job, filters.companySearch, "company") +
    locationBoost
  );
}

const PROFILE_MATCH_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "into",
  "the",
  "with",
  "using",
  "work",
  "working",
  "role",
  "roles",
  "years",
  "year",
  "team",
  "teams",
  "experience",
  "experienced",
  "professional",
]);

const PROFILE_MATCH_SHORT_KEYWORDS = new Set([
  "ai",
  "ml",
  "qa",
  "ui",
  "ux",
  "hr",
  "bi",
]);

const EXPERIENCE_LEVEL_ORDER = new Map([
  ["ENTRY", 0],
  ["MID", 1],
  ["SENIOR", 2],
  ["LEAD", 3],
  ["EXECUTIVE", 4],
]);

function normalizeProfileMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/c\+\+/g, " cpp ")
    .replace(/c#/g, " csharp ")
    .replace(/\.net/g, " dotnet ")
    .replace(/next\.js/g, " nextjs ")
    .replace(/node\.js/g, " nodejs ")
    .replace(/react\.js/g, " reactjs ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProfileTokens(values: string[]) {
  const tokens = new Set<string>();

  for (const value of values) {
    const normalized = normalizeProfileMatchText(value);
    if (!normalized) continue;

    for (const token of normalized.split(" ")) {
      if (!token) continue;
      if (PROFILE_MATCH_STOP_WORDS.has(token)) continue;
      if (token.length >= 4 || PROFILE_MATCH_SHORT_KEYWORDS.has(token)) {
        tokens.add(token);
      }
    }
  }

  return tokens;
}

function containsProfilePhrase(haystack: string, phrase: string) {
  if (!haystack || !phrase) return false;

  if (phrase.includes(" ")) {
    return haystack.includes(phrase);
  }

  return ` ${haystack} `.includes(` ${phrase} `);
}

function countPhraseMatches(haystack: string, phrases: string[], maxMatches: number) {
  let matches = 0;

  for (const phrase of phrases) {
    if (!containsProfilePhrase(haystack, phrase)) {
      continue;
    }

    matches += 1;
    if (matches >= maxMatches) {
      break;
    }
  }

  return matches;
}

function countTokenMatches(jobTokens: Set<string>, profileTokens: Set<string>, maxMatches: number) {
  let matches = 0;

  for (const token of profileTokens) {
    if (!jobTokens.has(token)) {
      continue;
    }

    matches += 1;
    if (matches >= maxMatches) {
      break;
    }
  }

  return matches;
}

function getExperienceLevelDistance(
  jobExperienceLevel: string | null,
  profileExperienceLevel: string | null
) {
  if (!jobExperienceLevel || !profileExperienceLevel) {
    return null;
  }

  const jobRank = EXPERIENCE_LEVEL_ORDER.get(jobExperienceLevel);
  const profileRank = EXPERIENCE_LEVEL_ORDER.get(profileExperienceLevel);

  if (jobRank === undefined || profileRank === undefined) {
    return null;
  }

  return Math.abs(jobRank - profileRank);
}

function scoreProfileMatch(
  job: Pick<
    ScoringJobInput,
    | "title"
    | "shortSummary"
    | "roleFamily"
    | "workMode"
    | "experienceLevel"
    | "location"
    | "region"
    | "salaryMin"
    | "salaryMax"
    | "salaryCurrency"
  >,
  profile: ProfileMatchSignals
) {
  if (
    profile === EMPTY_PROFILE_MATCH_SIGNALS ||
    (!profile.location &&
      !profile.experienceLevel &&
      !profile.preferredWorkMode &&
      !profile.salaryMin &&
      !profile.salaryMax &&
      profile.summaryPhrases.length === 0 &&
      profile.experiencePhrases.length === 0 &&
      profile.skillPhrases.length === 0 &&
      profile.educationPhrases.length === 0)
  ) {
    return 0;
  }

  let score = 0;

  const experienceLevelDistance = getExperienceLevelDistance(
    job.experienceLevel,
    profile.experienceLevel
  );
  if (experienceLevelDistance === 0) {
    score += 8;
  } else if (experienceLevelDistance === 1) {
    score += 4;
  }

  if (
    job.workMode &&
    profile.preferredWorkMode &&
    profile.preferredWorkMode !== "UNKNOWN"
  ) {
    if (job.workMode === profile.preferredWorkMode) {
      score += 4;
    } else if (
      profile.preferredWorkMode === "FLEXIBLE" &&
      (job.workMode === "REMOTE" || job.workMode === "HYBRID")
    ) {
      score += 2;
    }
  }

  const matchText = normalizeProfileMatchText(
    [job.title, job.roleFamily ?? "", job.shortSummary ?? ""].join(" ")
  );
  const matchTokens = extractProfileTokens([job.title, job.roleFamily ?? "", job.shortSummary ?? ""]);

  const experiencePhraseMatches = countPhraseMatches(
    matchText,
    profile.experiencePhrases,
    2
  );
  score += experiencePhraseMatches * 5;

  if (experiencePhraseMatches === 0) {
    score += countTokenMatches(matchTokens, profile.experienceTokens, 2) * 2;
  }

  const summaryPhraseMatches = countPhraseMatches(matchText, profile.summaryPhrases, 2);
  score += summaryPhraseMatches * 3;

  if (summaryPhraseMatches === 0) {
    score += countTokenMatches(matchTokens, profile.summaryTokens, 2) * 2;
  }

  score += countPhraseMatches(matchText, profile.skillPhrases, 2) * 3;
  score += countPhraseMatches(matchText, profile.educationPhrases, 2) * 2;

  const normalizedJobLocation = normalizeProfileMatchText(job.location);
  if (profile.location && normalizedJobLocation) {
    if (
      containsProfilePhrase(normalizedJobLocation, profile.location) ||
      containsProfilePhrase(profile.location, normalizedJobLocation)
    ) {
      score += 6;
    } else {
      const locationTokens = extractProfileTokens([profile.location]);
      score += countTokenMatches(extractProfileTokens([job.location]), locationTokens, 2) * 2;
    }
  }

  if (job.region && profile.locationRegion && job.region === profile.locationRegion) {
    score += 3;
  }

  if (profile.salaryMin || profile.salaryMax) {
    const convertedSalary = convertSalaryRange({
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      fromCurrency: job.salaryCurrency,
      toCurrency: profile.salaryCurrency,
    });
    const jobMin = convertedSalary.salaryMin;
    const jobMax = convertedSalary.salaryMax;

    if (profile.salaryMin && jobMax) {
      if (jobMax >= profile.salaryMin) {
        score += 5;
        if (jobMin && jobMin >= profile.salaryMin) {
          score += 2;
        }
      } else if (jobMax >= Math.round(profile.salaryMin * 0.9)) {
        score += 1;
      } else {
        score -= 5;
      }
    }

    if (profile.salaryMax && jobMin && jobMin <= profile.salaryMax) {
      score += 1;
    }
  }

  return score;
}

/**
 * Aggregated behavior profile derived from the user's recent actions.
 * Each set contains lowercase keys for case-insensitive matching.
 */
type BehaviorProfile = {
  /** Role families the user has saved or applied to */
  boostedRoleFamilies: Set<string>;
  /** Role families the user has repeatedly passed on (≥2 passes) */
  suppressedRoleFamilies: Set<string>;
  /** Companies the user has saved or applied to */
  boostedCompanies: Set<string>;
};

async function loadFeedPrefs(userId?: string | null): Promise<FeedPrefs> {
  if (!userId) {
    return {
      roleFamilies: [],
      workModes: [],
    };
  }

  const rows = await prisma.userPreference.findMany({
    where: { userId },
    select: { key: true, value: true },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    roleFamilies: (map["softSignal:preferredRoleFamily"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    workModes: (map["hardFilter:workMode"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Load and aggregate the user's recent behavior signals into a ranking profile.
 * Looks at the last 90 days of SAVE, APPLY, and PASS actions. Joins through
 * to the canonical job to extract roleFamily, company, and workMode patterns.
 */
async function loadBehaviorProfile(userId?: string | null): Promise<BehaviorProfile> {
  if (!userId) {
    return {
      boostedRoleFamilies: new Set<string>(),
      suppressedRoleFamilies: new Set<string>(),
      boostedCompanies: new Set<string>(),
    };
  }

  const cutoff = new Date(Date.now() - 90 * 86_400_000);

  const signals = await prisma.userBehaviorSignal.findMany({
    where: {
      userId,
      action: { in: ["SAVE", "APPLY", "PASS"] },
      createdAt: { gte: cutoff },
    },
    select: {
      action: true,
      canonicalJob: {
        select: {
          roleFamily: true,
          company: true,
          workMode: true,
        },
      },
    },
  });

  const boostedRoleFamilies = new Set<string>();
  const boostedCompanies = new Set<string>();
  const passRoleFamilyCounts = new Map<string, number>();

  for (const signal of signals) {
    const job = signal.canonicalJob;
    if (signal.action === "SAVE" || signal.action === "APPLY") {
      if (job.roleFamily) boostedRoleFamilies.add(job.roleFamily.toLowerCase());
      if (job.company) boostedCompanies.add(job.company.toLowerCase());
    } else if (signal.action === "PASS") {
      if (job.roleFamily) {
        const key = job.roleFamily.toLowerCase();
        passRoleFamilyCounts.set(key, (passRoleFamilyCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Only suppress role families with ≥2 passes and no positive engagement
  const suppressedRoleFamilies = new Set<string>();
  for (const [rf, count] of passRoleFamilyCounts) {
    if (count >= 2 && !boostedRoleFamilies.has(rf)) {
      suppressedRoleFamilies.add(rf);
    }
  }

  return {
    boostedRoleFamilies,
    suppressedRoleFamilies,
    boostedCompanies,
  };
}

const ATS_SOURCE_RE = /^(OfficialCompany|Ashby|Greenhouse|Jobvite|Lever|Recruitee|Rippling|SmartRecruiters|SuccessFactors|Taleo|Workable|Workday|iCIMS):/;

// ─── Detailed scoring (used by feed ranking + debug view) ────────────────────

export type ScoreBreakdown = {
  total: number;
  eligibility: number;
  freshness: number;
  availability: number;
  regionConfidence: number;
  profileMatch: number;
  prefRoleFamily: number;
  prefWorkMode: number;
  behaviorRoleFamily: number;
  behaviorCompany: number;
  behaviorSuppression: number;
  sourceTrust: number;
  multiSource: number;
};

export type ScoringJobInput = {
  title: string;
  location: string;
  postedAt: Date | null;
  status: string | null;
  availabilityScore: number;
  qualityScore?: number | null;
  trustScore?: number | null;
  freshnessScore?: number | null;
  region: string | null;
  workMode: string | null;
  roleFamily: string | null;
  experienceLevel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  shortSummary?: string | null;
  applyUrl?: string | null;
  company: string | null;
  eligibility: { submissionCategory: string } | null;
  sourceMappings: {
    sourceName: string;
    sourceQualityRank?: number | null;
    sourceReliability?: number | null;
  }[];
};

/**
 * Score a job for relevance ranking with full breakdown.
 *
 * Scoring bands:
 *   Application readiness: 0–8  (clean source/form metadata)
 *   Freshness:          -16–20  (graduated by age, more strongly demotes very old jobs)
 *   Availability:       -14–18  (health/lifecycle confidence)
 *   Profile match:       -5–36  (experience titles, skills, education, mode, level, salary)
 *   Preference match:     0–15  (explicit user role-family prefs)
 *   Work mode pref:       0–10  (explicit user work-mode prefs)
 *   Behavior – role:      0–8   (saved/applied role families)
 *   Behavior – company:   0–6   (saved/applied companies)
 *   Behavior – suppress: -6–0   (repeatedly passed role families)
 *   Source trust:          0–5   (structured ATS sources)
 *   Multi-source:          0–3   (confirmed across ≥2 sources)
 *   ─────────────────────────────
 *   Range:              -30–105
 */
export function scoreJobDetailed(
  job: ScoringJobInput,
  prefs: FeedPrefs,
  behavior: BehaviorProfile,
  profile: ProfileMatchSignals = EMPTY_PROFILE_MATCH_SIGNALS
): ScoreBreakdown {
  let eligibility = 0;
  let freshness = 0;
  let availability = 0;
  let regionConfidence = 0;
  let profileMatch = 0;
  let prefRoleFamily = 0;
  let prefWorkMode = 0;
  let behaviorRoleFamily = 0;
  let behaviorCompany = 0;
  let behaviorSuppression = 0;
  let sourceTrust = 0;

  // Application readiness (0-8)
  const cat = job.eligibility?.submissionCategory;
  if (cat === "READY_TO_APPLY") eligibility = 8;
  else if (cat === "REVIEW_REQUIRED") eligibility = 4;

  // Freshness (-16 to 20): rewards recency, more strongly demotes very old live jobs
  if (job.postedAt) {
    const daysAgo = (Date.now() - job.postedAt.getTime()) / 86_400_000;
    if (daysAgo <= 1) freshness = 20;
    else if (daysAgo <= 3) freshness = 17;
    else if (daysAgo <= 7) freshness = 14;
    else if (daysAgo <= 14) freshness = 10;
    else if (daysAgo <= 21) freshness = 6;
    else if (daysAgo <= 45) freshness = 2;
    else if (daysAgo <= 90) freshness = -4;
    else if (daysAgo <= 180) freshness = -8;
    else if (daysAgo <= 365) freshness = -12;
    else freshness = -16;
  }

  if (job.status === "LIVE") availability += 8;
  else if (job.status === "AGING") availability += 3;
  else if (job.status === "STALE") availability -= 8;
  else availability -= 14;

  if (job.availabilityScore >= 90) availability += 10;
  else if (job.availabilityScore >= 75) availability += 7;
  else if (job.availabilityScore >= 60) availability += 4;
  else if (job.availabilityScore >= 45) availability += 1;
  else if (job.availabilityScore >= 30) availability -= 3;
  else availability -= 6;

  const geoScope = inferGeoScope(job.location, job.region as "US" | "CA" | null);

  // Geography confidence: global jobs are now first-class feed entries. Keep a
  // small boost for clearly resolved regions, but do not demote valid non-NA
  // jobs just because the legacy Region enum cannot represent their country.
  if (geoScope === "US" || geoScope === "CA") regionConfidence = 6;
  else if (geoScope === "NORTH_AMERICA") regionConfidence = 3;
  else if (geoScope === "GLOBAL") regionConfidence = 2;
  else if (geoScope === "UNKNOWN") regionConfidence = 0;
  else regionConfidence = 1;

  profileMatch = scoreProfileMatch(job, profile);

  // Role family match vs explicit prefs (0-15)
  if (
    job.roleFamily &&
    prefs.roleFamilies.some((rf) =>
      job.roleFamily!.toLowerCase().includes(rf.toLowerCase())
    )
  ) {
    prefRoleFamily = 15;
  }

  // Work mode match vs explicit prefs (0-10)
  if (job.workMode && prefs.workModes.includes(job.workMode)) {
    prefWorkMode = 10;
  }

  // Behavior signals
  const rfLower = job.roleFamily?.toLowerCase() ?? "";
  const companyLower = job.company?.toLowerCase() ?? "";

  if (rfLower && behavior.boostedRoleFamilies.has(rfLower)) {
    behaviorRoleFamily = 8;
  }
  if (companyLower && behavior.boostedCompanies.has(companyLower)) {
    behaviorCompany = 6;
  }
  // Work mode behavior boost removed: in practice it fires for nearly all modes
  // (REMOTE, ONSITE, FLEXIBLE) making it noise rather than signal.
  if (rfLower && behavior.suppressedRoleFamilies.has(rfLower)) {
    behaviorSuppression = -6;
  }

  // Source trust (0-5)
  const strongestSource = [...job.sourceMappings].sort(
    (left, right) =>
      (right.sourceQualityRank ?? 0) - (left.sourceQualityRank ?? 0) ||
      (right.sourceReliability ?? 0) - (left.sourceReliability ?? 0)
  )[0];
  if (strongestSource && ATS_SOURCE_RE.test(strongestSource.sourceName)) {
    sourceTrust = 5;
  } else if ((strongestSource?.sourceReliability ?? 0) >= 0.85) {
    sourceTrust = 4;
  } else if ((strongestSource?.sourceReliability ?? 0) >= 0.7) {
    sourceTrust = 2;
  }

  // Multi-source dedup confirmation (0-3)
  // Jobs confirmed across ≥2 active source mappings get a small boost
  const trustedSourceCount = job.sourceMappings.filter((sm) =>
    ATS_SOURCE_RE.test(sm.sourceName)
  ).length;
  const multiSource = trustedSourceCount >= 2 ? 3 : 0;

  return {
    total:
      eligibility +
      freshness +
      availability +
      regionConfidence +
      profileMatch +
      prefRoleFamily +
      prefWorkMode +
      behaviorRoleFamily +
      behaviorCompany +
      behaviorSuppression +
      sourceTrust +
      multiSource,
    eligibility,
    freshness,
    availability,
    regionConfidence,
    profileMatch,
    prefRoleFamily,
    prefWorkMode,
    behaviorRoleFamily,
    behaviorCompany,
    behaviorSuppression,
    sourceTrust,
    multiSource,
  };
}

function scoreRecommendedJob(job: ScoringJobInput): number {
  const sourceCount = job.sourceMappings.length;
  const strongestSource = [...job.sourceMappings].sort(
    (left, right) =>
      (right.sourceQualityRank ?? 0) - (left.sourceQualityRank ?? 0) ||
      (right.sourceReliability ?? 0) - (left.sourceReliability ?? 0)
  )[0];
  const sourceTrustFallback =
    strongestSource == null
      ? 0
      : Math.max(
          strongestSource.sourceQualityRank ?? 0,
          (strongestSource.sourceReliability ?? 0) * 100
        );
  const freshnessFallback = (() => {
    if (!job.postedAt) return 40;
    const daysAgo = Math.max(0, (Date.now() - job.postedAt.getTime()) / 86_400_000);
    if (daysAgo <= 1) return 100;
    if (daysAgo <= 3) return 92;
    if (daysAgo <= 7) return 84;
    if (daysAgo <= 14) return 72;
    if (daysAgo <= 30) return 58;
    if (daysAgo <= 60) return 42;
    return 25;
  })();

  return computeRankingScore({
    qualityScore: job.qualityScore ?? 50,
    trustScore: job.trustScore ?? sourceTrustFallback,
    freshnessScore: job.freshnessScore ?? freshnessFallback,
    availabilityScore: job.availabilityScore,
    sourceCount,
    submissionCategory: (job.eligibility?.submissionCategory ?? null) as SubmissionCategory | null,
  });
}

type RankedFeedCandidate = {
  id: string;
  title: string;
  company: string;
  postedAt: Date | null;
  sourceMappings: { sourceName: string }[];
  baseScore: number;
};

function diversifyRankedJobs(
  candidates: RankedFeedCandidate[],
  limit: number = candidates.length
) {
  const remaining = [...candidates];
  const selected: RankedFeedCandidate[] = [];
  const companyCounts = new Map<string, number>();
  const companyTitleCounts = new Map<string, number>();
  const sourceFamilyCounts = new Map<string, number>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const adjustedScore =
        candidate.baseScore -
        getCompanyPenalty(companyCounts.get(toKey(candidate.company)) ?? 0) -
        getTitleClusterPenalty(
          companyTitleCounts.get(buildCompanyTitleKey(candidate.company, candidate.title)) ?? 0
        ) -
        getSourceFamilyPenalty(candidate.sourceMappings, sourceFamilyCounts);

      if (
        adjustedScore > bestScore ||
        (adjustedScore === bestScore &&
          (candidate.postedAt?.getTime() ?? 0) >
            (remaining[bestIndex]?.postedAt?.getTime() ?? 0))
      ) {
        bestScore = adjustedScore;
        bestIndex = index;
      }
    }

    const [selectedCandidate] = remaining.splice(bestIndex, 1);
    selected.push(selectedCandidate);

    const companyKey = toKey(selectedCandidate.company);
    companyCounts.set(companyKey, (companyCounts.get(companyKey) ?? 0) + 1);

    const companyTitleKey = buildCompanyTitleKey(
      selectedCandidate.company,
      selectedCandidate.title
    );
    companyTitleCounts.set(
      companyTitleKey,
      (companyTitleCounts.get(companyTitleKey) ?? 0) + 1
    );

    for (const sourceFamily of getSourceFamilies(selectedCandidate.sourceMappings)) {
      sourceFamilyCounts.set(
        sourceFamily,
        (sourceFamilyCounts.get(sourceFamily) ?? 0) + 1
      );
    }
  }

  return selected;
}

function getCompanyPenalty(companyCount: number) {
  if (companyCount <= 0) return 0;
  if (companyCount === 1) return 2;
  if (companyCount === 2) return 4;
  return 6;
}

function getTitleClusterPenalty(titleCount: number) {
  if (titleCount <= 0) return 0;
  return 8 + (titleCount - 1) * 2;
}

function getSourceFamilyPenalty(
  sourceMappings: { sourceName: string }[],
  sourceFamilyCounts: Map<string, number>
) {
  const peakCount = Math.max(
    0,
    ...getSourceFamilies(sourceMappings).map(
      (sourceFamily) => sourceFamilyCounts.get(sourceFamily) ?? 0
    )
  );

  if (peakCount < 6) return 0;
  if (peakCount < 10) return 1;
  if (peakCount < 14) return 2;
  return 3;
}

function getSourceFamilies(sourceMappings: { sourceName: string }[]) {
  return [...new Set(sourceMappings.map((mapping) => mapping.sourceName.split(":")[0]))];
}

function buildCompanyTitleKey(company: string, title: string) {
  return `${toKey(company)}::${toKey(title.replace(/\([^)]*\)/g, " "))}`;
}

function toKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// Export data loaders for the ranking debug page
export { loadFeedPrefs, loadBehaviorProfile };
export type { FeedPrefs, BehaviorProfile };

/**
 * Relevance-ranked job feed with in-memory scoring and diversification.
 *
 * To keep latency acceptable at scale (50K+ live jobs), we use a two-pass
 * approach:
 *  1. Count total for pagination display (cheap DB count).
 *  2. Fetch a scoring window of the top N most-recent/highest-signal jobs
 *     (DB pre-sorted by postedAt), score and diversify in memory, paginate.
 *
 * The scoring window caps how many jobs we load for ranking. The default feed
 * uses a smaller window than explicit search so page-1 latency stays tighter
 * on the main surface, while deeper pages still fall back to DB ordering.
 */
const DEFAULT_SCORING_WINDOW_SIZE = 1200;
const SEARCH_SCORING_WINDOW_SIZE = 1800;
const SEARCH_MATCH_ID_LIMIT = 25_000;
type JobFeedSummary = {
  liveJobCount: number;
  addedTodayCount: number;
  expiredTodayCount: number;
  removedTodayCount: number;
};

type JobsResult = Awaited<ReturnType<typeof getJobsByRelevance>> & {
  summary: JobFeedSummary;
};

type DemoSourceMapping = {
  sourceName: string;
};

function isDemoOnlySourceMappings(sourceMappings: DemoSourceMapping[]) {
  return (
    sourceMappings.length > 0 &&
    sourceMappings.every((mapping) => DEMO_SOURCE_NAME_SET.has(mapping.sourceName))
  );
}

function buildDemoOnlySourceWhere(): PrismaTypes.JobCanonicalWhereInput | null {
  if (!DEMO_SOURCE_NAMES[0]) return null;

  return {
    sourceMappings: {
      some: {
        sourceName: {
          in: [...DEMO_SOURCE_NAMES],
        },
      },
      none: {
        sourceName: {
          notIn: [...DEMO_SOURCE_NAMES],
        },
      },
    },
  };
}

async function getHiddenDemoOnlySummaryCounts(
  startOfToday: Date,
  now: Date
): Promise<JobFeedSummary> {
  const demoOnlyWhere = buildDemoOnlySourceWhere();
  if (!demoOnlyWhere) {
    return {
      liveJobCount: 0,
      addedTodayCount: 0,
      expiredTodayCount: 0,
      removedTodayCount: 0,
    };
  }

  const visibleWhere = buildDefaultJobBoardVisibilityWhere(now);
  const [liveJobCount, addedTodayCount, expiredTodayCount, removedTodayCount] =
    await Promise.all([
      prisma.jobCanonical.count({
        where: {
          AND: [visibleWhere, demoOnlyWhere],
        },
      }),
      prisma.jobCanonical.count({
        where: {
          AND: [
            visibleWhere,
            demoOnlyWhere,
            { firstSeenAt: { gte: startOfToday } },
          ],
        },
      }),
      prisma.jobCanonical.count({
        where: {
          AND: [
            demoOnlyWhere,
            { status: "EXPIRED" },
            { expiredAt: { gte: startOfToday } },
          ],
        },
      }),
      prisma.jobCanonical.count({
        where: {
          AND: [
            demoOnlyWhere,
            { status: "REMOVED" },
            { removedAt: { gte: startOfToday } },
          ],
        },
      }),
    ]);

  return {
    liveJobCount,
    addedTodayCount,
    expiredTodayCount,
    removedTodayCount,
  };
}

async function getDailyJobFeedSummaryCounts(
  startOfToday: Date,
  now: Date
): Promise<Omit<JobFeedSummary, "liveJobCount">> {
  const visibleWhere = buildDefaultJobBoardVisibilityWhere(now);
  const [addedTodayCount, expiredTodayCount, removedTodayCount] = await Promise.all([
    prisma.jobCanonical.count({
      where: {
        AND: [
          visibleWhere,
          { firstSeenAt: { gte: startOfToday } },
        ],
      },
    }),
    prisma.jobCanonical.count({
      where: {
        status: "EXPIRED",
        expiredAt: { gte: startOfToday },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        status: "REMOVED",
        removedAt: { gte: startOfToday },
      },
    }),
  ]);

  return {
    addedTodayCount,
    expiredTodayCount,
    removedTodayCount,
  };
}


function readTimedCache<T>(key: string): T | null {
  const entry = timedCacheStore.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    timedCacheStore.delete(key);
    return null;
  }

  return entry.value as T;
}

function writeTimedCache<T>(key: string, value: T, ttlMs: number) {
  timedCacheStore.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });

  if (timedCacheStore.size <= TIMED_CACHE_MAX_ENTRIES) return value;

  const oldestEntry = [...timedCacheStore.entries()].sort(
    (left, right) => left[1].expiresAt - right[1].expiresAt
  )[0];

  if (oldestEntry) {
    timedCacheStore.delete(oldestEntry[0]);
  }

  return value;
}

function buildJobsCacheKey(
  viewerProfileId: string | null,
  filters: JobFilterParams,
  cacheEpoch: string | null = null,
  summaryTimeZone: string = normalizeUserTimeZone()
) {
  return `jobs:${viewerProfileId ?? "anon"}:${JSON.stringify({
    search: filters.search ?? null,
    searchScope: filters.search ? (filters.searchScope ?? "all") : null,
    titleSearch: filters.titleSearch ?? null,
    companySearch: filters.companySearch ?? null,
    locationSearch: filters.locationSearch ?? null,
    location: filters.location ?? null,
    source: filters.source ?? null,
    region: filters.region ?? null,
    workMode: filters.workMode ?? null,
    employmentType: filters.employmentType ?? null,
    industry: filters.industry ?? null,
    roleCategory: filters.roleCategory ?? null,
    roleFamily: filters.roleFamily ?? null,
    salaryMin: filters.salaryMin ?? null,
    salaryMax: filters.salaryMax ?? null,
    salaryCurrency: filters.salaryCurrency ?? null,
    careerStage: filters.careerStage ?? filters.experienceLevel ?? null,
    experienceLevel: filters.experienceLevel ?? null,
    expiry: filters.expiry ?? null,
    posted: filters.posted ?? null,
    submissionCategory: filters.submissionCategory ?? null,
    status: hasNonDefaultJobStatusFilter(filters.status) ? filters.status ?? null : null,
    hideApplied: filters.hideApplied ? 1 : null,
    sortBy: filters.sortBy ?? null,
    page: filters.page ?? 1,
    debugFilters: filters.debugFilters ? 1 : null,
    summaryTimeZone,
    cacheEpoch,
  })}`;
}

function hasScopedFeedRequest(filters: JobFilterParams) {
  return Boolean(
    hasSearchFilters(filters) ||
    filters.location ||
    filters.source ||
    filters.region ||
    filters.workMode ||
    filters.employmentType ||
    filters.industry ||
    filters.roleCategory ||
    filters.roleFamily ||
    filters.salaryMin !== undefined ||
    filters.salaryMax !== undefined ||
    filters.careerStage ||
    filters.experienceLevel ||
    filters.expiry ||
    filters.posted ||
    filters.submissionCategory ||
    hasNonDefaultJobStatusFilter(filters.status) ||
    filters.hideApplied
  );
}

function isHotDefaultFeedRequest(filters: JobFilterParams) {
  return !hasScopedFeedRequest(filters) &&
    (!filters.sortBy || filters.sortBy === "relevance") &&
    (filters.page ?? 1) === 1;
}

async function loadSalaryComparisonCurrency(
  requestedCurrency: string | null | undefined,
  viewerProfileId: string | null
): Promise<SalaryComparisonCurrency> {
  const normalizedRequest = normalizeSalaryCurrency(requestedCurrency);
  if (normalizedRequest) return normalizedRequest;

  if (!viewerProfileId) return "USD";

  const profile = await prisma.userProfile.findUnique({
    where: { id: viewerProfileId },
    select: { salaryCurrency: true },
  });

  return normalizeSalaryCurrency(profile?.salaryCurrency) ?? "USD";
}

async function getJobFeedSummary(timeZone: string) {
  const normalizedTimeZone = normalizeUserTimeZone(timeZone);
  const cacheKey = `jobs:summary:${normalizedTimeZone}`;
  const cached = readTimedCache<JobFeedSummary>(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const startOfToday = getStartOfTodayInTimeZone(normalizedTimeZone, now);

  // Fast path: read the pre-aggregated row written by the
  // refresh-job-feed-summary timer (every 5 min). Single PK lookup, sub-ms.
  // The header stats are operational context, not filter-contract data, so
  // freshness beats exact per-request timezone recomputation here.
  try {
    const cachedRow = await prisma.jobFeedSummaryCache.findUnique({
      where: { id: "singleton" },
    });
    if (cachedRow) {
      const value: JobFeedSummary = {
        liveJobCount: cachedRow.liveJobCount,
        addedTodayCount: cachedRow.addedTodayCount,
        expiredTodayCount: cachedRow.expiredTodayCount,
        removedTodayCount: cachedRow.removedTodayCount,
      };
      return writeTimedCache(
        cacheKey,
        value,
        JOB_FEED_SUMMARY_TTL_MS
      );
    }
  } catch (error) {
    // Cache table not yet created or query failed — fall through to live.
    console.warn(
      "[getJobFeedSummary] cache read failed, falling back to live counts:",
      error
    );
  }

  // Cold-path fallback: compute live. Slow (8 COUNTs) but only used when the
  // cache row doesn't exist yet (e.g., first deploy before the timer fired).
  const visibleWhere = buildDefaultJobBoardVisibilityWhere(now);
  const [
    liveJobCount,
    dailyCounts,
    hiddenDemoCounts,
  ] = await Promise.all([
    prisma.jobCanonical.count({ where: visibleWhere }),
    getDailyJobFeedSummaryCounts(startOfToday, now),
    getHiddenDemoOnlySummaryCounts(startOfToday, now),
  ]);

  return writeTimedCache(cacheKey, {
    liveJobCount: Math.max(0, liveJobCount - hiddenDemoCounts.liveJobCount),
    addedTodayCount: Math.max(0, dailyCounts.addedTodayCount - hiddenDemoCounts.addedTodayCount),
    expiredTodayCount: Math.max(0, dailyCounts.expiredTodayCount - hiddenDemoCounts.expiredTodayCount),
    removedTodayCount: Math.max(0, dailyCounts.removedTodayCount - hiddenDemoCounts.removedTodayCount),
  } satisfies JobFeedSummary, JOB_FEED_SUMMARY_TTL_MS);
}

async function getJobsByRelevance(
  filters: JobFilterParams,
  where: Prisma.JobCanonicalWhereInput,
  viewerProfileId: string | null,
  authUserId: string | null,
  includeExactTotal: boolean,
  useSqlDemoVisibilityFilter: boolean,
  totalFallback: number | null = null
) {
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;
  const scoringWindowSize = hasSearchFilters(filters)
    ? SEARCH_SCORING_WINDOW_SIZE
    : DEFAULT_SCORING_WINDOW_SIZE;

  // If the user is requesting a deep page beyond the scoring window,
  // fall back to simple newest-first ordering (fast DB query).
  if (skip >= scoringWindowSize) {
    const jobs = await prisma.jobCanonical.findMany({
      where,
      select: JOB_FEED_CARD_SELECT(viewerProfileId, authUserId),
      orderBy: buildCanonicalFeedOrderBy(undefined),
      skip,
      take: PAGE_SIZE * 3,
    });
    const visibleJobs = jobs.filter((job) =>
      isClearlyVisibleJobPosting({
        title: job.title,
        description: job.shortSummary,
        applyUrl: job.applyUrl,
      })
    );
    const slicedJobs = visibleJobs.slice(0, PAGE_SIZE);
    const data = slicedJobs.map((job) => {
      const { savedJobs, trackedApplications, ...rest } = job;
      return withSanitizedJobFeedPresentation({
        ...rest,
        isSaved: savedJobs.length > 0,
        hasApplied: trackedApplications.length > 0,
      });
    });

    if (!includeExactTotal) {
      return {
        data,
        total: null,
        hasNextPage: visibleJobs.length > PAGE_SIZE,
        page,
        pageSize: PAGE_SIZE,
      };
    }

    const total = await prisma.jobCanonical.count({ where });
    const effectiveTotal = total ?? totalFallback;
    return {
      data,
      total: effectiveTotal,
      hasNextPage:
        effectiveTotal !== null ? skip + PAGE_SIZE < effectiveTotal : data.length === PAGE_SIZE,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  const scoringJobsPromise = prisma.jobCanonical.findMany({
    where,
    select: {
      id: true,
      title: true,
      location: true,
      postedAt: true,
      status: true,
      availabilityScore: true,
      qualityScore: true,
      trustScore: true,
      freshnessScore: true,
      region: true,
      workMode: true,
      roleFamily: true,
      experienceLevel: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      shortSummary: true,
      applyUrl: true,
      company: true,
      eligibility: { select: { submissionCategory: true } },
      sourceMappings: {
        select: {
          sourceName: true,
          sourceQualityRank: true,
          sourceReliability: true,
          removedAt: true,
        },
      },
    },
    orderBy: buildCanonicalFeedOrderBy(undefined),
    take: scoringWindowSize,
  });

  const totalPromise = includeExactTotal
    ? prisma.jobCanonical.count({ where })
    : Promise.resolve(null);

  const [scoringJobs, total] = await Promise.all([
    scoringJobsPromise,
    totalPromise,
  ]);

  const visibleScoringJobs = useSqlDemoVisibilityFilter
    ? scoringJobs
    : scoringJobs.filter(
        (job) => !isDemoOnlySourceMappings(job.sourceMappings)
      );
  const visibleRealJobs = visibleScoringJobs.filter((job) =>
    isClearlyVisibleJobPosting({
      title: job.title,
      shortSummary: job.shortSummary,
      applyUrl: job.applyUrl,
    })
  );
  const diversifiedSelectionLimit = Math.min(
    visibleRealJobs.length,
    skip + PAGE_SIZE + DIVERSIFICATION_OVERSCAN
  );

  // Score → diversify → paginate in memory.
  const sorted = diversifyRankedJobs(
    visibleRealJobs
      .map((job) => ({
        id: job.id,
        title: job.title,
        company: job.company,
        postedAt: job.postedAt,
        sourceMappings: job.sourceMappings
          .filter((mapping) => mapping.removedAt === null)
          .map(({ sourceName, sourceQualityRank, sourceReliability }) => ({
            sourceName,
            sourceQualityRank,
            sourceReliability,
          })),
        baseScore: scoreRecommendedJob(
          {
            ...job,
            sourceMappings: job.sourceMappings
              .filter((mapping) => mapping.removedAt === null)
              .map(({ sourceName, sourceQualityRank, sourceReliability }) => ({
                sourceName,
                sourceQualityRank,
                sourceReliability,
              })),
          },
        ) + scoreSearchFiltersBoost(job, filters),
      }))
      .sort(
        (a, b) =>
          b.baseScore - a.baseScore ||
          (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0)
      ),
    diversifiedSelectionLimit
  );

  const pageIds = sorted.slice(skip, skip + PAGE_SIZE).map((job) => job.id);
  const effectiveTotal = total ?? totalFallback;
  const hasNextPage =
    effectiveTotal !== null ? skip + PAGE_SIZE < effectiveTotal : sorted.length > skip + PAGE_SIZE;

  if (pageIds.length === 0) {
    return { data: [], total: effectiveTotal, hasNextPage: false, page, pageSize: PAGE_SIZE };
  }

  // Fetch full data for this page only
  const jobs = await prisma.jobCanonical.findMany({
    where: { id: { in: pageIds } },
    select: JOB_FEED_CARD_SELECT(viewerProfileId, authUserId),
  });

  // Restore relevance order (Prisma doesn't preserve id-in ordering)
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const data = pageIds.flatMap((id) => {
    const job = jobMap.get(id);
    if (!job) return [];
    if (
      !isClearlyVisibleJobPosting({
        title: job.title,
        description: job.shortSummary,
        applyUrl: job.applyUrl,
      })
    ) {
      return [];
    }
    const { savedJobs, trackedApplications, ...rest } = job;
    return [
      withSanitizedJobFeedPresentation({
        ...rest,
        isSaved: savedJobs.length > 0,
        hasApplied: trackedApplications.length > 0,
      }),
    ];
  });

  return { data, total: effectiveTotal, hasNextPage, page, pageSize: PAGE_SIZE };
}

export type JobFilterParams = {
  search?: string;
  searchScope?: JobSearchScope;
  titleSearch?: string;
  companySearch?: string;
  locationSearch?: string;
  location?: string;
  source?: string;
  region?: string;
  workMode?: string;
  employmentType?: string;
  industry?: string;
  roleCategory?: string;
  roleFamily?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: SalaryComparisonCurrency;
  includeUnknownSalary?: boolean;
  experienceLevel?: string;
  careerStage?: string;
  expiry?: string;
  posted?: string;
  submissionCategory?: string;
  status?: string;
  hideApplied?: boolean;
  sortBy?: JobSortBy;
  page?: number;
  debugFilters?: boolean;
};

export async function getJobs(
  inputFilters: JobFilterParams,
  options?: {
    viewerProfileId?: string | null;
    authUserId?: string | null;
    userTimeZone?: string | null;
  }
) {
  const viewerProfileId =
    options && "viewerProfileId" in options
      ? (options.viewerProfileId ?? null)
      : await getOptionalCurrentProfileId();
  const authUserId =
    options && "authUserId" in options
      ? (options.authUserId ?? null)
      : await getOptionalCurrentAuthUserId();
  const userTimeZone = normalizeUserTimeZone(options?.userTimeZone);
  const salaryCurrency = await loadSalaryComparisonCurrency(
    inputFilters.salaryCurrency,
    viewerProfileId
  );
  const filters: JobFilterParams = {
    ...inputFilters,
    salaryCurrency,
    sortBy: normalizeJobSortBy(inputFilters.sortBy),
  };
  const salaryExchangeRates =
    filters.salaryMin || filters.salaryMax
      ? await loadSalaryExchangeRates()
      : FALLBACK_SALARY_EXCHANGE_RATES;
  const useHotFeedSnapshot = isHotDefaultFeedRequest(filters);
  const heartbeat = useHotFeedSnapshot ? await getIngestionHeartbeat() : null;
  const cacheKey = buildJobsCacheKey(
    viewerProfileId,
    filters,
    useHotFeedSnapshot ? (heartbeat?.lastUpdatedAt ?? "none") : null,
    userTimeZone
  );
  const cached = readTimedCache<JobsResult>(cacheKey);
  if (cached) return cached;
  const inflight = inflightJobsQueryStore.get(cacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    const page = filters.page ?? 1;
    const skip = (page - 1) * PAGE_SIZE;
    const hasAnySearch = hasSearchFilters(filters);
    const summaryPromise = getJobFeedSummary(userTimeZone);
    const useFeedIndexForRequest = shouldUseJobFeedIndex(filters, viewerProfileId);
    // The unfiltered headline is the exact public-board count maintained in
    // JobFeedSummaryCache. Do not repeat an expensive per-user COUNT merely to
    // calculate pagination for that same default pool. Searches and filters
    // still return their exact matching total for the headline and pagination.
    const includeExactTotal = hasScopedFeedRequest(filters);
    const isExplicitSort = Boolean(filters.sortBy && filters.sortBy !== "relevance");
    const defaultScoringWindowPages = Math.floor(DEFAULT_SCORING_WINDOW_SIZE / PAGE_SIZE);
    const useSqlDemoVisibilityFilter =
      !useFeedIndexForRequest &&
      (includeExactTotal || isExplicitSort || page > defaultScoringWindowPages);
    const cacheResult = (result: JobsResult, source: string = "canonical") =>
      writeTimedCache(
        cacheKey,
        finalizeJobsResult(filters, result, source),
        useHotFeedSnapshot ? HOT_FEED_QUERY_TTL_MS : JOB_FEED_QUERY_TTL_MS
      );

    const where: Prisma.JobCanonicalWhereInput = {};
    let searchMatchTotalHint: number | null = null;

    if (useSqlDemoVisibilityFilter) {
      where.sourceMappings = {
        some: {
          sourceName: {
            notIn: [...DEMO_SOURCE_NAMES],
          },
        },
      };
    }

    if (viewerProfileId) {
      where.behaviorSignals = {
        none: {
          userId: viewerProfileId,
          action: "PASS",
        },
      };
    }
    if (filters.hideApplied && authUserId) {
      appendAndCondition(where, buildNotAppliedCanonicalWhere(authUserId));
    }

    if (filters.search) {
      const matchingIds = await searchJobIds(
        filters.search,
        filters.searchScope ?? "all"
      );
      if (matchingIds !== null) {
        if (matchingIds.length === 0) {
          // No search results — short-circuit to empty response
          return cacheResult({
            data: [],
            total: 0,
            hasNextPage: false,
            page: filters.page ?? 1,
            pageSize: PAGE_SIZE,
            summary: await summaryPromise,
          });
        }
        searchMatchTotalHint = matchingIds.length;
        where.id = { in: matchingIds };
      }
    }

    appendScopedTextSearchWhere(where, "title", filters.titleSearch);
    appendScopedTextSearchWhere(where, "company", filters.companySearch);
    appendLocationSearchWhere(where, filters.locationSearch);

    if (filters.location) {
      appendLocationSearchWhere(where, filters.location);
    }

    if (filters.region) {
      const regions = parseEnumCsv(filters.region, VALID_REGION_VALUES);
      if (regions) {
        where.region = { in: regions as ("US" | "CA")[] };
      }
    }

    if (filters.workMode) {
      const modes = parseEnumCsv(filters.workMode, VALID_WORK_MODE_VALUES);
      if (modes) {
        appendAndCondition(where, {
          workMode: {
            in: modes as ("REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE")[],
          },
          workModeConfidence: { gte: METADATA_FIELD_FILTER_CONFIDENCE_THRESHOLD },
        });
      }
    }

    if (filters.employmentType) {
      const employmentTypeGroups = withoutUnknownFilterValues(
        splitFilterValues(normalizeEmploymentTypeGroupFilterValue(filters.employmentType)),
        "UNKNOWN"
      );
      appendAndCondition(where, {
        employmentTypeGroup:
          employmentTypeGroups.length > 0 ? { in: employmentTypeGroups } : { in: [] },
        employmentTypeConfidence: { gte: METADATA_FIELD_FILTER_CONFIDENCE_THRESHOLD },
      });
    }

    if (filters.industry) {
      const industries = withoutUnknownFilterValues(
        splitFilterValues(normalizeIndustryFilterValue(filters.industry)),
        "UNKNOWN"
      );
      appendAndCondition(where, {
        OR:
          industries.length > 0
            ? [
                { normalizedIndustries: { hasSome: industries } },
                { normalizedIndustry: { in: industries } },
              ]
            : [{ normalizedIndustry: { in: [] } }],
        normalizedIndustryConfidence: { gte: INDUSTRY_FILTER_CONFIDENCE_THRESHOLD },
      });
    }

    if (filters.roleCategory) {
      const selectedRoleCategories = splitFilterValues(
        expandNormalizedRoleCategoryFilterValue(filters.roleCategory)
      );
      const roleCategories = withoutUnknownFilterValues(selectedRoleCategories, "OTHER_UNKNOWN");
      const roleConditions: Prisma.JobCanonicalWhereInput[] = [];
      if (roleCategories.length > 0) {
        roleConditions.push({
          normalizedRoleCategory: { in: roleCategories },
          normalizedRoleCategoryConfidence: { gte: ROLE_CATEGORY_FILTER_CONFIDENCE_THRESHOLD },
          classificationStatus: { in: [...FILTERABLE_CLASSIFICATION_STATUSES] },
        });
      }
      if (selectedRoleCategories.includes("OTHER_UNKNOWN")) {
        roleConditions.push({ normalizedRoleCategory: "OTHER_UNKNOWN" });
      }
      appendAndCondition(
        where,
        roleConditions.length === 0
          ? { normalizedRoleCategory: { in: [] } }
          : roleConditions.length === 1
            ? roleConditions[0]
            : { OR: roleConditions }
      );
    }

    if (filters.roleFamily) {
      const families = filters.roleFamily.split(",").map((f) => f.trim()).filter(Boolean);
      if (families.length === 1) {
        where.roleFamily = { contains: families[0], mode: "insensitive" };
      } else if (families.length > 1) {
        where.roleFamily = { in: families };
      }
    }

    if (filters.source) {
      appendAndCondition(where, {
        sourceMappings: {
          some: {
            removedAt: null,
            sourceName: { contains: filters.source, mode: "insensitive" },
          },
        },
      });
    }

    const salaryRangeWhere = buildSalaryRangeWhere(
      filters.salaryMin,
      filters.salaryMax,
      filters.salaryCurrency ?? "USD",
      salaryExchangeRates,
      Boolean(filters.includeUnknownSalary)
    );
    if (salaryRangeWhere) {
      appendAndCondition(where, salaryRangeWhere);
    }

    const postedAfter = getPostedAfterDate(filters.posted);
    if (postedAfter) {
      appendAndCondition(where, { postedAt: { gte: postedAfter } });
    }

    if (filters.expiry === "soon") {
      const now = new Date();
      const soonDeadline = new Date(now.getTime() + 5 * 86_400_000);
      where.deadline = {
        gte: now,
        lte: soonDeadline,
      };
    }

    if (filters.careerStage || filters.experienceLevel) {
      const groups = splitFilterValues(
        normalizeExperienceLevelGroupFilterValue(filters.careerStage ?? filters.experienceLevel)
      );
      const knownGroups = withoutUnknownFilterValues(groups, "UNKNOWN");
      appendAndCondition(where, {
        experienceLevelGroup: knownGroups.length > 0 ? { in: knownGroups } : { in: [] },
        normalizedCareerStageConfidence: { gte: CAREER_STAGE_FILTER_CONFIDENCE_THRESHOLD },
      });
    }

    if (filters.submissionCategory) {
      const selectedCategories = filters.submissionCategory
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const expandedCategories = new Set<"READY_TO_APPLY" | "REVIEW_REQUIRED" | "MANUAL_ONLY">();

      for (const category of selectedCategories) {
        if (category === "READY_TO_APPLY") {
          expandedCategories.add("READY_TO_APPLY");
        } else if (category === "MANUAL_ONLY" || category === "REVIEW_REQUIRED") {
          expandedCategories.add("MANUAL_ONLY");
          expandedCategories.add("REVIEW_REQUIRED");
        }
      }

      const categoryList = [...expandedCategories];

      if (categoryList.length === 1) {
        where.eligibility = {
          submissionCategory: categoryList[0],
        };
      } else if (categoryList.length > 1) {
        where.eligibility = {
          submissionCategory: {
            in: categoryList,
          },
        };
      }
    }

    const requestedStatus = normalizeJobStatusFilter(filters.status);
    if (hasNonDefaultJobStatusFilter(filters.status)) {
      where.status = requestedStatus ?? { in: [] };
    } else {
      where.status = {
        in: hasAnySearch
          ? [...DEFAULT_SEARCH_VISIBLE_JOB_STATUSES]
          : [...DEFAULT_VISIBLE_JOB_STATUSES],
      };
    }
    appendAndCondition(
      where,
      buildDefaultJobBoardVisibilityWhere(
        new Date(),
        hasAnySearch
          ? DEFAULT_SEARCH_MIN_AVAILABILITY_SCORE
          : DEFAULT_MIN_AVAILABILITY_SCORE
      )
    );

    if (!filters.sortBy || filters.sortBy === "relevance") {
      if (useFeedIndexForRequest) {
        return cacheResult(
          await getJobsFromFeedIndex({
            filters,
            viewerProfileId,
            authUserId,
            salaryExchangeRates,
            summaryPromise,
            includeExactTotal,
            useSqlDemoVisibilityFilter,
          }),
          "feed-index"
        );
      }
      const [result, summary] = await Promise.all([
        getJobsByRelevance(
          filters,
          where,
          viewerProfileId,
          authUserId,
          includeExactTotal,
          useSqlDemoVisibilityFilter,
          searchMatchTotalHint
        ),
        summaryPromise,
      ]);
      return cacheResult({ ...result, summary }, "canonical-relevance");
    }

    if (useFeedIndexForRequest) {
      return cacheResult(
        await getJobsFromFeedIndex({
          filters,
          viewerProfileId,
          authUserId,
          salaryExchangeRates,
          summaryPromise,
          includeExactTotal,
          useSqlDemoVisibilityFilter,
        }),
        "feed-index"
      );
    }

    const orderBy = buildCanonicalFeedOrderBy(filters.sortBy);

    const jobs = await prisma.jobCanonical.findMany({
      where,
      select: JOB_FEED_CARD_SELECT(viewerProfileId, authUserId),
      orderBy,
      skip,
      take: PAGE_SIZE * 3,
    });

    const visibleJobs = jobs.filter((job) =>
      isClearlyVisibleJobPosting({
        title: job.title,
        description: job.shortSummary,
        applyUrl: job.applyUrl,
      })
    );
    const data = visibleJobs.slice(0, PAGE_SIZE).map((job) => {
      const { savedJobs, trackedApplications, ...rest } = job;
      return withSanitizedJobFeedPresentation({
        ...rest,
        isSaved: savedJobs.length > 0,
        hasApplied: trackedApplications.length > 0,
      });
    });

    if (!includeExactTotal) {
      return cacheResult({
        data,
        total: null,
        hasNextPage: visibleJobs.length > PAGE_SIZE,
        page,
        pageSize: PAGE_SIZE,
        summary: await summaryPromise,
      });
    }

    const total = await prisma.jobCanonical.count({ where });

    const effectiveTotal = total ?? searchMatchTotalHint;
    return cacheResult({
      data,
      total: effectiveTotal,
      hasNextPage:
        effectiveTotal !== null ? skip + PAGE_SIZE < effectiveTotal : data.length === PAGE_SIZE,
      page,
      pageSize: PAGE_SIZE,
      summary: await summaryPromise,
    });
  })();

  inflightJobsQueryStore.set(cacheKey, request);

  try {
    return await request;
  } finally {
    if (inflightJobsQueryStore.get(cacheKey) === request) {
      inflightJobsQueryStore.delete(cacheKey);
    }
  }
}

export async function getJobById(id: string) {
  const viewerProfileId = await getOptionalCurrentProfileId();
  const authUserId = await getOptionalCurrentAuthUserId();
  const now = new Date();
  const job = await prisma.jobCanonical.findFirst({
    where: {
      id,
      AND: [buildDefaultJobBoardVisibilityWhere(now, DEFAULT_MIN_AVAILABILITY_SCORE)],
    },
    include: JOB_CARD_INCLUDE(viewerProfileId, authUserId),
  });

  if (!job) return null;
  if (
    job.feedIndex?.status !== "LIVE" ||
    hasBadApplyLinkValidationStatus(job.applyUrlValidationStatus)
  ) {
    return null;
  }
  if (
    !isClearlyVisibleJobPosting({
      title: job.title,
      description: job.description,
      applyUrl: job.applyUrl,
    })
  ) {
    return null;
  }

  const { savedJobs, trackedApplications, ...rest } = job;
  return withSanitizedJobPresentation({
    ...rest,
    isSaved: savedJobs.length > 0,
    hasApplied: trackedApplications.length > 0,
  });
}
