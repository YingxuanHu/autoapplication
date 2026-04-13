import { prisma } from "@/lib/db";
import { PAGE_SIZE } from "@/lib/constants";
import type { Prisma } from "@/generated/prisma/client";
import { DEMO_SOURCE_NAMES } from "@/lib/job-links";
import { getOptionalCurrentProfileId } from "@/lib/current-user";
import { getIngestionHeartbeat } from "@/lib/queries/ingestion";
import {
  CAREER_STAGE_DEFINITIONS,
  normalizeCareerStageFilterValue,
  type CareerStageFilter,
} from "@/lib/career-stage";

// ─── Full-text search ────────────────────────────────────────────────────────

/**
 * Convert a user search string into a PostgreSQL tsquery.
 * Splits on whitespace, strips non-alphanumeric chars, joins with &.
 * Each token is suffixed with :* for prefix matching ("eng" → "eng:*").
 */
const MAX_SEARCH_LENGTH = 200;
const MAX_SEARCH_TOKENS = 12;
const NO_VIEWER_PROFILE_ID = "__viewer_none__";
const DEFAULT_VISIBLE_JOB_STATUSES = ["LIVE", "AGING"] as const;
const DEFAULT_SEARCH_VISIBLE_JOB_STATUSES = ["LIVE", "AGING", "STALE"] as const;
const DEFAULT_MIN_AVAILABILITY_SCORE = 35;
const DEFAULT_SEARCH_MIN_AVAILABILITY_SCORE = 20;
const JOB_FEED_SUMMARY_TTL_MS = 60_000;
const JOB_FEED_QUERY_TTL_MS = 15_000;
const HOT_FEED_QUERY_TTL_MS = 120_000;
const TIMED_CACHE_MAX_ENTRIES = 64;
const DIVERSIFICATION_OVERSCAN = 80;
const DEMO_SOURCE_NAME_SET = new Set<string>(DEMO_SOURCE_NAMES);
const timedCacheStore = new Map<string, { expiresAt: number; value: unknown }>();
const inflightJobsQueryStore = new Map<string, Promise<JobsResult>>();
const JOB_CARD_INCLUDE = (viewerProfileId: string | null) =>
  ({
    eligibility: true,
    sourceMappings: true,
    savedJobs: {
      where: {
        userId: viewerProfileId ?? NO_VIEWER_PROFILE_ID,
        status: "ACTIVE",
      },
      select: { id: true },
    },
  }) satisfies Prisma.JobCanonicalInclude;

function buildAvailabilityVisibilityWhere(minScore: number): Prisma.JobCanonicalWhereInput {
  return {
    OR: [
      { availabilityScore: { gte: minScore } },
      {
        AND: [
          { availabilityScore: { lte: 0 } },
          { lastApplyCheckAt: null },
          { lastConfirmedAliveAt: null },
          { deadSignalAt: null },
        ],
      },
    ],
  };
}

