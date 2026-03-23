import type { NormalizedJob, WorkMode, JobSource } from "@/types/index";
import type { SourceType } from "@/generated/prisma";

/**
 * Source trust weights used for deduplication preference.
 */
const SOURCE_TRUST_ORDER: Record<string, number> = {
  CAREER_PAGE: 0.9,
  ATS_BOARD: 0.85,
  STRUCTURED_DATA: 0.8,
  AGGREGATOR: 0.4,
};

/**
 * Level indicators stripped during fuzzy title normalization.
 */
const TITLE_LEVEL_PATTERNS =
  /\b(sr\.?|senior|jr\.?|junior|lead|principal|staff|i{1,3}|iv|v|1|2|3|4|5|entry[- ]?level|mid[- ]?level|associate)\b/gi;

/**
 * Company name suffixes stripped during fuzzy normalization.
 */
const COMPANY_SUFFIX_PATTERNS =
  /\b(inc\.?|corp\.?|corporation|ltd\.?|limited|llc|llp|plc|gmbh|co\.?|company|group|holdings|international|technologies|technology|tech|solutions|services|consulting)\b\.?/gi;

export interface RawJobData {
  externalId?: string;
  title: string;
  company: string;
  companyLogo?: string;
  location?: string;
  workMode?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salary?: string;
  description: string;
  summary?: string;
  url: string;
  applyUrl?: string;
  postedAt?: string | Date;
  skills?: string[];
  jobType?: string;
}

/**
 * Result from finding duplicates, including the matched job and confidence score.
 */
export interface DuplicateMatch {
  /** The existing job that matches. */
  job: NormalizedJob;
  /** Confidence score between 0 and 1. */
  confidence: number;
  /** The method used to detect the duplicate. */
  method: "externalId" | "applyUrl" | "fingerprint" | "fuzzy";
}

/**
 * Record of a merge decision for debugging and audit trail.
 */
export interface MergeRecord {
  /** The job that was kept (winner). */
  keptJob: { externalId: string; source: JobSource };
  /** The job that was merged away (loser). */
  mergedJob: { externalId: string; source: JobSource };
  /** Confidence of the duplicate match. */
  confidence: number;
  /** Method used to detect the duplicate. */
  method: DuplicateMatch["method"];
  /** Timestamp of the merge decision. */
  mergedAt: Date;
}

/**
 * Result of deduplication including the deduplicated jobs and merge history.
 */
export interface DeduplicationResult {
  /** Deduplicated list of jobs. */
  jobs: NormalizedJob[];
  /** History of all merge decisions made during deduplication. */
  mergeHistory: MergeRecord[];
}

/**
 * Normalize a raw job from any source into the NormalizedJob format.
 */
export function normalizeJob(
  raw: RawJobData,
  source: JobSource,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sourceType?: SourceType,
): NormalizedJob {
  const location = normalizeLocation(raw.location || "");
  const workMode = normalizeWorkMode(raw.workMode || raw.location || "");

  let salaryMin = raw.salaryMin ?? null;
  let salaryMax = raw.salaryMax ?? null;
  let salaryCurrency = raw.salaryCurrency ?? null;

  // Try to extract salary from text if not provided as numbers
  if (salaryMin == null && salaryMax == null && raw.salary) {
    const extracted = normalizeSalary(raw.salary);
    salaryMin = extracted.min;
    salaryMax = extracted.max;
    salaryCurrency = extracted.currency || salaryCurrency;
  }

  return {
    externalId: raw.externalId || generateExternalId(raw, source),
    source,
    title: raw.title.trim(),
    company: raw.company.trim(),
    companyLogo: raw.companyLogo,
    location: location || undefined,
    workMode: workMode || undefined,
    salaryMin: salaryMin ?? undefined,
    salaryMax: salaryMax ?? undefined,
    salaryCurrency: salaryCurrency ?? undefined,
    description: raw.description,
    summary: raw.summary,
    url: raw.url,
    applyUrl: raw.applyUrl,
    postedAt: raw.postedAt ? new Date(raw.postedAt) : undefined,
    skills: raw.skills || [],
    jobType: raw.jobType,
  };
}

/**
 * Generate a deterministic external ID for a job when one is not provided.
 */
function generateExternalId(raw: RawJobData, source: JobSource): string {
  const base = `${source}:${raw.company}:${raw.title}:${raw.url}`;
  // Simple hash for dedup purposes
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    const char = base.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `${source}-${Math.abs(hash).toString(36)}`;
}

/**
 * Create a deduplication fingerprint from title + company + location.
 * Strips whitespace, lowercases, and removes special characters.
 */
