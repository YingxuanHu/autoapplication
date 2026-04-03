import type { FillerProfile, FillerResume, FillerPackage } from "./types";

/**
 * Canonical field concepts that auto-apply knows how to fill.
 * Each ATS filler maps its form selectors to these concepts.
 */
export type FieldConcept =
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "phone"
  | "linkedin_url"
  | "github_url"
  | "portfolio_url"
  | "website_url"
  | "resume_file"
  | "cover_letter"
  | "work_authorization"
  | "salary_expectation"
  | "location"
  | "how_did_you_hear";

/**
 * Build the value map from profile + package data.
 * Returns null for fields where we don't have data.
 */
export function buildFieldValueMap(
  profile: FillerProfile,
  resume: FillerResume,
  pkg: FillerPackage
): Record<FieldConcept, string | null> {
  const salaryText =
    profile.salaryMin && profile.salaryMax
      ? `${profile.salaryMin}-${profile.salaryMax} ${profile.salaryCurrency ?? "USD"}`
      : profile.salaryMin
        ? `${profile.salaryMin}+ ${profile.salaryCurrency ?? "USD"}`
        : null;

  return {
    first_name: profile.firstName,
    last_name: profile.lastName,
    full_name: `${profile.firstName} ${profile.lastName}`,
    email: profile.email,
    phone: profile.phone,
    linkedin_url: profile.linkedinUrl,
    github_url: profile.githubUrl,
    portfolio_url: profile.portfolioUrl,
    website_url: profile.portfolioUrl ?? profile.githubUrl,
    resume_file: resume.filePath,
    cover_letter: pkg.coverLetterContent,
    work_authorization: profile.workAuthorization,
    salary_expectation: salaryText,
    location: null, // Derived from job, not profile
    how_did_you_hear: "Job board",
  };
}

// ─── Label-to-concept heuristic matching ─────────────────────────────────────

const LABEL_PATTERNS: Array<{ pattern: RegExp; concept: FieldConcept }> = [
  { pattern: /\bfirst\s*name\b/i, concept: "first_name" },
  { pattern: /\blast\s*name\b|surname\b|family\s*name\b/i, concept: "last_name" },
  { pattern: /\bfull\s*name\b|\byour\s*name\b/i, concept: "full_name" },
  { pattern: /\be[\s-]*mail\b/i, concept: "email" },
  { pattern: /\bphone\b|\bmobile\b|\bcell\b|\btelephone\b/i, concept: "phone" },
  { pattern: /\blinkedin\b/i, concept: "linkedin_url" },
  { pattern: /\bgithub\b/i, concept: "github_url" },
  { pattern: /\bportfolio\b|\bpersonal\s*(?:site|website)\b/i, concept: "portfolio_url" },
  { pattern: /\bwebsite\b|\burl\b|\bweb\s*page\b/i, concept: "website_url" },
  { pattern: /\bresume\b|\bcv\b|\bcurriculum/i, concept: "resume_file" },
  { pattern: /\bcover\s*letter\b/i, concept: "cover_letter" },
  { pattern: /\bauthoriz(?:ation|ed)\b|\bsponsorship\b|\bwork\s*(?:permit|visa)\b|\blegally\b/i, concept: "work_authorization" },
  { pattern: /\bsalary\b|\bcompensation\b|\bpay\s*(?:range|expectation)\b/i, concept: "salary_expectation" },
  { pattern: /\blocation\b|\bcity\b|\bwhere.*(?:you|located)\b/i, concept: "location" },
  { pattern: /\bhow\s*did\s*you\s*hear\b|\breferral\s*source\b|\bwhere.*(?:find|learn)\b/i, concept: "how_did_you_hear" },
];

/**
 * Given a form field label, try to match it to a known concept.
 * Returns null if no confident match.
 */
export function matchLabelToConcept(label: string): FieldConcept | null {
  const trimmed = label.trim();
  for (const { pattern, concept } of LABEL_PATTERNS) {
    if (pattern.test(trimmed)) return concept;
  }
  return null;
}
