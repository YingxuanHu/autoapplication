import type {
  EmploymentType,
  ExperienceLevel,
  Industry,
  Region,
  WorkMode,
} from "@/generated/prisma/client";
import type {
  NormalizationResult,
  NormalizedJobInput,
  SourceConnectorJob,
} from "@/lib/ingestion/types";
import { buildCanonicalDedupeFields } from "@/lib/ingestion/dedupe";

const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

const CA_PROVINCE_CODES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);

const US_CITY_MARKERS = [
  "san francisco",
  "new york",
  "new york city",
  "austin",
  "seattle",
  "chicago",
  "boston",
  "denver",
  "los angeles",
  "miami",
  "portland",
  "washington dc",
  "south san francisco",
  "atlanta",
];

const CA_CITY_MARKERS = [
  "toronto",
  "vancouver",
  "montreal",
  "calgary",
  "ottawa",
  "waterloo",
];

const ROLE_PATTERNS: Array<{
  pattern: RegExp;
  industry: Industry;
  roleFamily: string;
}> = [
  // ── Tech roles ──────────────────────────────────────────────────────────────

  // Solutions Engineering: pre-sales / technical integration roles
  {
    pattern: /\b(solutions engineer|sales engineer)\b/i,
    industry: "TECH",
    roleFamily: "Solutions Engineering",
  },
  // Solutions Architecture: broader architectural / implementation layer
  // Listed before SWE so "solutions architect" doesn't fall into the broad engineer match
  {
    pattern:
      /\b(solutions architect|enterprise architect|technical architect|cloud architect|staff architect|principal architect|resident engineer)\b/i,
    industry: "TECH",
    roleFamily: "Solutions Architecture",
  },
  // Product Management: PM and TPM (TPM is tightly scoped to avoid "program manager" noise)
  // "product management" (gerund) catches exec titles like "Director, Product Management"
  {
    pattern:
      /\b(product manager|product management|group product manager|senior product manager|staff product manager|principal product manager|technical program manager|tpm)\b/i,
    industry: "TECH",
    roleFamily: "Product Management",
  },
  // Research: AI/ML research scientists and engineers at AI-first companies
  // "researcher" alone kept intentional — at OpenAI/Anthropic it is always a technical role
  {
    pattern: /\b(research scientist|research engineer|researcher|applied research scientist)\b/i,
    industry: "TECH",
    roleFamily: "Research",
  },
  // Data Science: ML engineering, applied science, and data science leadership
  // "data science" (standalone) catches exec titles like "Data Science Manager", "Head of Data Science"
  {
    pattern: /\b(machine learning|ml engineer|data scientist|data science|applied scientist)\b/i,
    industry: "TECH",
    roleFamily: "Data Science",
  },
  // Data Engineering: pipeline / platform engineering (distinct from analyst/science)
  {
    pattern: /\b(data engineer|etl engineer|data pipeline engineer|data platform engineer)\b/i,
    industry: "TECH",
    roleFamily: "Data Engineering",
  },
  // Data Analyst: analytics and BI
  {
    pattern:
      /\b(data analyst|analytics engineer|business intelligence|bi analyst|data analytics)\b/i,
    industry: "TECH",
    roleFamily: "Data Analyst",
  },
  // Product Analyst
  {
    pattern: /\b(product analyst)\b/i,
    industry: "TECH",
    roleFamily: "Product Analyst",
  },
  // Business Analyst
  {
    pattern: /\b(business analyst)\b/i,
    industry: "TECH",
    roleFamily: "Business Analyst",
  },
  // Security
  {
    pattern: /\b(security)\b/i,
    industry: "TECH",
    roleFamily: "Security",
  },
  // QA / Test
  {
    pattern: /\b(qa|quality assurance|test automation)\b/i,
    industry: "TECH",
    roleFamily: "QA",
  },
  // Marketing: tech marketing roles at tech companies — product marketing, growth, demand gen
  // Scoped to compound titles to avoid matching pure "marketing" which would catch non-tech roles.
  // Listed before Design and SWE to prevent "Growth Marketing Engineer" noise.
  {
    pattern:
      /\b(product marketing|growth marketing|performance marketing|content marketing|marketing manager|demand generation|marketing analyst|field marketing|digital marketing|brand marketing|marketing operations|lifecycle marketing|marketing lead|marketing director)\b/i,
    industry: "TECH",
    roleFamily: "Marketing",
  },
  // Technical Writing / Developer Relations: technical content and community roles
  {
    pattern:
      /\b(technical writer|developer relations|developer advocate|devrel|developer experience|documentation engineer|technical documentation|technical editor)\b/i,
    industry: "TECH",
    roleFamily: "Technical Writing",
  },
  // Design: product/UX/brand/web design — must be listed before SWE to prevent
  // "Designer, Web & Brand" from matching the SWE catch-all via "web engineer"
  {
    pattern:
      /\b(designer|design lead|design director|ux design|ui design|product design|brand design|graphic design|visual design|interaction design|design manager)\b/i,
    industry: "TECH",
    roleFamily: "Design",
  },
  // SWE: broad engineering catch-all — listed last among tech so specific roles above take priority
  // "web" is scoped to "web engineer|web developer" to avoid matching design/content titles.
  // "platform" is also scoped to engineering-specific phrases so business titles like
  // "Platform Partnerships" or "Platform Growth" do not slip into the engineering pool.
  {
    pattern:
      /\b(software|frontend|front-end|backend|back-end|full[- ]stack|platform engineer|platform engineering|platform developer|mobile|ios|android|devops|site reliability|sre|web engineer|web developer|engineer|engineering manager|dx engineer|content engineer|design engineer)\b/i,
    industry: "TECH",
    roleFamily: "SWE",
  },

  // ── Finance roles ────────────────────────────────────────────────────────────

  {
    pattern: /\b(financial analyst|corporate finance|finance analyst|treasury)\b/i,
    industry: "FINANCE",
    roleFamily: "Financial Analyst",
  },
  // FP&A: includes finance-and-strategy roles at tech companies (e.g. "Finance & Strategy")
  {
    pattern:
      /\b(fp&a|financial planning|finance.{0,5}strategy|strategy.{0,5}finance)\b/i,
    industry: "FINANCE",
    roleFamily: "FP&A",
  },
  {
    pattern: /\b(investment banking)\b/i,
    industry: "FINANCE",
    roleFamily: "Investment Banking",
  },
  {
    pattern: /\b(risk)\b/i,
    industry: "FINANCE",
    roleFamily: "Risk",
  },
  {
    pattern: /\b(compliance)\b/i,
    industry: "FINANCE",
    roleFamily: "Compliance",
  },
  {
    pattern: /\b(credit)\b/i,
    industry: "FINANCE",
    roleFamily: "Credit",
  },
  {
    pattern: /\b(wealth management|wealth)\b/i,
    industry: "FINANCE",
    roleFamily: "Wealth Management",
  },
  // Operations: finance/tech ops; biz ops at tech companies is also captured here
  {
    pattern: /\b(operations analyst|biz ops|bizops|business operations|operations)\b/i,
    industry: "FINANCE",
    roleFamily: "Operations",
  },
];

