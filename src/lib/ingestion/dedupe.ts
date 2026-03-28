import { prisma } from "@/lib/db";
import type { NormalizedJobInput } from "@/lib/ingestion/types";
import type { Region, WorkMode } from "@/generated/prisma/client";

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

export type CanonicalMatchResult = {
  matchedBy: "applyUrlKey" | "duplicateCluster" | "similarity";
  canonical: CanonicalMatchCandidate;
  score: number;
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
    normalizedJob.companyKey === candidate.companyKey &&
    normalizedJob.titleKey === candidate.titleKey &&
    normalizedJob.locationKey === candidate.locationKey
  ) {
    return true;
  }

  return scoreCanonicalMatch(normalizedJob, candidate) > 0;
}

export function buildCanonicalDedupeFields(input: {
  company: string;
  title: string;
  description: string;
  location: string;
  region: Region;
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
    duplicateClusterId: [
      companyKey,
      titleKey,
      locationKey,
      input.region.toLowerCase(),
    ].join(":"),
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
  normalizedJob: NormalizedJobInput
): Promise<CanonicalMatchResult | null> {
  if (normalizedJob.applyUrlKey) {
    const applyUrlMatch = await prisma.jobCanonical.findFirst({
      where: { applyUrlKey: normalizedJob.applyUrlKey },
      select: canonicalMatchSelect,
    });

    if (applyUrlMatch) {
      return {
        matchedBy: "applyUrlKey",
        canonical: applyUrlMatch,
        score: 100,
      };
    }
  }

  const exactClusterMatch = await prisma.jobCanonical.findFirst({
    where: { duplicateClusterId: normalizedJob.duplicateClusterId },
    select: canonicalMatchSelect,
  });

  if (exactClusterMatch) {
    return {
      matchedBy: "duplicateCluster",
      canonical: exactClusterMatch,
      score: 95,
    };
  }

  const candidates = await prisma.jobCanonical.findMany({
    where: {
      companyKey: normalizedJob.companyKey,
      region: normalizedJob.region,
      OR: [
        { titleCoreKey: normalizedJob.titleCoreKey },
        { descriptionFingerprint: normalizedJob.descriptionFingerprint },
        { roleFamily: normalizedJob.roleFamily },
        { locationKey: normalizedJob.locationKey },
      ],
    },
    select: canonicalMatchSelect,
    take: 25,
  });

  let bestCandidate: CanonicalMatchResult | null = null;

  for (const candidate of candidates) {
    const score = scoreCanonicalMatch(normalizedJob, candidate);
    if (score < 45) continue;

    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {
        matchedBy: "similarity",
        canonical: candidate,
        score,
      };
    }
  }

  return bestCandidate;
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

function scoreCanonicalMatch(
  normalizedJob: NormalizedJobInput,
  candidate: CanonicalMatchCandidate
) {
  const exactTitleMatch =
    candidate.titleCoreKey === normalizedJob.titleCoreKey ||
    candidate.titleKey === normalizedJob.titleKey;
  const descriptionFingerprintMatch =
    Boolean(candidate.descriptionFingerprint) &&
    candidate.descriptionFingerprint === normalizedJob.descriptionFingerprint;
  const sharedTitleTokenCount = countSharedTitleTokens(
    candidate.titleCoreKey,
    normalizedJob.titleCoreKey
  );

  // Similarity matching should only collapse jobs that share a real title shape.
  // This prevents same-company/same-location boards with boilerplate descriptions
  // from merging unrelated roles like data engineering, design, and research.
  if (
    !exactTitleMatch &&
    !(
      descriptionFingerprintMatch &&
      candidate.roleFamily === normalizedJob.roleFamily &&
      sharedTitleTokenCount >= 2
    )
  ) {
    return 0;
  }

  let score = 0;

  if (candidate.titleCoreKey === normalizedJob.titleCoreKey) score += 30;
  if (candidate.titleKey === normalizedJob.titleKey) score += 18;
  if (descriptionFingerprintMatch) {
    score += 24;
  }
  if (candidate.locationKey === normalizedJob.locationKey) score += 14;
  if (candidate.roleFamily === normalizedJob.roleFamily) score += 12;
  if (candidate.workMode === normalizedJob.workMode) score += 4;

  const daysApart = Math.abs(
    candidate.postedAt.getTime() - normalizedJob.postedAt.getTime()
  ) /
    (24 * 60 * 60 * 1000);

  if (daysApart <= 7) score += 12;
  else if (daysApart <= 21) score += 8;
  else if (daysApart <= 45) score += 4;

  return score;
}

function countSharedTitleTokens(candidateTitleCoreKey: string, normalizedTitleCoreKey: string) {
  const candidateTokens = new Set(
    candidateTitleCoreKey.split("-").filter((token) => token.length >= 3)
  );
  let sharedCount = 0;

  for (const token of normalizedTitleCoreKey.split("-")) {
    if (token.length < 3) continue;
    if (candidateTokens.has(token)) sharedCount += 1;
  }

  return sharedCount;
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
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}
