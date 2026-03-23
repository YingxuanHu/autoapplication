import type { JobFamily, RegionScope } from "@/generated/prisma";
import { htmlToPlainText, normalizeText } from "@/lib/job-sources/utils";
import type { NormalizedJob } from "@/types/index";
import {
  AGENCY_KEYWORDS,
  INTERNSHIP_KEYWORDS,
  PUBLIC_SECTOR_KEYWORDS,
  STEM_FAMILY_RULES,
} from "./stem-taxonomy";

const CANADIAN_LOCATION_TOKENS = [
  "canada",
  "toronto",
  "vancouver",
  "montreal",
  "ottawa",
  "calgary",
  "edmonton",
  "quebec",
  "ontario",
  "british columbia",
  "alberta",
  "manitoba",
  "saskatchewan",
  "nova scotia",
  "new brunswick",
  "newfoundland",
  "labrador",
  "prince edward island",
  "pei",
  "yukon",
  "nunavut",
  "northwest territories",
  "ab, canada",
  "bc, canada",
  "mb, canada",
  "nb, canada",
  "nl, canada",
  "ns, canada",
  "nt, canada",
  "nu, canada",
  "on, canada",
  "pe, canada",
  "qc, canada",
  "sk, canada",
  "yt, canada",
] as const;

const US_LOCATION_TOKENS = [
  "united states",
  "united states of america",
  "usa",
  "u.s.",
  "new york, ny",
  "san francisco, ca",
  "seattle, wa",
  "austin, tx",
  "remote - us",
  "remote us",
  "united states remote",
  ", al",
  ", ak",
  ", az",
  ", ar",
  ", ca",
  ", co",
  ", ct",
  ", dc",
  ", de",
  ", fl",
  ", ga",
  ", hi",
  ", ia",
  ", id",
  ", il",
  ", in",
  ", ks",
  ", ky",
  ", la",
  ", ma",
  ", md",
  ", me",
  ", mi",
  ", mn",
  ", mo",
  ", ms",
  ", mt",
  ", nc",
  ", nd",
  ", ne",
  ", nh",
  ", nj",
  ", nm",
  ", nv",
  ", ny",
  ", oh",
  ", ok",
  ", or",
  ", pa",
  ", ri",
  ", sc",
  ", sd",
  ", tn",
  ", tx",
  ", ut",
  ", va",
  ", vt",
  ", wa",
  ", wi",
  ", wv",
  ", wy",
] as const;

const NORTH_AMERICA_TOKENS = [
  "north america",
  "north american",
  "us/canada",
  "usa/canada",
  "united states or canada",
  "canada or united states",
] as const;

const NON_CANONICAL_JOB_HOSTS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "boards.eu.greenhouse.io",
  "careers.smartrecruiters.com",
  "smartrecruiters.com",
  "apply.workable.com",
  "myworkdayjobs.com",
  "teamtailor.com",
  "recruitee.com",
  "themuse.com",
  "reed.co.uk",
  "www.reed.co.uk",
  "jooble.org",
  "jooble.com",
  "data.usajobs.gov",
  "usajobs.gov",
  "adzuna.com",
  "api.adzuna.com",
  "jsearch.p.rapidapi.com",
] as const;

const GENERIC_STEM_TERMS = [
  "engineer",
  "engineering",
  "scientist",
  "science",
  "analytics",
  "mathematics",
  "mathematical",
  "data",
  "quant",
  "actuarial",
  "research",
] as const;

export interface JobClassification {
  countryCode?: string;
  regionScope: RegionScope;
  jobFamily: JobFamily;
  jobSubfamily?: string;
  stemScore: number;
  canonicalCompanyDomain?: string;
  isAgency: boolean;
  isPublicSector: boolean;
  isInternship: boolean;
}

