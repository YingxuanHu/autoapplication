import { prisma } from "@/lib/db";
import { PAGE_SIZE } from "@/lib/constants";
import { Prisma, type Prisma as PrismaTypes } from "@/generated/prisma/client";
import { DEMO_SOURCE_NAMES } from "@/lib/job-links";
import {
  sanitizeCompanyName,
  sanitizeJobDescriptionText,
  sanitizeJobTitle,
} from "@/lib/job-cleanup";
import { isClearlyNonJobPosting } from "@/lib/job-integrity";
import { getOptionalCurrentProfileId } from "@/lib/current-user";
import { getIngestionHeartbeat } from "@/lib/queries/ingestion";
import { inferGeoScope } from "@/lib/geo-scope";
import {
  normalizeEducations,
  normalizeExperiences,
  normalizeSkills,
} from "@/lib/profile";
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
  }) satisfies PrismaTypes.JobCanonicalInclude;

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

function withSanitizedJobPresentation<
  T extends {
    title: string;
    company: string;
    description: string;
    location: string;
    applyUrl: string | null;
    shortSummary?: string | null;
  },
>(job: T): T {
  const title = sanitizeJobTitle(job.title);
  const company = sanitizeCompanyName(job.company, {
    urls: [job.applyUrl],
  });
  const description = sanitizeJobDescriptionText(job.description, {
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

function buildAvailabilityVisibilityWhere(minScore: number): PrismaTypes.JobCanonicalWhereInput {
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

function splitFilterValues(value?: string) {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function buildKeywordContainsClauses(
  field: "title" | "description" | "roleFamily",
  keywords: string[]
): PrismaTypes.JobCanonicalWhereInput[] {
  return keywords.map((keyword) => ({
    [field]: {
      contains: keyword,
      mode: "insensitive",
    },
  })) as PrismaTypes.JobCanonicalWhereInput[];
}

function buildPositiveCareerStageWhere(
  stage: CareerStageFilter
): PrismaTypes.JobCanonicalWhereInput | null {
  const definition = CAREER_STAGE_DEFINITIONS[stage];
  const clauses: PrismaTypes.JobCanonicalWhereInput[] = [];

  if (definition.employmentTypes?.length) {
    clauses.push({
      employmentType: {
        in: definition.employmentTypes,
      },
    });
  }

  if (definition.roleFamilyKeywords?.length) {
    clauses.push(...buildKeywordContainsClauses("roleFamily", definition.roleFamilyKeywords));
  }

  if (definition.titleKeywords.length) {
    clauses.push(...buildKeywordContainsClauses("title", definition.titleKeywords));
  }

  if (definition.descriptionKeywords.length) {
    clauses.push(...buildKeywordContainsClauses("description", definition.descriptionKeywords));
  }

  return clauses.length > 0 ? { OR: clauses } : null;
}

function buildCareerStageWhere(
  stage: CareerStageFilter
): PrismaTypes.JobCanonicalWhereInput | null {
  const internshipWhere = buildPositiveCareerStageWhere("INTERNSHIP");
  const administrativeWhere = buildPositiveCareerStageWhere("ADMINISTRATIVE_SUPPORT");
  const seniorWhere = buildPositiveCareerStageWhere("SENIOR_LEVEL");
  const associateWhere = buildPositiveCareerStageWhere("ASSOCIATE");
  const entryWhere = buildPositiveCareerStageWhere("ENTRY_LEVEL");

  switch (stage) {
    case "INTERNSHIP":
      return internshipWhere;
    case "ADMINISTRATIVE_SUPPORT":
      return administrativeWhere;
    case "SENIOR_LEVEL":
      return seniorWhere && internshipWhere && administrativeWhere
        ? {
            AND: [
              seniorWhere,
              { NOT: internshipWhere },
              { NOT: administrativeWhere },
            ],
          }
        : seniorWhere;
    case "ASSOCIATE":
      return associateWhere && internshipWhere && administrativeWhere && seniorWhere
        ? {
            AND: [
              associateWhere,
              { NOT: internshipWhere },
              { NOT: administrativeWhere },
              { NOT: seniorWhere },
            ],
          }
        : associateWhere;
    case "ENTRY_LEVEL":
      return entryWhere &&
        internshipWhere &&
        administrativeWhere &&
        seniorWhere &&
        associateWhere
        ? {
            AND: [
              entryWhere,
              { NOT: internshipWhere },
              { NOT: administrativeWhere },
              { NOT: seniorWhere },
              { NOT: associateWhere },
            ],
          }
        : entryWhere;
  }
}

function buildCareerStageFiltersWhere(
  stages: CareerStageFilter[]
): PrismaTypes.JobCanonicalWhereInput | null {
  if (stages.length === 0) return null;

  const stageClauses = stages
    .map((stage) => buildCareerStageWhere(stage))
    .filter(Boolean) as PrismaTypes.JobCanonicalWhereInput[];

  if (stageClauses.length === 0) {
    return null;
  }

  return stageClauses.length === 1 ? stageClauses[0] : { OR: stageClauses };
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

function shouldUseJobFeedIndex(filters: JobFilterParams) {
  return process.env.USE_JOB_FEED_INDEX === "1" && !filters.search;
}

async function getJobsFromFeedIndex(input: {
  filters: JobFilterParams;
  viewerProfileId: string | null;
  summaryPromise: Promise<JobFeedSummary>;
  includeExactTotal: boolean;
  useSqlDemoVisibilityFilter: boolean;
}) {
  const { filters, viewerProfileId, summaryPromise, includeExactTotal, useSqlDemoVisibilityFilter } =
    input;
  const page = filters.page ?? 1;
  const skip = (page - 1) * PAGE_SIZE;
  const where: Prisma.JobFeedIndexWhereInput = {};
  const canonicalRelationWhere: Prisma.JobCanonicalWhereInput = {};

  if (useSqlDemoVisibilityFilter) {
    canonicalRelationWhere.sourceMappings = {
      some: {
        sourceName: {
          notIn: [...DEMO_SOURCE_NAMES],
        },
      },
    };
  }

  if (viewerProfileId) {
    canonicalRelationWhere.behaviorSignals = {
      none: {
        userId: viewerProfileId,
        action: "PASS",
      },
    };
  }

  if (filters.region) {
    where.region = { in: filters.region.split(",") as ("US" | "CA")[] };
  }

  if (filters.workMode) {
    where.workMode = {
      in: filters.workMode.split(",") as ("REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE")[],
    };
  }

  if (filters.industry) {
    where.industry = { in: filters.industry.split(",") as ("TECH" | "FINANCE")[] };
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

  if (filters.expiry === "soon") {
    const now = new Date();
    const soonDeadline = new Date(now.getTime() + 5 * 86_400_000);
    where.deadline = {
      gte: now,
      lte: soonDeadline,
    };
  }

  if (filters.experienceLevel) {
    const stages = splitFilterValues(normalizeCareerStageFilterValue(filters.experienceLevel));
    const careerStageWhere = buildCareerStageFiltersWhere(stages as CareerStageFilter[]);

    if (careerStageWhere) {
      canonicalRelationWhere.AND = [
        ...(Array.isArray(canonicalRelationWhere.AND)
          ? canonicalRelationWhere.AND
          : canonicalRelationWhere.AND
            ? [canonicalRelationWhere.AND]
            : []),
        careerStageWhere,
      ];
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
      where.submissionCategory = categoryList[0];
    } else if (categoryList.length > 1) {
      where.submissionCategory = {
        in: categoryList,
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
      in: [...DEFAULT_VISIBLE_JOB_STATUSES],
    };
    appendAndCondition(
      canonicalRelationWhere,
      buildAvailabilityVisibilityWhere(DEFAULT_MIN_AVAILABILITY_SCORE)
    );
    appendAndCondition(canonicalRelationWhere, buildVisibleDeadlineWhere());
  }

  if (Object.keys(canonicalRelationWhere).length > 0) {
    where.canonicalJob = {
      is: canonicalRelationWhere,
    };
  }

  let orderBy:
    | Prisma.JobFeedIndexOrderByWithRelationInput
    | Prisma.JobFeedIndexOrderByWithRelationInput[] = [
    { rankingScore: "desc" },
    { postedAt: "desc" },
  ];

  if (filters.sortBy === "salary") {
    orderBy = { salaryMax: "desc" };
  } else if (filters.sortBy === "deadline") {
    orderBy = [
      { deadline: { sort: "asc", nulls: "last" } },
      { rankingScore: "desc" },
      { postedAt: "desc" },
    ];
  } else if (filters.sortBy === "recent") {
    orderBy = { postedAt: "desc" };
  }

  const indexedRows = await prisma.jobFeedIndex.findMany({
    where,
    select: { canonicalJobId: true },
    orderBy,
    skip,
    take: PAGE_SIZE * 3,
  });

  const canonicalJobIds = indexedRows.map((row) => row.canonicalJobId);

  if (canonicalJobIds.length === 0) {
    return {
      data: [],
      total: includeExactTotal ? 0 : null,
      hasNextPage: false,
      page,
      pageSize: PAGE_SIZE,
      summary: await summaryPromise,
    } satisfies JobsResult;
  }

  const jobs = await prisma.jobCanonical.findMany({
    where: { id: { in: canonicalJobIds } },
    include: JOB_CARD_INCLUDE(viewerProfileId),
  });
  const order = new Map(canonicalJobIds.map((id, index) => [id, index]));
  const visibleJobs = jobs
    .filter((job) =>
      isClearlyVisibleJobPosting({
        title: job.title,
        description: job.description,
        applyUrl: job.applyUrl,
      })
    )
    .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  const data = visibleJobs.slice(0, PAGE_SIZE).map((job) => {
    const { savedJobs, ...rest } = job;
    return withSanitizedJobPresentation({
      ...rest,
      isSaved: savedJobs.length > 0,
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

  const total = await prisma.jobFeedIndex.count({ where });

  return {
    data,
    total,
    hasNextPage: skip + PAGE_SIZE < total,
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

type ProfileMatchSignals = {
  location: string | null;
  locationRegion: "US" | "CA" | null;
  preferredWorkMode: string | null;
  experienceLevel: string | null;
  summaryPhrases: string[];
  summaryTokens: Set<string>;
  experiencePhrases: string[];
  experienceTokens: Set<string>;
  skillPhrases: string[];
  educationPhrases: string[];
};

const EMPTY_PROFILE_MATCH_SIGNALS: ProfileMatchSignals = {
  location: null,
  locationRegion: null,
  preferredWorkMode: null,
  experienceLevel: null,
  summaryPhrases: [],
  summaryTokens: new Set<string>(),
  experiencePhrases: [],
  experienceTokens: new Set<string>(),
  skillPhrases: [],
  educationPhrases: [],
};

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

function splitProfileTextEntries(value: string | null | undefined) {
  return String(value ?? "")
    .split(/[\n,;|•]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function dedupeNormalizedPhrases(values: string[]) {
  const phrases = new Set<string>();

  for (const value of values) {
    const normalized = normalizeProfileMatchText(value);
    if (normalized.length < 3 || normalized.length > 80) {
      continue;
    }
    phrases.add(normalized);
  }

  return [...phrases];
}

function inferProfileRegion(value: string | null | undefined): "US" | "CA" | null {
  const normalized = normalizeProfileMatchText(value ?? "");

  if (!normalized) {
    return null;
  }

  if (
    /\b(canada|ontario|toronto|vancouver|british columbia|alberta|quebec|montreal|calgary|ottawa)\b/.test(
      normalized
    )
  ) {
    return "CA";
  }

  if (
    /\b(usa|united states|us|new york|california|texas|washington|illinois|florida|massachusetts|remote us)\b/.test(
      normalized
    )
  ) {
    return "US";
  }

  return null;
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

function collectEducationProfileTerms(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const terms: string[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const objectValue = item as Record<string, unknown>;
    for (const field of ["field", "degree", "description"] as const) {
      const fieldValue = objectValue[field];
      if (typeof fieldValue === "string" && fieldValue.trim()) {
        terms.push(fieldValue);
      }
    }
  }

  return terms;
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

async function loadProfileMatchSignals(
  userProfileId?: string | null
): Promise<ProfileMatchSignals> {
  if (!userProfileId) {
    return EMPTY_PROFILE_MATCH_SIGNALS;
  }

  const profile = await prisma.userProfile.findUnique({
    where: { id: userProfileId },
    select: {
      location: true,
      headline: true,
      preferredWorkMode: true,
      experienceLevel: true,
      summary: true,
      skillsText: true,
      experienceText: true,
      educationText: true,
      skillsJson: true,
      experiencesJson: true,
      educationsJson: true,
    },
  });

  if (!profile) {
    return EMPTY_PROFILE_MATCH_SIGNALS;
  }

  const experiences = normalizeExperiences(profile.experiencesJson);
  const skills = normalizeSkills(profile.skillsJson);
  const educations = normalizeEducations(profile.educationsJson);
  const normalizedLocation = normalizeProfileMatchText(profile.location ?? "");

  const summaryInputs = [profile.summary ?? ""];

  const experienceInputs = [
    profile.headline ?? "",
    ...experiences.map((entry) => entry.title),
    ...splitProfileTextEntries(profile.experienceText),
  ];

  const skillInputs = [
    ...skills.map((entry) => entry.name),
    ...splitProfileTextEntries(profile.skillsText),
  ];

  const educationInputs = [
    ...educations.map((entry) => entry.degree),
    ...collectEducationProfileTerms(profile.educationsJson),
    ...splitProfileTextEntries(profile.educationText),
  ];

  return {
    location: normalizedLocation || null,
    locationRegion: inferProfileRegion(profile.location),
    preferredWorkMode: profile.preferredWorkMode,
    experienceLevel: profile.experienceLevel,
    summaryPhrases: dedupeNormalizedPhrases(summaryInputs),
    summaryTokens: extractProfileTokens(summaryInputs),
    experiencePhrases: dedupeNormalizedPhrases(experienceInputs),
    experienceTokens: extractProfileTokens(experienceInputs),
    skillPhrases: dedupeNormalizedPhrases(skillInputs),
    educationPhrases: dedupeNormalizedPhrases(educationInputs),
  };
}

function scoreProfileMatch(
  job: Pick<
    ScoringJobInput,
    "title" | "shortSummary" | "roleFamily" | "workMode" | "experienceLevel" | "location" | "region"
  >,
  profile: ProfileMatchSignals
) {
  if (
    profile === EMPTY_PROFILE_MATCH_SIGNALS ||
    (!profile.location &&
      !profile.experienceLevel &&
      !profile.preferredWorkMode &&
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

const ATS_SOURCE_RE = /^(Ashby|Greenhouse|Lever|Recruitee|Rippling|SmartRecruiters|SuccessFactors|Workday):/;

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
  region: string | null;
  workMode: string | null;
  roleFamily: string | null;
  experienceLevel: string | null;
  shortSummary?: string | null;
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
 *   Profile match:        0–28  (experience titles, skills, education, mode, level)
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

  const geoScope = inferGeoScope(job.location, job.region as "US" | "CA" | null);

  // Geography confidence: prefer jobs clearly in the product's NA footprint,
  // demote explicit out-of-scope geographies, and mildly penalize unknowns.
  if (geoScope === "US" || geoScope === "CA") regionConfidence = 6;
  else if (geoScope === "NORTH_AMERICA") regionConfidence = 3;
  else if (geoScope === "GLOBAL") regionConfidence = -6;
  else if (geoScope === "UNKNOWN") regionConfidence = -4;
  else regionConfidence = -14;

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

/** Thin wrapper returning just the total score — used by the feed query. */
function scoreJob(
  job: ScoringJobInput,
  prefs: FeedPrefs,
  behavior: BehaviorProfile,
  profile: ProfileMatchSignals = EMPTY_PROFILE_MATCH_SIGNALS
): number {
  return scoreJobDetailed(job, prefs, behavior, profile).total;
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

function isExplicitlyOutOfScopeGeoScope(
  scope: ReturnType<typeof inferGeoScope>
) {
  return (
    scope === "EUROPE" ||
    scope === "LATAM" ||
    scope === "APAC" ||
    scope === "MIDDLE_EAST_AFRICA"
  );
}

function buildVisibleDeadlineWhere(now: Date = new Date()): PrismaTypes.JobCanonicalWhereInput {
  return {
    OR: [
      { deadline: null },
      { deadline: { gte: now } },
    ],
  };
}

async function getHiddenDemoOnlySummaryCounts(
  startOfToday: Date,
  now: Date
): Promise<JobFeedSummary> {
  if (!DEMO_SOURCE_NAMES[0]) {
    return {
      liveJobCount: 0,
      addedTodayCount: 0,
      expiredTodayCount: 0,
      removedTodayCount: 0,
    };
  }

  // A job is "demo-only" if every source mapping belongs to a demo source.
  // Expressed as: has at least one demo mapping AND has no non-demo mappings.
  const demoSourceList = Prisma.join(
    DEMO_SOURCE_NAMES.map((sourceName) => Prisma.sql`${sourceName}`)
  );

  const [row] = await prisma.$queryRaw<
    Array<{
      liveJobCount: number;
      addedTodayCount: number;
      expiredTodayCount: number;
      removedTodayCount: number;
    }>
  >(Prisma.sql`
    SELECT
      COUNT(*) FILTER (
        WHERE jc.status IN ('LIVE', 'AGING')
          AND (jc."deadline" IS NULL OR jc."deadline" >= ${now})
      )::integer AS "liveJobCount",
      COUNT(*) FILTER (
        WHERE jc.status IN ('LIVE', 'AGING')
          AND jc."firstSeenAt" >= ${startOfToday}
          AND (jc."deadline" IS NULL OR jc."deadline" >= ${now})
      )::integer AS "addedTodayCount",
      COUNT(*) FILTER (
        WHERE jc.status = 'EXPIRED'
          AND jc."expiredAt" >= ${startOfToday}
      )::integer AS "expiredTodayCount",
      COUNT(*) FILTER (
        WHERE jc.status = 'REMOVED'
          AND jc."removedAt" >= ${startOfToday}
      )::integer AS "removedTodayCount"
    FROM "JobCanonical" jc
    WHERE EXISTS (
      SELECT 1
      FROM "JobSourceMapping" demo_map
      WHERE demo_map."canonicalJobId" = jc.id
        AND demo_map."sourceName" IN (${demoSourceList})
    )
      AND NOT EXISTS (
        SELECT 1
        FROM "JobSourceMapping" real_map
        WHERE real_map."canonicalJobId" = jc.id
          AND real_map."sourceName" NOT IN (${demoSourceList})
      )
  `);

  return {
    liveJobCount: row?.liveJobCount ?? 0,
    addedTodayCount: row?.addedTodayCount ?? 0,
    expiredTodayCount: row?.expiredTodayCount ?? 0,
    removedTodayCount: row?.removedTodayCount ?? 0,
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
    expiry: filters.expiry ?? null,
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
    filters.expiry ||
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
  const [summaryRow] = await prisma.$queryRaw<
    Array<{
      liveJobCount: number;
      addedTodayCount: number;
      expiredTodayCount: number;
      removedTodayCount: number;
    }>
  >(Prisma.sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status IN ('LIVE', 'AGING')
          AND ("deadline" IS NULL OR "deadline" >= ${now})
      )::integer AS "liveJobCount",
      COUNT(*) FILTER (
        WHERE status IN ('LIVE', 'AGING')
          AND "firstSeenAt" >= ${startOfToday}
          AND ("deadline" IS NULL OR "deadline" >= ${now})
      )::integer AS "addedTodayCount",
      COUNT(*) FILTER (
        WHERE status = 'EXPIRED'
          AND "expiredAt" >= ${startOfToday}
      )::integer AS "expiredTodayCount",
      COUNT(*) FILTER (
        WHERE status = 'REMOVED'
          AND "removedAt" >= ${startOfToday}
      )::integer AS "removedTodayCount"
    FROM "JobCanonical"
  `);
  const hiddenDemoCounts = await getHiddenDemoOnlySummaryCounts(startOfToday, now);
  const liveJobCount = summaryRow?.liveJobCount ?? 0;
  const addedTodayCount = summaryRow?.addedTodayCount ?? 0;
  const expiredTodayCount = summaryRow?.expiredTodayCount ?? 0;
  const removedTodayCount = summaryRow?.removedTodayCount ?? 0;

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
      take: PAGE_SIZE * 3,
    });
    const visibleJobs = jobs.filter((job) =>
      isClearlyVisibleJobPosting({
        title: job.title,
        description: job.description,
        applyUrl: job.applyUrl,
      })
    );
    const slicedJobs = visibleJobs.slice(0, PAGE_SIZE);
    const data = slicedJobs.map((job) => {
      const { savedJobs, ...rest } = job;
      return withSanitizedJobPresentation({
        ...rest,
        isSaved: savedJobs.length > 0,
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
      location: true,
      postedAt: true,
      status: true,
      availabilityScore: true,
      region: true,
      workMode: true,
      roleFamily: true,
      experienceLevel: true,
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
    orderBy: { postedAt: "desc" },
    take: scoringWindowSize,
  });

  const totalPromise = includeExactTotal ? prisma.jobCanonical.count({ where }) : Promise.resolve(null);

  const [prefs, behavior, profile, scoringJobs, total] = await Promise.all([
    loadFeedPrefs(viewerProfileId),
    loadBehaviorProfile(viewerProfileId),
    loadProfileMatchSignals(viewerProfileId),
    scoringJobsPromise,
    totalPromise,
  ]);

  const visibleScoringJobs = useSqlDemoVisibilityFilter
    ? scoringJobs
    : scoringJobs.filter(
        (job) =>
          !isDemoOnlySourceMappings(job.sourceMappings) &&
          !isExplicitlyOutOfScopeGeoScope(inferGeoScope(job.location, job.region))
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
          behavior,
          profile
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
    if (
      !isClearlyVisibleJobPosting({
        title: job.title,
        description: job.description,
        applyUrl: job.applyUrl,
      })
    ) {
      return [];
    }
    const { savedJobs, ...rest } = job;
    return [
      withSanitizedJobPresentation({
        ...rest,
        isSaved: savedJobs.length > 0,
      }),
    ];
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
  expiry?: string;
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
      filters.expiry ||
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

    if (filters.expiry === "soon") {
      const now = new Date();
      const soonDeadline = new Date(now.getTime() + 5 * 86_400_000);
      where.deadline = {
        gte: now,
        lte: soonDeadline,
      };
    }

    if (filters.experienceLevel) {
      const stages = splitFilterValues(normalizeCareerStageFilterValue(filters.experienceLevel));
      const careerStageWhere = buildCareerStageFiltersWhere(stages as CareerStageFilter[]);

      if (careerStageWhere) {
        appendAndCondition(where, careerStageWhere);
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
      appendAndCondition(
        where,
        buildAvailabilityVisibilityWhere(
          filters.search
            ? DEFAULT_SEARCH_MIN_AVAILABILITY_SCORE
            : DEFAULT_MIN_AVAILABILITY_SCORE
        )
      );
      appendAndCondition(where, buildVisibleDeadlineWhere());
    }

    if (!filters.sortBy || filters.sortBy === "relevance") {
      if (shouldUseJobFeedIndex(filters)) {
        return cacheResult(
          await getJobsFromFeedIndex({
            filters,
            viewerProfileId,
            summaryPromise,
            includeExactTotal,
            useSqlDemoVisibilityFilter,
          })
        );
      }
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

    if (shouldUseJobFeedIndex(filters)) {
      return cacheResult(
        await getJobsFromFeedIndex({
          filters,
          viewerProfileId,
          summaryPromise,
          includeExactTotal,
          useSqlDemoVisibilityFilter,
        })
      );
    }

    let orderBy:
      | Prisma.JobCanonicalOrderByWithRelationInput
      | Prisma.JobCanonicalOrderByWithRelationInput[] = {
      postedAt: "desc",
    };
    if (filters.sortBy === "salary") {
      orderBy = { salaryMax: "desc" };
    } else if (filters.sortBy === "deadline") {
      orderBy = [
        { deadline: { sort: "asc", nulls: "last" } },
        { postedAt: "desc" },
      ];
    }

    const jobs = await prisma.jobCanonical.findMany({
      where,
      include: JOB_CARD_INCLUDE(viewerProfileId),
      orderBy,
      skip,
      take: PAGE_SIZE * 3,
    });

    const visibleJobs = jobs.filter((job) =>
      isClearlyVisibleJobPosting({
        title: job.title,
        description: job.description,
        applyUrl: job.applyUrl,
      })
    );
    const data = visibleJobs.slice(0, PAGE_SIZE).map((job) => {
      const { savedJobs, ...rest } = job;
      return withSanitizedJobPresentation({
        ...rest,
        isSaved: savedJobs.length > 0,
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
  if (
    !isClearlyVisibleJobPosting({
      title: job.title,
      description: job.description,
      applyUrl: job.applyUrl,
    })
  ) {
    return null;
  }

  const { savedJobs, ...rest } = job;
  return withSanitizedJobPresentation({
    ...rest,
    isSaved: savedJobs.length > 0,
  });
}