function toTsQuery(raw: string): string {
  const tokens = raw
    .slice(0, MAX_SEARCH_LENGTH)
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((t) => t.length > 0)
    .slice(0, MAX_SEARCH_TOKENS);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}:*`).join(" & ");
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function splitFilterValues(value?: string) {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function addLikeClauses(
  field: "title" | "description" | "roleFamily",
  keywords: string[],
  params: string[]
) {
  const clauses: string[] = [];

  for (const keyword of keywords) {
    params.push(`%${escapeLikePattern(keyword)}%`);
    clauses.push(`"${field}" ILIKE $${params.length} ESCAPE '\\'`);
  }

  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : null;
}

function addEqualityClauses(
  field: "employmentType",
  values: string[],
  params: string[]
) {
  const clauses: string[] = [];

  for (const value of values) {
    params.push(value);
    clauses.push(`"${field}" = $${params.length}`);
  }

  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : null;
}

function buildPositiveCareerStageSql(
  stage: CareerStageFilter,
  params: string[]
) {
  const definition = CAREER_STAGE_DEFINITIONS[stage];
  const clauses = [
    definition.employmentTypes
      ? addEqualityClauses("employmentType", definition.employmentTypes, params)
      : null,
    definition.roleFamilyKeywords
      ? addLikeClauses("roleFamily", definition.roleFamilyKeywords, params)
      : null,
    addLikeClauses("title", definition.titleKeywords, params),
    addLikeClauses("description", definition.descriptionKeywords, params),
  ].filter(Boolean);

  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : null;
}

function buildCareerStageSql(stage: CareerStageFilter, params: string[]) {
  const internshipSql = buildPositiveCareerStageSql("INTERNSHIP", params);
  const administrativeSql = buildPositiveCareerStageSql(
    "ADMINISTRATIVE_SUPPORT",
    params
  );
  const seniorSql = buildPositiveCareerStageSql("SENIOR_LEVEL", params);
  const associateSql = buildPositiveCareerStageSql("ASSOCIATE", params);
  const entrySql = buildPositiveCareerStageSql("ENTRY_LEVEL", params);

  switch (stage) {
    case "INTERNSHIP":
      return internshipSql;
    case "ADMINISTRATIVE_SUPPORT":
      return administrativeSql;
    case "SENIOR_LEVEL":
      return seniorSql && internshipSql && administrativeSql
        ? `(${seniorSql} AND NOT ${internshipSql} AND NOT ${administrativeSql})`
        : seniorSql;
    case "ASSOCIATE":
      return associateSql && internshipSql && administrativeSql && seniorSql
        ? `(${associateSql} AND NOT ${internshipSql} AND NOT ${administrativeSql} AND NOT ${seniorSql})`
        : associateSql;
    case "ENTRY_LEVEL":
      return entrySql && internshipSql && administrativeSql && seniorSql && associateSql
        ? `(${entrySql} AND NOT ${internshipSql} AND NOT ${administrativeSql} AND NOT ${seniorSql} AND NOT ${associateSql})`
        : entrySql;
  }
}

async function searchCareerStageJobIds(stages: CareerStageFilter[]) {
  if (stages.length === 0) return null;

  const params: string[] = [];
  const stageClauses = stages
    .map((stage) => buildCareerStageSql(stage, params))
    .filter(Boolean) as string[];

  if (stageClauses.length === 0) {
    return null;
  }

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "JobCanonical" WHERE ${stageClauses.join(" OR ")}`,
    ...params
  );

  return rows.map((row) => row.id);
}

function mergeMatchingIds(
  current: Prisma.JobCanonicalWhereInput["id"],
  nextIds: string[]
) {
  if (
    !current ||
    typeof current !== "object" ||
    !("in" in current) ||
    !Array.isArray(current.in)
  ) {
    return { in: nextIds };
  }

  const allowedIds = new Set(nextIds);
  return {
    in: current.in.filter((id): id is string => typeof id === "string" && allowedIds.has(id)),
  };
}

/**
 * Search for matching job IDs using PostgreSQL full-text search.
 *
 * Strategy:
 *  1. Try tsvector full-text search first (fast, uses GIN index).
 *  2. If no results or query is very short (≤2 chars), fall back to
 *     trigram similarity on title and company (uses GIN trigram indexes).
 *
 * Returns up to `limit` matching job IDs, ordered by relevance.
 */
async function searchJobIds(
  query: string,
  limit: number = 5000
): Promise<string[] | null> {
  const tsQuery = toTsQuery(query);
  if (!tsQuery) return null;

  // Try full-text search first
  const ftsResults = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "JobCanonical"
     WHERE "searchVector" @@ to_tsquery('english', $1)
     ORDER BY ts_rank("searchVector", to_tsquery('english', $1)) DESC
     LIMIT $2`,
    tsQuery,
    limit
  );

  if (ftsResults.length > 0) {
    return ftsResults.map((r) => r.id);
  }

  // Fallback: trigram similarity for short queries or terms not in the
  // English dictionary (acronyms, company names, etc.)
  const likePattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const trigramResults = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "JobCanonical"
     WHERE title ILIKE $1
        OR company ILIKE $1
        OR "roleFamily" ILIKE $1
     LIMIT $2`,
    likePattern,
    limit
  );

  return trigramResults.length > 0
    ? trigramResults.map((r) => r.id)
    : [];
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

type FeedPrefs = {
  roleFamilies: string[]; // e.g. ["SWE", "Data Analyst"]
  workModes: string[]; // e.g. ["REMOTE", "HYBRID"]
};

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

