import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  normalizeUrlIdentityKey,
  type SourceIdentitySnapshot,
} from "@/lib/ingestion/source-quality";
import type { NormalizedJobInput } from "@/lib/ingestion/types";
import type { Prisma, Region, WorkMode } from "@/generated/prisma/client";

const TITLE_CORE_STOP_WORDS = new Set([
  "senior",
  "sr",
  "sr.",
  "junior",
  "jr",
  "jr.",
  "staff",
  "principal",
  "ii",
  "iii",
  "iv",
  "intern",
]);

const DESCRIPTION_FINGERPRINT_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "you",
  "your",
  "our",
  "are",
  "will",
  "that",
  "this",
  "from",
  "have",
  "has",
  "about",
  "job",
  "team",
  "role",
  "work",
  "experience",
  "years",
  "skills",
  "ability",
]);

type DedupeFields = Pick<
  NormalizedJobInput,
  | "companyKey"
  | "titleKey"
  | "titleCoreKey"
  | "descriptionFingerprint"
  | "locationKey"
  | "applyUrlKey"
  | "duplicateClusterId"
>;

export type CanonicalMatchCandidate = {
  id: string;
  applyUrl: string;
  description: string;
  shortSummary: string;
  postedAt: Date;
  deadline: Date | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  companyKey: string;
  titleKey: string;
  titleCoreKey: string;
  descriptionFingerprint: string;
  locationKey: string;
  applyUrlKey: string | null;
  roleFamily: string;
  workMode: WorkMode;
};

export type CanonicalMatchEvidence = {
  exactField?: "applyUrlKey" | "sourceUrlKey" | "postingIdKey";
  exactKey?: string;
  duplicateClusterId?: string;
  titleExact?: boolean;
  titleCoreExact?: boolean;
  descriptionFingerprintExact?: boolean;
  locationExact?: boolean;
  roleFamilyExact?: boolean;
  workModeExact?: boolean;
  sharedTitleTokenCount?: number;
  sharedDescriptionTokenCount?: number;
  snippetOverlapCount?: number;
  daysApart?: number;
};

export type CanonicalMatchResult = {
  matchedBy:
    | "rawJob"
    | "applyUrlKey"
    | "sourceUrlKey"
    | "postingIdKey"
    | "duplicateCluster"
    | "similarity";
  canonical: CanonicalMatchCandidate;
  score: number;
  evidence: CanonicalMatchEvidence;
};

export function isCanonicalMatchCompatible(
  normalizedJob: NormalizedJobInput,
  candidate: CanonicalMatchCandidate
) {
  if (
    normalizedJob.applyUrlKey &&
    candidate.applyUrlKey &&
    normalizedJob.applyUrlKey === candidate.applyUrlKey
  ) {
    return true;
  }

  if (
    normalizedJob.companyKey !== UNKNOWN_COMPANY_KEY &&
    normalizedJob.companyKey === candidate.companyKey &&
    normalizedJob.titleCoreKey === candidate.titleCoreKey &&
    normalizedJob.locationKey === candidate.locationKey
  ) {
    return true;
  }

  return scoreCanonicalMatch(normalizedJob, candidate).score > 0;
}

export function buildCanonicalDedupeFields(input: {
  company: string;
  title: string;
  description: string;
  location: string;
  region: Region | null;
  applyUrl: string;
}): DedupeFields {
  const companyKey = normalizeEntityKey(input.company);
  const titleKey = normalizeEntityKey(input.title);
  const titleCoreKey = normalizeTitleCoreKey(input.title);
  const descriptionFingerprint = normalizeDescriptionFingerprint(input.description);
  const locationKey = normalizeLocationKey(input.location);
  const applyUrlKey = normalizeApplyUrlKey(input.applyUrl);

  return {
    companyKey,
    titleKey,
    titleCoreKey,
    descriptionFingerprint,
    locationKey,
    applyUrlKey,
    duplicateClusterId: hashDuplicateCluster([
      companyKey,
      titleCoreKey,
      locationKey,
      (input.region ?? "unknown").toLowerCase(),
    ]),
  };
}

export async function backfillCanonicalDedupeFields() {
  const jobsToBackfill = await prisma.jobCanonical.findMany({
    where: {
      OR: [
        { companyKey: "" },
        { titleKey: "" },
        { titleCoreKey: "" },
        { descriptionFingerprint: "" },
        { locationKey: "" },
      ],
    },
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      location: true,
      region: true,
      applyUrl: true,
    },
  });

  for (const job of jobsToBackfill) {
    const dedupeFields = buildCanonicalDedupeFields({
      company: job.company,
      title: job.title,
      description: job.description,
      location: job.location,
      region: job.region,
      applyUrl: job.applyUrl,
    });

    await prisma.jobCanonical.update({
      where: { id: job.id },
      data: dedupeFields,
    });
  }
}