const EXCLUDED_TITLE_PATTERNS = [
  /\b(recruiter|recruiting coordinator|recruiting ops|talent acquisition|technical recruiter|sourcer)\b/i,
  /\b(people partner|people operations|people ops|hr business partner|human resources)\b/i,
];

type NormalizeSourceJobOptions = {
  job: SourceConnectorJob;
  fetchedAt: Date;
};

export function normalizeSourceJob({
  job,
  fetchedAt,
}: NormalizeSourceJobOptions): NormalizationResult {
  const title = compactWhitespace(job.title);
  const company = compactWhitespace(job.company);
  const location = compactWhitespace(job.location);
  const description = sanitizeText(job.description);

  if (!title || !company || !location || !job.applyUrl) {
    return {
      kind: "rejected",
      reason: "missing_required_fields",
    };
  }

  const region = inferRegion(location);
  if (!region) {
    return {
      kind: "rejected",
      reason: "outside_north_america_scope",
    };
  }

  if (EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return {
      kind: "rejected",
      reason: "unsupported_role_family",
    };
  }

  const roleProfile = inferRoleProfile(title);
  if (!roleProfile) {
    return {
      kind: "rejected",
      reason: "unsupported_role_family",
    };
  }

  const workMode = inferWorkMode(title, location, description, job.workMode);
  const employmentType = inferEmploymentType(title, description, job.employmentType);
  const experienceLevel = inferExperienceLevel(title);
  const postedAt = job.postedAt ?? fetchedAt;
  const deadline =
    job.deadline && job.deadline.getTime() > fetchedAt.getTime() ? job.deadline : null;
  const dedupeFields = buildCanonicalDedupeFields({
    company,
    title,
    description,
    location,
    region,
    applyUrl: job.applyUrl,
  });

  const normalized: NormalizedJobInput = {
    title,
    company,
    companyKey: dedupeFields.companyKey,
    titleKey: dedupeFields.titleKey,
    titleCoreKey: dedupeFields.titleCoreKey,
    descriptionFingerprint: dedupeFields.descriptionFingerprint,
    location,
    locationKey: dedupeFields.locationKey,
    region,
    workMode,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    employmentType,
    experienceLevel,
    description,
    shortSummary: buildShortSummary(title, company, workMode, description),
    industry: roleProfile.industry,
    roleFamily: roleProfile.roleFamily,
    applyUrl: job.applyUrl,
    applyUrlKey: dedupeFields.applyUrlKey,
    postedAt,
    deadline,
    duplicateClusterId: dedupeFields.duplicateClusterId,
  };

  return {
    kind: "accepted",
    job: normalized,
  };
}