export function generateFingerprint(job: {
  title: string;
  company: string;
  location?: string;
}): string {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();

  return `${normalize(job.title)}|${normalize(job.company)}|${normalize(job.location || "")}`;
}

/**
 * Normalize a job title for fuzzy comparison by removing level indicators,
 * whitespace, and special characters.
 */
export function normalizeTitleForFuzzy(title: string): string {
  return title
    .replace(TITLE_LEVEL_PATTERNS, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a company name for fuzzy comparison by removing legal suffixes,
 * whitespace, and special characters.
 */
export function normalizeCompanyForFuzzy(company: string): string {
  return company
    .replace(COMPANY_SUFFIX_PATTERNS, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate similarity between two strings using bigram overlap (Dice coefficient).
 * Returns a score between 0 (completely different) and 1 (identical).
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) {
    return a === b ? 1 : 0;
  }

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.substring(i, i + 2));
  }

  let intersectionCount = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    if (bigramsA.has(bigram)) {
      intersectionCount++;
      bigramsA.delete(bigram); // prevent double-counting
    }
  }

  const totalBigrams = a.length - 1 + (b.length - 1);
  return (2 * intersectionCount) / totalBigrams;
}

/**
 * Calculate a fuzzy similarity score between two locations.
 * Handles cases like "San Francisco, CA" vs "San Francisco, California".
 */
export function locationSimilarity(loc1: string, loc2: string): number {
  if (!loc1 && !loc2) return 1;
  if (!loc1 || !loc2) return 0;

  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const n1 = normalize(loc1);
  const n2 = normalize(loc2);

  if (n1 === n2) return 1;

  // Check if one contains the other (e.g., "San Francisco" in "San Francisco, CA")
  if (n1.includes(n2) || n2.includes(n1)) return 0.9;

  return stringSimilarity(n1, n2);
}

/**
 * Calculate a fuzzy duplicate score between two jobs.
 *
 * Weights:
 * - Title similarity: 50%
 * - Company similarity: 30%
 * - Location similarity: 20%
 *
 * @returns Score between 0 and 1.
 */
export function fuzzyDuplicateScore(a: NormalizedJob, b: NormalizedJob): number {
  const titleA = normalizeTitleForFuzzy(a.title);
  const titleB = normalizeTitleForFuzzy(b.title);
  const titleSim = stringSimilarity(titleA, titleB);

  const companyA = normalizeCompanyForFuzzy(a.company);
  const companyB = normalizeCompanyForFuzzy(b.company);
  const companySim = stringSimilarity(companyA, companyB);

  const locSim = locationSimilarity(a.location || "", b.location || "");

  return titleSim * 0.5 + companySim * 0.3 + locSim * 0.2;
}

/** Default threshold for auto-merging fuzzy duplicates. */
export const FUZZY_MERGE_THRESHOLD = 0.85;

/**
 * Find duplicate matches for a given job among a list of existing jobs.
 *
 * Checks in order:
 * 1. Exact externalId + source match (confidence 1.0)
 * 2. Exact applyUrl match (confidence 1.0)
 * 3. Exact fingerprint match (confidence 0.95)
 * 4. Fuzzy matching above threshold (confidence = fuzzy score)
 *
 * @param job - The job to find duplicates for.
 * @param existingJobs - The pool of existing jobs to check against.
 * @param fuzzyThreshold - Minimum fuzzy score to consider a match (default 0.85).
 * @returns Array of duplicate matches sorted by confidence descending.
 */