export async function findCrossSourceCanonicalMatch(
  normalizedJob: NormalizedJobInput,
  sourceIdentity: SourceIdentitySnapshot
): Promise<CanonicalMatchResult | null> {
  const exactKeyMatches = [
    { field: "applyUrlKey", key: sourceIdentity.applyUrlKey },
    { field: "sourceUrlKey", key: sourceIdentity.sourceUrlKey },
    { field: "postingIdKey", key: sourceIdentity.postingIdKey },
  ] as const;

  for (const exactMatch of exactKeyMatches) {
    if (!exactMatch.key) continue;

    const mappingMatch = await findMappingCanonicalMatch(exactMatch.field, exactMatch.key);
    if (mappingMatch) {
      return {
        matchedBy: exactMatch.field,
        canonical: mappingMatch,
        score: 100,
        evidence: {
          exactField: exactMatch.field,
          exactKey: exactMatch.key,
        },
      };
    }

    if (exactMatch.field === "applyUrlKey") {
      const canonicalApplyUrlMatch = await prisma.jobCanonical.findFirst({
        where: { applyUrlKey: exactMatch.key },
        select: canonicalMatchSelect,
      });

      if (canonicalApplyUrlMatch) {
        return {
          matchedBy: "applyUrlKey",
          canonical: canonicalApplyUrlMatch,
          score: 100,
          evidence: {
            exactField: "applyUrlKey",
            exactKey: exactMatch.key,
          },
        };
      }
    }
  }

  if (normalizedJob.companyKey !== UNKNOWN_COMPANY_KEY) {
    const exactClusterMatch = await prisma.jobCanonical.findFirst({
      where: { duplicateClusterId: normalizedJob.duplicateClusterId },
      select: canonicalMatchSelect,
    });

    if (exactClusterMatch) {
      return {
        matchedBy: "duplicateCluster",
        canonical: exactClusterMatch,
        score: 95,
        evidence: {
          duplicateClusterId: normalizedJob.duplicateClusterId,
        },
      };
    }
  }

  if (normalizedJob.companyKey === UNKNOWN_COMPANY_KEY) {
    return null;
  }

  const candidates = await prisma.jobCanonical.findMany({
    where: {
      companyKey: normalizedJob.companyKey,
      AND: [
        {
          OR: [
            { titleCoreKey: normalizedJob.titleCoreKey },
            ...(normalizedJob.descriptionFingerprint
              ? [{ descriptionFingerprint: normalizedJob.descriptionFingerprint }]
              : []),
            ...(normalizedJob.locationKey
              ? [{ locationKey: normalizedJob.locationKey }]
              : []),
          ],
        },
        ...(normalizedJob.region
          ? [
              {
                OR: [{ region: normalizedJob.region }, { region: null }],
              } satisfies Prisma.JobCanonicalWhereInput,
            ]
          : []),
      ],
    },
    select: canonicalMatchSelect,
    take: 50,
  });

  let bestCandidate: CanonicalMatchResult | null = null;

  for (const candidate of candidates) {
    const scored = scoreCanonicalMatch(normalizedJob, candidate);
    if (scored.score < 45) continue;

    if (!bestCandidate || scored.score > bestCandidate.score) {
      bestCandidate = {
        matchedBy: "similarity",
        canonical: candidate,
        score: scored.score,
        evidence: scored.evidence,
      };
    }
  }

  return bestCandidate;
}

async function findMappingCanonicalMatch(
  field: "applyUrlKey" | "sourceUrlKey" | "postingIdKey",
  key: string
) {
  const mappingMatch = await prisma.jobSourceMapping.findFirst({
    where: {
      [field]: key,
    },
    orderBy: [
      { removedAt: "asc" },
      { isPrimary: "desc" },
      { sourceQualityRank: "desc" },
      { lastSeenAt: "desc" },
    ],
    select: {
      canonicalJob: {
        select: canonicalMatchSelect,
      },
    },
  });

  return mappingMatch?.canonicalJob ?? null;
}

function hashDuplicateCluster(parts: string[]) {
  return createHash("md5").update(parts.join(":")).digest("hex");
}

const canonicalMatchSelect = {
  id: true,
  applyUrl: true,
  description: true,
  shortSummary: true,
  postedAt: true,
  deadline: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  companyKey: true,
  titleKey: true,
  titleCoreKey: true,
  descriptionFingerprint: true,
  locationKey: true,
  applyUrlKey: true,
  roleFamily: true,
  workMode: true,
} as const;

const UNKNOWN_COMPANY_KEY = normalizeEntityKey("Unknown");