export function classifyNormalizedJob(job: NormalizedJob): JobClassification {
  const locationText = normalizeText(job.location ?? "");
  const titleText = normalizeText(job.title);
  const companyText = normalizeText(job.company);
  const contentText = normalizeText(
    [job.summary ?? "", htmlToPlainText(job.description), job.skills.join(" ")]
      .filter(Boolean)
      .join(" "),
  );
  const fullText = `${titleText} ${companyText} ${locationText} ${contentText}`.trim();

  const countryCode = inferCountryCode(job, locationText);
  const regionScope = inferRegionScope(countryCode, locationText);
  const bestFamilyMatch = getBestStemFamilyMatch(titleText, contentText);
  const stemScore = getStemScore(bestFamilyMatch?.score ?? 0, fullText);
  const isPublicSector = inferPublicSector(job, fullText);
  const isAgency = includesAny(fullText, AGENCY_KEYWORDS);
  const isInternship = includesAny(fullText, INTERNSHIP_KEYWORDS);

  return {
    countryCode,
    regionScope,
    jobFamily:
      bestFamilyMatch && bestFamilyMatch.score >= 2
        ? bestFamilyMatch.family
        : "OTHER",
    jobSubfamily:
      bestFamilyMatch && bestFamilyMatch.score >= 2
        ? bestFamilyMatch.subfamily
        : undefined,
    stemScore,
    canonicalCompanyDomain: extractCanonicalCompanyDomain(job),
    isAgency,
    isPublicSector,
    isInternship,
  };
}

function inferCountryCode(
  job: Pick<NormalizedJob, "location" | "source" | "url" | "applyUrl">,
  locationText: string,
): string | undefined {
  if (job.source === "USAJOBS") return "US";

  if (includesAny(locationText, CANADIAN_LOCATION_TOKENS)) return "CA";
  if (includesAny(locationText, US_LOCATION_TOKENS)) return "US";

  const domain = extractCanonicalCompanyDomain(job);
  if (domain?.endsWith(".gc.ca") || domain?.endsWith(".gov.ca")) return "CA";
  if (domain?.endsWith(".ca")) return "CA";
  if (domain?.endsWith(".gov")) return "US";

  return undefined;
}

function inferRegionScope(
  countryCode: string | undefined,
  locationText: string,
): RegionScope {
  if (countryCode === "US") return "US";
  if (countryCode === "CA") return "CA";
  if (includesAny(locationText, NORTH_AMERICA_TOKENS)) return "NA";
  return "GLOBAL";
}

function getBestStemFamilyMatch(titleText: string, contentText: string) {
  const matches = STEM_FAMILY_RULES.map((rule) => {
    const titleHits = countHits(titleText, rule.titleKeywords);
    const descriptionHits = countHits(contentText, rule.descriptionKeywords);
    const score = titleHits * 3 + descriptionHits;

    return {
      family: rule.family,
      subfamily: rule.subfamily,
      score,
    };
  }).filter((match) => match.score > 0);

  matches.sort((left, right) => right.score - left.score);
  return matches[0];
}

function getStemScore(bestFamilyScore: number, fullText: string): number {
  const genericSignals = countHits(fullText, GENERIC_STEM_TERMS);
  const rawScore = bestFamilyScore + genericSignals * 0.5;

  if (rawScore <= 0) return 0;
  return Math.min(1, Number((rawScore / 6).toFixed(2)));
}

function inferPublicSector(job: NormalizedJob, fullText: string): boolean {
  if (job.source === "USAJOBS") return true;

  const domain = extractCanonicalCompanyDomain(job);
  if (domain?.endsWith(".gov") || domain?.endsWith(".gc.ca") || domain?.endsWith(".edu")) {
    return true;
  }

  return includesAny(fullText, PUBLIC_SECTOR_KEYWORDS);
}

function extractCanonicalCompanyDomain(
  job: Pick<NormalizedJob, "url" | "applyUrl">,
): string | undefined {
  for (const candidate of [job.applyUrl, job.url]) {
    if (!candidate) continue;

    try {
      const hostname = new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
      if (!isNonCanonicalJobHost(hostname)) {
        return hostname;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function isNonCanonicalJobHost(hostname: string): boolean {
  return NON_CANONICAL_JOB_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

function countHits(value: string, keywords: readonly string[]): number {
  return keywords.reduce((count, keyword) => {
    return value.includes(normalizeText(keyword)) ? count + 1 : count;
  }, 0);
}

function includesAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(normalizeText(keyword)));
}