function inferRegion(location: string): Region | null {
  const normalizedLocation = location.toUpperCase();
  if (
    normalizedLocation.includes("NORTH AMERICA") ||
    normalizedLocation.includes("US & CANADA") ||
    normalizedLocation.includes("US/CANADA") ||
    normalizedLocation.includes("US AND CANADA")
  ) {
    return "CA";
  }

  if (
    normalizedLocation.includes("UNITED STATES") ||
    normalizedLocation.includes("USA") ||
    normalizedLocation.includes("U.S.")
  ) {
    return "US";
  }

  if (normalizedLocation.includes("CANADA")) {
    return "CA";
  }

  const loweredLocation = location.toLowerCase();
  if (US_CITY_MARKERS.some((cityMarker) => loweredLocation.includes(cityMarker))) {
    return "US";
  }
  if (CA_CITY_MARKERS.some((cityMarker) => loweredLocation.includes(cityMarker))) {
    return "CA";
  }

  const parts = location
    .split(",")
    .map((segment) => segment.trim().toUpperCase())
    .filter(Boolean);
  const trailingPart = parts[parts.length - 1] ?? "";

  if (US_STATE_CODES.has(trailingPart)) return "US";
  if (CA_PROVINCE_CODES.has(trailingPart)) return "CA";

  // Handle remote, worldwide, and work-from-home locations.
  // Pure "Remote" and similar strings are treated as US-eligible: the structured
  // ATS sources we ingest (Greenhouse, Lever, Ashby) are predominantly NA-based
  // companies whose unqualified remote roles target US/CA applicants.
  // Reject only when an explicit non-NA qualifier is present.
  if (
    normalizedLocation.includes("REMOTE") ||
    normalizedLocation.includes("WORK FROM HOME") ||
    normalizedLocation.includes("WORLDWIDE") ||
    normalizedLocation.includes("ANYWHERE") ||
    normalizedLocation === "GLOBAL"
  ) {
    const NON_NA_REMOTE_QUALIFIERS = [
      "EUROPE",
      "EMEA",
      "LATAM",
      "APAC",
      "ASIA",
      "AUSTRALIA",
      "INDIA",
      "AFRICA",
      "MIDDLE EAST",
      "UNITED KINGDOM",
      "GERMANY",
      "FRANCE",
      "BRAZIL",
      "JAPAN",
      "SINGAPORE",
      "NETHERLANDS",
      "SWEDEN",
      "POLAND",
    ];
    if (!NON_NA_REMOTE_QUALIFIERS.some((q) => normalizedLocation.includes(q))) {
      return "US";
    }
  }

  return null;
}

function inferRoleProfile(title: string) {
  return ROLE_PATTERNS.find((rolePattern) => rolePattern.pattern.test(title)) ?? null;
}

function inferWorkMode(
  title: string,
  location: string,
  description: string,
  suggestedWorkMode: WorkMode | null
): WorkMode {
  if (suggestedWorkMode) return suggestedWorkMode;

  const combinedText = `${title} ${location} ${description}`.toLowerCase();

  if (combinedText.includes("hybrid")) return "HYBRID";
  if (combinedText.includes("remote") || combinedText.includes("work from home")) {
    return "REMOTE";
  }
  if (combinedText.includes("flexible")) return "FLEXIBLE";
  if (combinedText.includes("on-site") || combinedText.includes("onsite")) {
    return "ONSITE";
  }

  return "ONSITE";
}

function inferEmploymentType(
  title: string,
  description: string,
  suggestedEmploymentType: EmploymentType | null
): EmploymentType {
  if (suggestedEmploymentType) return suggestedEmploymentType;

  const combinedText = `${title} ${description}`.toLowerCase();

  if (
    combinedText.includes("intern") ||
    combinedText.includes("internship") ||
    combinedText.includes("co-op")
  ) {
    return "INTERNSHIP";
  }
  if (
    combinedText.includes("contract") ||
    combinedText.includes("temporary") ||
    combinedText.includes("fixed-term")
  ) {
    return "CONTRACT";
  }
  if (combinedText.includes("part time") || combinedText.includes("part-time")) {
    return "PART_TIME";
  }

  return "FULL_TIME";
}