export function findDuplicates(
  job: NormalizedJob,
  existingJobs: NormalizedJob[],
  fuzzyThreshold: number = FUZZY_MERGE_THRESHOLD,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const fingerprint = generateFingerprint(job);
  const applyUrl = job.applyUrl || "";

  for (const existing of existingJobs) {
    // Strategy 1: externalId + source
    if (job.externalId === existing.externalId && job.source === existing.source) {
      matches.push({ job: existing, confidence: 1.0, method: "externalId" });
      continue;
    }

    // Strategy 2: exact applyUrl
    if (applyUrl && existing.applyUrl && applyUrl === existing.applyUrl) {
      matches.push({ job: existing, confidence: 1.0, method: "applyUrl" });
      continue;
    }

    // Strategy 3: fingerprint
    const existingFingerprint = generateFingerprint(existing);
    if (fingerprint === existingFingerprint) {
      matches.push({ job: existing, confidence: 0.95, method: "fingerprint" });
      continue;
    }

    // Strategy 4: fuzzy matching
    const score = fuzzyDuplicateScore(job, existing);
    if (score >= fuzzyThreshold) {
      matches.push({ job: existing, confidence: score, method: "fuzzy" });
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

/**
 * Remove duplicate jobs from an array with full merge tracking.
 *
 * Dedup strategies (in order):
 * 1. Exact externalId + source match
 * 2. Exact applyUrl match
 * 3. Fingerprint (title+company+location) match
 * 4. Fuzzy matching above threshold
 *
 * When duplicates are found, prefer the one with higher sourceTrust
 * (official company/ATS sources preferred).
 */
export function deduplicateJobs(
  jobs: NormalizedJob[],
  sourceTypes?: Map<string, SourceType>,
): NormalizedJob[] {
  const result = deduplicateJobsWithHistory(jobs, sourceTypes);
  return result.jobs;
}

/**
 * Remove duplicate jobs from an array, returning both deduplicated jobs
 * and a full merge history for audit/debugging.
 *
 * Dedup strategies (in order):
 * 1. Exact externalId + source match
 * 2. Exact applyUrl match
 * 3. Fingerprint (title+company+location) match
 * 4. Fuzzy matching above threshold
 *
 * When duplicates are found, prefer the one with higher sourceTrust.
 */
export function deduplicateJobsWithHistory(
  jobs: NormalizedJob[],
  sourceTypes?: Map<string, SourceType>,
  fuzzyThreshold: number = FUZZY_MERGE_THRESHOLD,
): DeduplicationResult {
  const result: NormalizedJob[] = [];
  const mergeHistory: MergeRecord[] = [];

  // Track seen identifiers
  const seenByExternalId = new Map<string, number>(); // key -> index in result
  const seenByApplyUrl = new Map<string, number>();
  const seenByFingerprint = new Map<string, number>();

  for (const job of jobs) {
    const externalKey = `${job.externalId}:${job.source}`;
    const fingerprint = generateFingerprint(job);
    const applyUrl = job.applyUrl || "";

    // Check for duplicates
    let existingIndex: number | undefined;
    let matchMethod: DuplicateMatch["method"] = "externalId";

    // Strategy 1: externalId + source
    if (seenByExternalId.has(externalKey)) {
      existingIndex = seenByExternalId.get(externalKey);
      matchMethod = "externalId";
    }

    // Strategy 2: applyUrl
    if (existingIndex == null && applyUrl && seenByApplyUrl.has(applyUrl)) {
      existingIndex = seenByApplyUrl.get(applyUrl);
      matchMethod = "applyUrl";
    }

    // Strategy 3: fingerprint
    if (existingIndex == null && seenByFingerprint.has(fingerprint)) {
      existingIndex = seenByFingerprint.get(fingerprint);
      matchMethod = "fingerprint";
    }

    // Strategy 4: fuzzy matching against all results so far
    if (existingIndex == null) {
      let bestFuzzyScore = 0;
      let bestFuzzyIndex: number | undefined;

      for (let i = 0; i < result.length; i++) {
        const existing = result[i]!;
        const score = fuzzyDuplicateScore(job, existing);
        if (score >= fuzzyThreshold && score > bestFuzzyScore) {
          bestFuzzyScore = score;
          bestFuzzyIndex = i;
        }
      }

      if (bestFuzzyIndex != null) {
        existingIndex = bestFuzzyIndex;
        matchMethod = "fuzzy";
      }
    }

    if (existingIndex != null) {
      // Duplicate found - keep the one with higher trust
      const existing = result[existingIndex];
      if (existing && shouldReplace(existing, job, sourceTypes)) {
        // Record the merge: old job is being replaced
        mergeHistory.push({
          keptJob: { externalId: job.externalId, source: job.source },
          mergedJob: { externalId: existing.externalId, source: existing.source },
          confidence: matchMethod === "fuzzy" ? fuzzyDuplicateScore(job, existing) : 1.0,
          method: matchMethod,
          mergedAt: new Date(),
        });
        result[existingIndex] = job;
        // Update indexes
        updateIndexes(
          job,
          existingIndex,
          seenByExternalId,
          seenByApplyUrl,
          seenByFingerprint,
        );
      } else if (existing) {
        // Record the merge: new job is discarded
        mergeHistory.push({
          keptJob: { externalId: existing.externalId, source: existing.source },
          mergedJob: { externalId: job.externalId, source: job.source },
          confidence: matchMethod === "fuzzy" ? fuzzyDuplicateScore(job, existing) : 1.0,
          method: matchMethod,
          mergedAt: new Date(),
        });
      }
    } else {
      // New job
      const idx = result.length;
      result.push(job);
      seenByExternalId.set(externalKey, idx);
      if (applyUrl) seenByApplyUrl.set(applyUrl, idx);
      seenByFingerprint.set(fingerprint, idx);
    }
  }

  return { jobs: result, mergeHistory };
}

/**
 * Determine if a new job should replace an existing duplicate.
 * Prefers official company/ATS sources (higher sourceType trust).
 */
function shouldReplace(
  existing: NormalizedJob,
  candidate: NormalizedJob,
  sourceTypes?: Map<string, SourceType>,
): boolean {
  const existingTrust = getSourceTrust(existing.source, sourceTypes);
  const candidateTrust = getSourceTrust(candidate.source, sourceTypes);
  return candidateTrust > existingTrust;
}

/**
 * Get trust score for a job source.
 */
function getSourceTrust(
  source: JobSource,
  sourceTypes?: Map<string, SourceType>,
): number {
  if (sourceTypes) {
    const type = sourceTypes.get(source);
    if (type) return SOURCE_TRUST_ORDER[type] ?? 0.5;
  }

  // Default trust by source name
  const directSources = [
    "GREENHOUSE", "LEVER", "ASHBY", "SMARTRECRUITERS",
    "WORKABLE", "WORKDAY", "TEAMTAILOR", "RECRUITEE",
  ];
  if (directSources.includes(source)) return 0.85;
  if (source === "COMPANY_SITE") return 0.9;
  if (source === "STRUCTURED_DATA") return 0.8;
  return 0.4;
}

/**
 * Update dedup indexes when replacing a job.
 */
function updateIndexes(
  job: NormalizedJob,
  idx: number,
  byExternalId: Map<string, number>,
  byApplyUrl: Map<string, number>,
  byFingerprint: Map<string, number>,
): void {
  byExternalId.set(`${job.externalId}:${job.source}`, idx);
  if (job.applyUrl) byApplyUrl.set(job.applyUrl, idx);
  byFingerprint.set(generateFingerprint(job), idx);
}

/**
 * Infer work mode from text content.
 */
export function normalizeWorkMode(text: string): WorkMode | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (
    lower.includes("on-site") ||
    lower.includes("onsite") ||
    lower.includes("on site") ||
    lower.includes("in-office") ||
    lower.includes("in office")
  ) {
    return "ONSITE";
  }
  if (lower.includes("hybrid")) return "HYBRID";
  if (
    lower.includes("remote") ||
    lower.includes("work from home") ||
    lower.includes("wfh") ||
    lower.includes("telecommute") ||
    lower.includes("distributed")
  ) {
    return "REMOTE";
  }

  return null;
}

/**
 * Clean up and normalize a location string.
 */
export function normalizeLocation(text: string): string {
  if (!text) return "";

  let cleaned = text
    .replace(/\s+/g, " ")
    .replace(/^[,;\s]+|[,;\s]+$/g, "")
    .trim();

  // Remove remote/hybrid/onsite indicators from location
  cleaned = cleaned
    .replace(/\b(remote|hybrid|on-?site|in-?office|telecommute|wfh|work from home)\b/gi, "")
    .replace(/\s*[(),/|]\s*$/g, "")
    .replace(/^\s*[(),/|]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Capitalize properly if all lowercase
  if (cleaned === cleaned.toLowerCase() && cleaned.length > 0) {
    cleaned = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return cleaned;
}

/**
 * Extract salary min, max, and currency from a salary text string.
 * Handles formats like "$80,000 - $120,000", "80k-120k USD", "$150,000/year"
 */
export function normalizeSalary(text: string): {
  min: number | null;
  max: number | null;
  currency: string | null;
} {
  if (!text) return { min: null, max: null, currency: null };

  const lower = text.toLowerCase().replace(/,/g, "");

  // Detect currency
  let currency: string | null = null;
  if (/\$|usd/i.test(text)) currency = "USD";
  else if (/€|eur/i.test(text)) currency = "EUR";
  else if (/£|gbp/i.test(text)) currency = "GBP";
  else if (/cad/i.test(text)) currency = "CAD";
  else if (/aud/i.test(text)) currency = "AUD";

  // Extract numbers
  const numberPattern = /(\d+(?:\.\d+)?)\s*k?\b/g;
  const numbers: number[] = [];
  let match;

  while ((match = numberPattern.exec(lower)) !== null) {
    let value = parseFloat(match[1] || "0");
    // Handle 'k' suffix (e.g., "80k" -> 80000)
    if (match[0]?.endsWith("k")) {
      value *= 1000;
    }
    // Handle values that seem to be in thousands already (e.g., "80" likely means $80,000)
    if (value > 0 && value < 1000 && !match[0]?.includes(".")) {
      value *= 1000;
    }
    numbers.push(value);
  }

  if (numbers.length === 0) return { min: null, max: null, currency };
  if (numbers.length === 1) return { min: numbers[0]!, max: numbers[0]!, currency };

  // Sort and take first two as range
  numbers.sort((a, b) => a - b);
  return { min: numbers[0]!, max: numbers[numbers.length - 1]!, currency };
}