function scoreCanonicalMatch(
  normalizedJob: NormalizedJobInput,
  candidate: CanonicalMatchCandidate
) {
  const titleCoreExact = candidate.titleCoreKey === normalizedJob.titleCoreKey;
  const titleExact = candidate.titleKey === normalizedJob.titleKey;
  const descriptionFingerprintExact =
    Boolean(candidate.descriptionFingerprint) &&
    candidate.descriptionFingerprint === normalizedJob.descriptionFingerprint;
  const locationExact = candidate.locationKey === normalizedJob.locationKey;
  const roleFamilyExact = candidate.roleFamily === normalizedJob.roleFamily;
  const workModeExact = candidate.workMode === normalizedJob.workMode;
  const sharedTitleTokenCount = countSharedDelimitedTokens(
    candidate.titleCoreKey,
    normalizedJob.titleCoreKey
  );
  const sharedDescriptionTokenCount = countSharedDelimitedTokens(
    candidate.descriptionFingerprint,
    normalizedJob.descriptionFingerprint
  );
  const snippetOverlapCount = countSharedSnippetTokens(
    candidate.shortSummary || candidate.description,
    normalizedJob.shortSummary || normalizedJob.description
  );

  if (
    !titleCoreExact &&
    !titleExact &&
    !(sharedTitleTokenCount >= 2 && sharedDescriptionTokenCount >= 4) &&
    !(sharedTitleTokenCount >= 2 && snippetOverlapCount >= 4)
  ) {
    return {
      score: 0,
      evidence: {
        titleExact,
        titleCoreExact,
        sharedTitleTokenCount,
        sharedDescriptionTokenCount,
        snippetOverlapCount,
      },
    };
  }

  let score = 0;

  if (titleCoreExact) score += 30;
  if (titleExact) score += 16;
  if (descriptionFingerprintExact) score += 20;
  else score += Math.min(sharedDescriptionTokenCount * 2, 14);
  score += Math.min(sharedTitleTokenCount * 7, 21);
  score += Math.min(snippetOverlapCount * 2, 10);
  if (locationExact) score += 12;
  if (roleFamilyExact) score += 10;
  if (workModeExact) score += 3;

  const daysApart =
    Math.abs(candidate.postedAt.getTime() - normalizedJob.postedAt.getTime()) /
    (24 * 60 * 60 * 1000);

  if (daysApart <= 7) score += 10;
  else if (daysApart <= 21) score += 6;
  else if (daysApart <= 45) score += 3;

  return {
    score,
    evidence: {
      titleExact,
      titleCoreExact,
      descriptionFingerprintExact,
      locationExact,
      roleFamilyExact,
      workModeExact,
      sharedTitleTokenCount,
      sharedDescriptionTokenCount,
      snippetOverlapCount,
      daysApart: Math.round(daysApart * 10) / 10,
    } satisfies CanonicalMatchEvidence,
  };
}

function countSharedDelimitedTokens(leftValue: string, rightValue: string) {
  if (!leftValue || !rightValue) return 0;

  const leftTokens = new Set(leftValue.split("-").filter((token) => token.length >= 3));
  let sharedCount = 0;

  for (const token of rightValue.split("-")) {
    if (token.length < 3) continue;
    if (leftTokens.has(token)) sharedCount += 1;
  }

  return sharedCount;
}

function countSharedSnippetTokens(leftValue: string, rightValue: string) {
  const leftTokens = new Set(tokenizeSnippet(leftValue));
  if (leftTokens.size === 0) return 0;

  let sharedCount = 0;
  for (const token of tokenizeSnippet(rightValue)) {
    if (leftTokens.has(token)) sharedCount += 1;
  }

  return sharedCount;
}

function tokenizeSnippet(value: string) {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length >= 4)
    .filter((token) => !DESCRIPTION_FINGERPRINT_STOP_WORDS.has(token))
    .slice(0, 24);
}

export function normalizeEntityKey(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeTitleCoreKey(value: string) {
  const segments = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((segment) => !TITLE_CORE_STOP_WORDS.has(segment));

  return segments.join("-");
}

export function normalizeLocationKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(remote|hybrid|on-site|onsite|flexible)\b/g, " ")
    .replace(/[;/]+/g, ",")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9, -]+/g, " ")
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/\s+/g, "-"))
    .sort()
    .join("|");
}

export function normalizeDescriptionFingerprint(value: string) {
  const uniqueTokens = new Set<string>();
  const tokens = value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length >= 4)
    .filter((token) => !DESCRIPTION_FINGERPRINT_STOP_WORDS.has(token));

  for (const token of tokens) {
    uniqueTokens.add(token);
    if (uniqueTokens.size >= 24) break;
  }

  return [...uniqueTokens].join("-");
}

export function normalizeApplyUrlKey(value: string) {
  return normalizeUrlIdentityKey(value);
}