const ATS_SOURCE_RE = /^(Ashby|Greenhouse|Lever|Recruitee|Rippling|SmartRecruiters|SuccessFactors|Workday):/;

// ─── Detailed scoring (used by feed ranking + debug view) ────────────────────

export type ScoreBreakdown = {
  total: number;
  eligibility: number;
  freshness: number;
  availability: number;
  prefRoleFamily: number;
  prefWorkMode: number;
  behaviorRoleFamily: number;
  behaviorCompany: number;
  behaviorSuppression: number;
  sourceTrust: number;
  multiSource: number;
};

export type ScoringJobInput = {
  postedAt: Date | null;
  status: string | null;
  availabilityScore: number;
  workMode: string | null;
  roleFamily: string | null;
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
 *   Eligibility:          0–20  (auto-submit only; everything else is manual)
 *   Freshness:          -16–20  (graduated by age, more strongly demotes very old jobs)
 *   Availability:       -14–18  (health/lifecycle confidence)
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
  behavior: BehaviorProfile
): ScoreBreakdown {
  let eligibility = 0;
  let freshness = 0;
  let availability = 0;
  let prefRoleFamily = 0;
  let prefWorkMode = 0;
  let behaviorRoleFamily = 0;
  let behaviorCompany = 0;
  let behaviorSuppression = 0;
  let sourceTrust = 0;

  // Eligibility (0-20)
  const cat = job.eligibility?.submissionCategory;
  if (cat === "AUTO_SUBMIT_READY") eligibility = 20;

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
    prefRoleFamily,
    prefWorkMode,
    behaviorRoleFamily,
    behaviorCompany,
    behaviorSuppression,
    sourceTrust,
    multiSource,
  };
}

