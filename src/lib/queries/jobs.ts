import { prisma } from "@/lib/db";
import { DEMO_USER_ID, PAGE_SIZE } from "@/lib/constants";
import type { Prisma } from "@/generated/prisma/client";
import { DEMO_SOURCE_NAMES } from "@/lib/job-links";

// ─── Full-text search ────────────────────────────────────────────────────────

/**
 * Convert a user search string into a PostgreSQL tsquery.
 * Splits on whitespace, strips non-alphanumeric chars, joins with &.
 * Each token is suffixed with :* for prefix matching ("eng" → "eng:*").
 */
function toTsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}:*`).join(" & ");
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

async function loadFeedPrefs(): Promise<FeedPrefs> {
  const rows = await prisma.userPreference.findMany({
    where: { userId: DEMO_USER_ID },
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
async function loadBehaviorProfile(): Promise<BehaviorProfile> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000);

  const signals = await prisma.userBehaviorSignal.findMany({
    where: {
      userId: DEMO_USER_ID,
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
  workMode: string | null;
  roleFamily: string | null;
  company: string | null;
  eligibility: { submissionCategory: string } | null;
  sourceMappings: { sourceName: string }[];
};

/**
 * Score a job for relevance ranking with full breakdown.
 *
 * Scoring bands:
 *   Eligibility:          0–20  (auto-submit > review > manual)
 *   Freshness:          -16–20  (graduated by age, more strongly demotes very old jobs)
 *   Preference match:     0–15  (explicit user role-family prefs)
 *   Work mode pref:       0–10  (explicit user work-mode prefs)
 *   Behavior – role:      0–8   (saved/applied role families)
 *   Behavior – company:   0–6   (saved/applied companies)
 *   Behavior – suppress: -6–0   (repeatedly passed role families)
 *   Source trust:          0–5   (structured ATS sources)
 *   Multi-source:          0–3   (confirmed across ≥2 sources)
 *   ─────────────────────────────
 *   Range:              -16–87
 */
export function scoreJobDetailed(
  job: ScoringJobInput,
  prefs: FeedPrefs,
  behavior: BehaviorProfile
): ScoreBreakdown {
  let eligibility = 0;
  let freshness = 0;
  let prefRoleFamily = 0;
  let prefWorkMode = 0;
  let behaviorRoleFamily = 0;
  let behaviorCompany = 0;
  let behaviorSuppression = 0;
  let sourceTrust = 0;

  // Eligibility (0-20)
  const cat = job.eligibility?.submissionCategory;
  if (cat === "AUTO_SUBMIT_READY") eligibility = 20;
  else if (cat === "AUTO_FILL_REVIEW") eligibility = 10;

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
  if (job.sourceMappings.some((sm) => ATS_SOURCE_RE.test(sm.sourceName))) {
    sourceTrust = 5;
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
      prefRoleFamily +
      prefWorkMode +
      behaviorRoleFamily +
      behaviorCompany +
      behaviorSuppression +
      sourceTrust +
      multiSource,
    eligibility,
    freshness,
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

function diversifyRankedJobs(candidates: RankedFeedCandidate[]) {
  const remaining = [...candidates];
  const selected: RankedFeedCandidate[] = [];
  const companyCounts = new Map<string, number>();
  const companyTitleCounts = new Map<string, number>();
  const sourceFamilyCounts = new Map<string, number>();

  while (remaining.length > 0) {
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
 * The SCORING_WINDOW_SIZE caps how many jobs we load for ranking. This means
 * pages deep into the feed use DB-level newest-first ordering rather than
 * full relevance scoring — an acceptable tradeoff for performance.
 */
const SCORING_WINDOW_SIZE = 2000;

async function getJobsByRelevance(
  filters: JobFilterParams,
  where: Prisma.JobCanonicalWhereInput
) {
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;

  // If the user is requesting a deep page beyond the scoring window,
  // fall back to simple newest-first ordering (fast DB query).
  if (skip >= SCORING_WINDOW_SIZE) {
    const [jobs, total] = await Promise.all([
      prisma.jobCanonical.findMany({
        where,
        include: {
          eligibility: true,
          sourceMappings: true,
          savedJobs: {
            where: { userId: DEMO_USER_ID, status: "ACTIVE" },
            select: { id: true },
          },
        },
        orderBy: { postedAt: "desc" },
        skip,
        take: PAGE_SIZE,
      }),
      prisma.jobCanonical.count({ where }),
    ]);
    const data = jobs.map((job) => {
      const { savedJobs, ...rest } = job;
      return { ...rest, isSaved: savedJobs.length > 0 };
    });
    return { data, total, page, pageSize: PAGE_SIZE };
  }

  const [prefs, behavior, scoringJobs, total] = await Promise.all([
    loadFeedPrefs(),
    loadBehaviorProfile(),
    prisma.jobCanonical.findMany({
      where,
      select: {
        id: true,
        title: true,
        postedAt: true,
        workMode: true,
        roleFamily: true,
        company: true,
        eligibility: { select: { submissionCategory: true } },
        sourceMappings: {
          where: { removedAt: null },
          select: { sourceName: true },
        },
      },
      orderBy: { postedAt: "desc" },
      take: SCORING_WINDOW_SIZE,
    }),
    prisma.jobCanonical.count({ where }),
  ]);

  // Score → diversify → paginate in memory.
  const sorted = diversifyRankedJobs(
    scoringJobs
      .map((job) => ({
        id: job.id,
        title: job.title,
        company: job.company,
        postedAt: job.postedAt,
        sourceMappings: job.sourceMappings,
        baseScore: scoreJob(job, prefs, behavior),
      }))
      .sort(
        (a, b) =>
          b.baseScore - a.baseScore ||
          (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0)
      )
  );

  const pageIds = sorted.slice(skip, skip + PAGE_SIZE).map((job) => job.id);

  if (pageIds.length === 0) {
    return { data: [], total, page, pageSize: PAGE_SIZE };
  }

  // Fetch full data for this page only
  const jobs = await prisma.jobCanonical.findMany({
    where: { id: { in: pageIds } },
    include: {
      eligibility: true,
      sourceMappings: true,
      savedJobs: {
        where: { userId: DEMO_USER_ID, status: "ACTIVE" },
        select: { id: true },
      },
    },
  });

  // Restore relevance order (Prisma doesn't preserve id-in ordering)
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const data = pageIds.flatMap((id) => {
    const job = jobMap.get(id);
    if (!job) return [];
    const { savedJobs, ...rest } = job;
    return [{ ...rest, isSaved: savedJobs.length > 0 }];
  });

  return { data, total, page, pageSize: PAGE_SIZE };
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

export async function getJobs(filters: JobFilterParams) {
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;

  const where: Prisma.JobCanonicalWhereInput = {
    behaviorSignals: {
      none: {
        userId: DEMO_USER_ID,
        action: "PASS",
      },
    },
    sourceMappings: {
      some: {
        sourceName: {
          notIn: [...DEMO_SOURCE_NAMES],
        },
      },
    },
  };

  if (filters.search) {
    const matchingIds = await searchJobIds(filters.search);
    if (matchingIds !== null) {
      if (matchingIds.length === 0) {
        // No search results — short-circuit to empty response
        return { data: [], total: 0, page: filters.page ?? 1, pageSize: PAGE_SIZE };
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
    const levels = filters.experienceLevel.split(",");
    where.experienceLevel = {
      in: levels as ("ENTRY" | "MID" | "SENIOR" | "LEAD" | "EXECUTIVE")[],
    };
  }

  if (filters.submissionCategory) {
    where.eligibility = {
      submissionCategory: filters.submissionCategory as
        | "AUTO_SUBMIT_READY"
        | "AUTO_FILL_REVIEW"
        | "MANUAL_ONLY",
    };
  }

  if (filters.status) {
    where.status = filters.status as
      | "LIVE"
      | "EXPIRED"
      | "REMOVED"
      | "STALE";
  } else {
    // Default: only show live jobs
    where.status = "LIVE";
  }

  // Relevance sort: score-based ranking with user preference signals
  if (!filters.sortBy || filters.sortBy === "relevance") {
    return getJobsByRelevance(filters, where);
  }

  // Explicit sorts: salary or newest
  let orderBy: Prisma.JobCanonicalOrderByWithRelationInput = {
    postedAt: "desc",
  };
  if (filters.sortBy === "salary") {
    orderBy = { salaryMax: "desc" };
  }

  const [jobs, total] = await Promise.all([
    prisma.jobCanonical.findMany({
      where,
      include: {
        eligibility: true,
        sourceMappings: true,
        savedJobs: {
          where: { userId: DEMO_USER_ID, status: "ACTIVE" },
          select: { id: true },
        },
      },
      orderBy,
      skip,
      take: PAGE_SIZE,
    }),
    prisma.jobCanonical.count({ where }),
  ]);

  // Transform to add isSaved flag
  const data = jobs.map((job) => {
    const { savedJobs, ...rest } = job;
    return {
      ...rest,
      isSaved: savedJobs.length > 0,
    };
  });

  return { data, total, page, pageSize: PAGE_SIZE };
}

export async function getJobById(id: string) {
  const job = await prisma.jobCanonical.findUnique({
    where: { id },
    include: {
      eligibility: true,
      sourceMappings: true,
      savedJobs: {
        where: { userId: DEMO_USER_ID, status: "ACTIVE" },
        select: { id: true },
      },
    },
  });

  if (!job) return null;

  const { savedJobs, ...rest } = job;
  return {
    ...rest,
    isSaved: savedJobs.length > 0,
  };
}

export async function getFeedStats() {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneWeekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const visibleLiveWhere: Prisma.JobCanonicalWhereInput = {
    status: "LIVE",
    sourceMappings: {
      some: {
        sourceName: {
          notIn: [...DEMO_SOURCE_NAMES],
        },
      },
    },
  };
  const withheldLiveWhere: Prisma.JobCanonicalWhereInput = {
    status: "LIVE",
    sourceMappings: {
      none: {
        sourceName: {
          notIn: [...DEMO_SOURCE_NAMES],
        },
      },
    },
  };

  const [
    totalLive,
    newLast24h,
    expiredCount,
    autoEligibleCount,
    reviewRequiredCount,
    manualOnlyCount,
    savedCount,
    savedEndingSoonCount,
    withheldCount,
  ] = await Promise.all([
    prisma.jobCanonical.count({ where: visibleLiveWhere }),
    prisma.jobCanonical.count({
      where: {
        ...visibleLiveWhere,
        postedAt: { gte: oneDayAgo },
      },
    }),
    prisma.jobCanonical.count({ where: { status: "EXPIRED" } }),
    prisma.jobCanonical.count({
      where: {
        ...visibleLiveWhere,
        eligibility: { submissionCategory: "AUTO_SUBMIT_READY" },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        ...visibleLiveWhere,
        eligibility: { submissionCategory: "AUTO_FILL_REVIEW" },
      },
    }),
    prisma.jobCanonical.count({
      where: {
        ...visibleLiveWhere,
        eligibility: { submissionCategory: "MANUAL_ONLY" },
      },
    }),
    prisma.savedJob.count({
      where: { userId: DEMO_USER_ID, status: "ACTIVE" },
    }),
    prisma.savedJob.count({
      where: {
        userId: DEMO_USER_ID,
        status: "ACTIVE",
        canonicalJob: {
          status: "LIVE",
          deadline: {
            gte: now,
            lte: oneWeekOut,
          },
        },
      },
    }),
    prisma.jobCanonical.count({ where: withheldLiveWhere }),
  ]);

  return {
    totalLive,
    newLast24h,
    expiredCount,
    autoEligibleCount,
    reviewRequiredCount,
    manualOnlyCount,
    savedCount,
    savedEndingSoonCount,
    withheldCount,
  };
}