/**
 * Infer experience level from job title using keyword matching.
 *
 * Priority order (highest wins):
 *   EXECUTIVE  → director, head of, VP, chief, president
 *   LEAD       → lead, staff, principal, manager
 *   SENIOR     → senior, sr
 *   ENTRY      → intern, co-op, junior, jr, new grad, entry
 *   MID        → default (no qualifying keyword)
 *
 * Conservative: only fires on unambiguous title-level signals.
 * MID is the correct default for plain "Software Engineer" etc.
 */
function inferExperienceLevel(title: string): ExperienceLevel | null {
  const t = title.toLowerCase();

  // EXECUTIVE: director-level and above
  if (
    /\b(director|head of|vice president|vp|chief|president)\b/.test(t)
  ) {
    return "EXECUTIVE";
  }

  // LEAD: team/tech lead, staff engineer, principal, engineering manager
  if (
    /\b(staff|principal|tech lead|team lead|engineering manager|design manager|lead)\b/.test(t)
  ) {
    return "LEAD";
  }

  // SENIOR: explicit seniority keyword
  if (/\b(senior|sr)\b/.test(t)) {
    return "SENIOR";
  }

  // ENTRY: intern, co-op, junior, new grad, entry-level
  if (
    /\b(intern|internship|co-op|coop|junior|jr|new grad|new-grad|entry[- ]level|entry)\b/.test(t)
  ) {
    return "ENTRY";
  }

  // Default: mid-level (no seniority qualifier = standard individual contributor)
  return "MID";
}

function buildShortSummary(
  title: string,
  company: string,
  workMode: WorkMode,
  description: string
) {
  // Find the first substantive sentence: skip blank lines, ALL-CAPS section
  // headers (e.g. "ABOUT THE ROLE"), and lines shorter than 20 chars.
  const lines = description
    .split(/\n/)
    .map((line) => sanitizeSummaryLine(line))
    .filter(Boolean);
  const SECTION_HEADER_RE = /^[A-Z][A-Z\s&'/():-]{3,}$|^#{1,3}\s/;
  const BOILERPLATE_RE = /^(equal opportunity|we are an? |disclaimer|eoe|accommodation|diversity|note to|about us$|about the company$)/i;
  let firstSentence = "";
  for (const line of lines) {
    if (line.length < 20) continue;
    if (SECTION_HEADER_RE.test(line)) continue;
    if (BOILERPLATE_RE.test(line)) continue;
    // Take up to first sentence boundary
    const sentenceEnd = line.search(/[.!?]/);
    firstSentence = sentenceEnd > 0 ? line.slice(0, sentenceEnd + 1).trim() : line;
    break;
  }
  if (!firstSentence) firstSentence = `${company} is hiring for ${title}.`;

  const modeSummary =
    workMode === "REMOTE"
      ? "Remote-friendly."
      : workMode === "HYBRID"
        ? "Hybrid schedule."
        : workMode === "FLEXIBLE"
          ? "Flexible work arrangement."
          : "On-site expectation.";

  return compactWhitespace(`${firstSentence} ${modeSummary}`).slice(0, 280);
}

function sanitizeSummaryLine(line: string) {
  const withoutLeadingBullets = line.replace(/^[\s>*•\-–—]+/, "").trim();
  const withoutUrls = withoutLeadingBullets
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ");

  return compactWhitespace(withoutUrls);
}

/**
 * Sanitize raw description text, preserving paragraph structure.
 *
 * For HTML sources (Greenhouse, Lever): converts block-level tags to newlines
 * before stripping all remaining HTML, so <p>, <li>, <h2> etc. become breaks.
 *
 * For plain-text sources (Ashby descriptionPlainText): the existing newlines
 * are already meaningful — we just compact within-line spaces.
 *
 * Output: newlines preserved, spaces within lines compacted, max 2 consecutive
 * blank lines, no leading/trailing whitespace.
 */
function sanitizeText(value: string) {
  const decoded = decodeHtmlEntities(value);
  // Convert block-level HTML element boundaries to paragraph breaks
  const withBreaks = decoded
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|h[1-6]|li|ul|ol|blockquote)[^>]*>/gi, "\n");
  // Strip remaining HTML tags (inline elements, etc.)
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  // Compact horizontal whitespace within each line, but preserve newlines
  const lines = stripped.split(/\n/);
  const cleaned = lines.map((line) => line.replace(/[ \t]+/g, " ").trim());
  // Join back, collapsing 3+ consecutive blank lines to 2
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