/** Thin wrapper returning just the total score — used by the feed query. */
function scoreJob(
  job: ScoringJobInput,
  prefs: FeedPrefs,
  behavior: BehaviorProfile
): number {
  return scoreJobDetailed(job, prefs, behavior).total;
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

async function getHiddenDemoOnlySummaryCounts(startOfToday: Date): Promise<JobFeedSummary> {
  // A job is "demo-only" if every source mapping belongs to a demo source.
  // Expressed as: has at least one demo mapping AND has no non-demo mappings.
  const demoOnlyWhere: Prisma.JobCanonicalWhereInput = {
    sourceMappings: {
      some: { sourceName: { in: [...DEMO_SOURCE_NAMES] } },
      none: { sourceName: { notIn: [...DEMO_SOURCE_NAMES] } },
    },
  };

  const [liveJobCount, addedTodayCount, expiredTodayCount, removedTodayCount] =
    await Promise.all([
      prisma.jobCanonical.count({
        where: { ...demoOnlyWhere, status: { in: [...DEFAULT_VISIBLE_JOB_STATUSES] } },
      }),
      prisma.jobCanonical.count({
        where: {
          ...demoOnlyWhere,
          status: { in: [...DEFAULT_VISIBLE_JOB_STATUSES] },
          firstSeenAt: { gte: startOfToday },
        },
      }),
      prisma.jobCanonical.count({
        where: { ...demoOnlyWhere, status: "EXPIRED", expiredAt: { gte: startOfToday } },
      }),
      prisma.jobCanonical.count({
        where: { ...demoOnlyWhere, status: "REMOVED", removedAt: { gte: startOfToday } },
      }),
    ]);

  return { liveJobCount, addedTodayCount, expiredTodayCount, removedTodayCount };
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
  cacheEpoch: string | null = null
) {
  return `jobs:${viewerProfileId ?? "anon"}:${JSON.stringify({
    search: filters.search ?? null,
    region: filters.region ?? null,
    workMode: filters.workMode ?? null,
    industry: filters.industry ?? null,
    roleFamily: filters.roleFamily ?? null,
    salaryMin: filters.salaryMin ?? null,
    experienceLevel: filters.experienceLevel ?? null,
    submissionCategory: filters.submissionCategory ?? null,
    status: filters.status ?? null,
    sortBy: filters.sortBy ?? null,
    page: filters.page ?? 1,
    cacheEpoch,
  })}`;
}

function isHotDefaultFeedRequest(filters: JobFilterParams) {
  return !(
    filters.search ||
    filters.region ||
    filters.workMode ||
    filters.industry ||
    filters.roleFamily ||
    filters.salaryMin ||
    filters.experienceLevel ||
    filters.submissionCategory ||
    filters.status
  ) &&
    (!filters.sortBy || filters.sortBy === "relevance") &&
    (filters.page ?? 1) === 1;
}

async function getJobFeedSummary() {
  const cached = readTimedCache<JobFeedSummary>("jobs:summary");
  if (cached) return cached;

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const [liveJobCount, addedTodayCount, expiredTodayCount, removedTodayCount, hiddenDemoCounts] =
    await Promise.all([
    prisma.jobCanonical.count({
      where: {
        status: { in: [...DEFAULT_VISIBLE_JOB_STATUSES] },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        status: { in: [...DEFAULT_VISIBLE_JOB_STATUSES] },
        firstSeenAt: { gte: startOfToday },
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
    getHiddenDemoOnlySummaryCounts(startOfToday),
  ]);

  return writeTimedCache("jobs:summary", {
    liveJobCount: Math.max(0, liveJobCount - hiddenDemoCounts.liveJobCount),
    addedTodayCount: Math.max(0, addedTodayCount - hiddenDemoCounts.addedTodayCount),
    expiredTodayCount: Math.max(0, expiredTodayCount - hiddenDemoCounts.expiredTodayCount),
    removedTodayCount: Math.max(0, removedTodayCount - hiddenDemoCounts.removedTodayCount),
  } satisfies JobFeedSummary, JOB_FEED_SUMMARY_TTL_MS);
}

async function getJobsByRelevance(
  filters: JobFilterParams,
  where: Prisma.JobCanonicalWhereInput,
  viewerProfileId: string | null,
  includeExactTotal: boolean,
  useSqlDemoVisibilityFilter: boolean
) {
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;
  const scoringWindowSize = filters.search ? SEARCH_SCORING_WINDOW_SIZE : DEFAULT_SCORING_WINDOW_SIZE;

  // If the user is requesting a deep page beyond the scoring window,
  // fall back to simple newest-first ordering (fast DB query).
  if (skip >= scoringWindowSize) {
    const jobs = await prisma.jobCanonical.findMany({
      where,
      include: JOB_CARD_INCLUDE(viewerProfileId),
      orderBy: { postedAt: "desc" },
      skip,
      take: PAGE_SIZE + 1,
    });
    const slicedJobs = jobs.slice(0, PAGE_SIZE);
    const data = slicedJobs.map((job) => {
      const { savedJobs, ...rest } = job;
      return { ...rest, isSaved: savedJobs.length > 0 };
    });

    if (!includeExactTotal) {
      return {
        data,
        total: null,
        hasNextPage: jobs.length > PAGE_SIZE,
        page,
        pageSize: PAGE_SIZE,
      };
    }

    const total = await prisma.jobCanonical.count({ where });
    return {
      data,
      total,
      hasNextPage: skip + PAGE_SIZE < total,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  const scoringJobsPromise = prisma.jobCanonical.findMany({
    where,
    select: {
      id: true,
      title: true,
      postedAt: true,
      status: true,
      availabilityScore: true,
      workMode: true,
      roleFamily: true,
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
    orderBy: { postedAt: "desc" },
    take: scoringWindowSize,
  });

  const totalPromise = includeExactTotal ? prisma.jobCanonical.count({ where }) : Promise.resolve(null);

  const [prefs, behavior, scoringJobs, total] = await Promise.all([
    loadFeedPrefs(viewerProfileId),
    loadBehaviorProfile(viewerProfileId),
    scoringJobsPromise,
    totalPromise,
  ]);

  const visibleScoringJobs = useSqlDemoVisibilityFilter
    ? scoringJobs
    : scoringJobs.filter((job) => !isDemoOnlySourceMappings(job.sourceMappings));
  const diversifiedSelectionLimit = Math.min(
    visibleScoringJobs.length,
    skip + PAGE_SIZE + DIVERSIFICATION_OVERSCAN
  );

  // Score → diversify → paginate in memory.
  const sorted = diversifyRankedJobs(
    visibleScoringJobs
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
        baseScore: scoreJob(
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
          prefs,
          behavior
        ),
      }))
      .sort(
        (a, b) =>
          b.baseScore - a.baseScore ||
          (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0)
      ),
    diversifiedSelectionLimit
  );

  const pageIds = sorted.slice(skip, skip + PAGE_SIZE).map((job) => job.id);
  const hasNextPage =
    total !== null ? skip + PAGE_SIZE < total : sorted.length > skip + PAGE_SIZE;

  if (pageIds.length === 0) {
    return { data: [], total, hasNextPage: false, page, pageSize: PAGE_SIZE };
  }

  // Fetch full data for this page only
  const jobs = await prisma.jobCanonical.findMany({
    where: { id: { in: pageIds } },
    include: JOB_CARD_INCLUDE(viewerProfileId),
  });

  // Restore relevance order (Prisma doesn't preserve id-in ordering)
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const data = pageIds.flatMap((id) => {
    const job = jobMap.get(id);
    if (!job) return [];
    const { savedJobs, ...rest } = job;
    return [{ ...rest, isSaved: savedJobs.length > 0 }];
  });

  return { data, total, hasNextPage, page, pageSize: PAGE_SIZE };
}

export type JobFilterParams = {
  search?: string;
  region?: string;
  workMode?: string;
  industry?: string;
  roleFamily?: string;
  salaryMin?: number;
  experienceLevel?: string;
  submissionCategory?: string;
  status?: string;
  sortBy?: string;
  page?: number;
};

export async function getJobs(
  filters: JobFilterParams,
  options?: { viewerProfileId?: string | null }
) {
  const viewerProfileId =
    options && "viewerProfileId" in options
      ? (options.viewerProfileId ?? null)
      : await getOptionalCurrentProfileId();
  const useHotFeedSnapshot = isHotDefaultFeedRequest(filters);
  const heartbeat = useHotFeedSnapshot ? await getIngestionHeartbeat() : null;
  const cacheKey = buildJobsCacheKey(
    viewerProfileId,
    filters,
    useHotFeedSnapshot ? (heartbeat?.lastUpdatedAt ?? "none") : null
  );
  const cached = readTimedCache<JobsResult>(cacheKey);
  if (cached) return cached;
  const inflight = inflightJobsQueryStore.get(cacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    const page = filters.page ?? 1;
    const skip = (page - 1) * PAGE_SIZE;
    const summaryPromise = getJobFeedSummary();
    const includeExactTotal = Boolean(
      filters.search ||
        filters.region ||
        filters.workMode ||
        filters.industry ||
        filters.roleFamily ||
        filters.salaryMin ||
        filters.experienceLevel ||
        filters.submissionCategory ||
        filters.status
    );
    const isExplicitSort = Boolean(filters.sortBy && filters.sortBy !== "relevance");
    const defaultScoringWindowPages = Math.floor(DEFAULT_SCORING_WINDOW_SIZE / PAGE_SIZE);
    const useSqlDemoVisibilityFilter =
      includeExactTotal || isExplicitSort || page > defaultScoringWindowPages;
    const cacheResult = (result: JobsResult) =>
      writeTimedCache(
        cacheKey,
        result,
        useHotFeedSnapshot ? HOT_FEED_QUERY_TTL_MS : JOB_FEED_QUERY_TTL_MS
      );

    const where: Prisma.JobCanonicalWhereInput = {};

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

    if (filters.search) {
      const matchingIds = await searchJobIds(filters.search);
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
        where.id = { in: matchingIds };
      }
    }

    if (filters.region) {
      const regions = filters.region.split(",");
      where.region = { in: regions as ("US" | "CA")[] };
    }

    if (filters.workMode) {
      const modes = filters.workMode.split(",");
      where.workMode = {
        in: modes as ("REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE")[],
      };
    }

    if (filters.industry) {
      const industries = filters.industry.split(",");
      where.industry = { in: industries as ("TECH" | "FINANCE")[] };
    }

    if (filters.roleFamily) {
      const families = filters.roleFamily.split(",").map((f) => f.trim()).filter(Boolean);
      if (families.length === 1) {
        where.roleFamily = { contains: families[0], mode: "insensitive" };
      } else if (families.length > 1) {
        where.roleFamily = { in: families };
      }
    }

    if (filters.salaryMin) {
      where.salaryMax = { gte: filters.salaryMin };
    }

    if (filters.experienceLevel) {
      const stages = splitFilterValues(normalizeCareerStageFilterValue(filters.experienceLevel));
      const matchingIds = await searchCareerStageJobIds(stages as CareerStageFilter[]);

      if (matchingIds !== null) {
        if (matchingIds.length === 0) {
          return cacheResult({
            data: [],
            total: 0,
            hasNextPage: false,
            page: filters.page ?? 1,
            pageSize: PAGE_SIZE,
            summary: await summaryPromise,
          });
        }

        where.id = mergeMatchingIds(where.id, matchingIds);

        if ("in" in where.id && Array.isArray(where.id.in) && where.id.in.length === 0) {
          return cacheResult({
            data: [],
            total: 0,
            hasNextPage: false,
            page: filters.page ?? 1,
            pageSize: PAGE_SIZE,
            summary: await summaryPromise,
          });
        }
      }
    }

    if (filters.submissionCategory) {
      const selectedCategories = filters.submissionCategory
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const expandedCategories = new Set<"AUTO_SUBMIT_READY" | "AUTO_FILL_REVIEW" | "MANUAL_ONLY">();

      for (const category of selectedCategories) {
        if (category === "AUTO_SUBMIT_READY") {
          expandedCategories.add("AUTO_SUBMIT_READY");
        } else if (category === "MANUAL_ONLY" || category === "AUTO_FILL_REVIEW") {
          expandedCategories.add("MANUAL_ONLY");
          expandedCategories.add("AUTO_FILL_REVIEW");
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

    if (filters.status) {
      where.status = filters.status as
        | "AGING"
        | "LIVE"
        | "EXPIRED"
        | "REMOVED"
        | "STALE";
    } else {
      where.status = {
        in: filters.search
          ? [...DEFAULT_SEARCH_VISIBLE_JOB_STATUSES]
          : [...DEFAULT_VISIBLE_JOB_STATUSES],
      };
      where.AND = [
        buildAvailabilityVisibilityWhere(
          filters.search
            ? DEFAULT_SEARCH_MIN_AVAILABILITY_SCORE
            : DEFAULT_MIN_AVAILABILITY_SCORE
        ),
      ];
    }

    if (!filters.sortBy || filters.sortBy === "relevance") {
      const [result, summary] = await Promise.all([
        getJobsByRelevance(
          filters,
          where,
          viewerProfileId,
          includeExactTotal,
          useSqlDemoVisibilityFilter
        ),
        summaryPromise,
      ]);
      return cacheResult({ ...result, summary });
    }

    let orderBy: Prisma.JobCanonicalOrderByWithRelationInput = {
      postedAt: "desc",
    };
    if (filters.sortBy === "salary") {
      orderBy = { salaryMax: "desc" };
    }

    const jobs = await prisma.jobCanonical.findMany({
      where,
      include: JOB_CARD_INCLUDE(viewerProfileId),
      orderBy,
      skip,
      take: PAGE_SIZE + 1,
    });

    const data = jobs.slice(0, PAGE_SIZE).map((job) => {
      const { savedJobs, ...rest } = job;
      return {
        ...rest,
        isSaved: savedJobs.length > 0,
      };
    });

    if (!includeExactTotal) {
      return cacheResult({
        data,
        total: null,
        hasNextPage: jobs.length > PAGE_SIZE,
        page,
        pageSize: PAGE_SIZE,
        summary: await summaryPromise,
      });
    }

    const total = await prisma.jobCanonical.count({ where });

    return cacheResult({
      data,
      total,
      hasNextPage: skip + PAGE_SIZE < total,
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
  const job = await prisma.jobCanonical.findUnique({
    where: { id },
    include: JOB_CARD_INCLUDE(viewerProfileId),
  });

  if (!job) return null;

  const { savedJobs, ...rest } = job;
  return {
    ...rest,
    isSaved: savedJobs.length > 0,
  };
}
