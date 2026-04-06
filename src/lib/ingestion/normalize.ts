import type {
  EmploymentType,
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
import { resolveJobSalaryRange } from "@/lib/salary-extraction";
import { inferExperienceLevel } from "@/lib/career-stage";

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
  "montréal",
  "calgary",
  "ottawa",
  "waterloo",
  "mississauga",
  "markham",
  "quebec city",
  "saskatoon",
  "winnipeg",
  "hamilton",
  "burnaby",
  "surrey",
  "halifax",
  "edmonton",
  "regina",
  "kitchener",
  "london, on",
  "brampton",
  "scarborough",
  "richmond, bc",
  "laval",
  "longueuil",
  "gatineau",
  "sherbrooke",
  "barrie",
  "st. john",
  "thunder bay",
  "kelowna",
  "victoria, bc",
  "fredericton",
  "moncton",
  "charlottetown",
  "north york",
  "etobicoke",
  "kanata",
  "oakville",
  "burlington, on",
  "guelph",
  "saint-laurent",
  "dorval",
  "grande prairie",
  "red deer",
  "lethbridge",
  "nanaimo",
  "kamloops",
  "prince george",
  "saint john",
  "trois-rivières",
  "saguenay",
  "lévis",
  "terrebonne",
  "brossard",
  "repentigny",
  "newmarket",
  "richmond hill",
  "vaughan",
  "ajax",
  "whitby",
  "oshawa",
  "pickering",
  "cambridge, on",
  "kingston, on",
  "sudbury",
  "peterborough, on",
  "brantford",
  "st. catharines",
  "niagara falls, on",
  "chatham, on",
  "sarnia",
  "windsor, on",
  "coquitlam",
  "langley",
  "abbotsford",
  "new westminster",
  "north vancouver",
  "west vancouver",
  "delta, bc",
  "maple ridge",
  "chilliwack",
  "courtenay",
  "comox",
  "whistler",
  "squamish",
  "acheson",
];

const ROLE_PATTERNS: Array<{
  pattern: RegExp;
  industry: Industry;
  roleFamily: string;
}> = [
  // ── Tech roles ──────────────────────────────────────────────────────────────

  // Solutions Engineering: pre-sales / technical integration roles
  {
    pattern: /\b(solutions engineer|sales engineer|solutions consultant|pre-sales engineer|implementation engineer|integration engineer|customer engineer)\b/i,
    industry: "TECH",
    roleFamily: "Solutions Engineering",
  },
  // Solutions Architecture: broader architectural / implementation layer
  // Listed before SWE so "solutions architect" doesn't fall into the broad engineer match
  {
    pattern:
      /\b(solutions architect|enterprise architect|technical architect|cloud architect|staff architect|principal architect|resident engineer|infrastructure architect|security architect|network architect|data architect)\b/i,
    industry: "TECH",
    roleFamily: "Solutions Architecture",
  },
  // Product Management: PM and TPM (TPM is tightly scoped to avoid "program manager" noise)
  // "product management" (gerund) catches exec titles like "Director, Product Management"
  {
    pattern:
      /\b(product manager|product management|group product manager|senior product manager|staff product manager|principal product manager|technical program manager|program manager|tpm)\b/i,
    industry: "TECH",
    roleFamily: "Product Management",
  },
  // Project / Delivery Management: scrum, agile, release, delivery roles
  {
    pattern:
      /\b(project manager|scrum master|agile coach|release manager|delivery manager|project management|program management|pmo)\b/i,
    industry: "TECH",
    roleFamily: "Project Management",
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
    pattern: /\b(machine learning|ml engineer|data scientist|data science|applied scientist|ai engineer|artificial intelligence)\b/i,
    industry: "TECH",
    roleFamily: "Data Science",
  },
  // Data Engineering: pipeline / platform engineering (distinct from analyst/science)
  {
    pattern: /\b(data engineer|etl engineer|data pipeline engineer|data platform engineer|database engineer|database developer)\b/i,
    industry: "TECH",
    roleFamily: "Data Engineering",
  },
  // Data Analyst: analytics and BI
  {
    pattern:
      /\b(data analyst|analytics engineer|business intelligence|bi analyst|data analytics|bi developer|reporting analyst)\b/i,
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
    pattern: /\b(business analyst|business systems analyst|systems analyst)\b/i,
    industry: "TECH",
    roleFamily: "Business Analyst",
  },
  // Security
  {
    pattern: /\b(security|cybersecurity|cyber security)\b/i,
    industry: "TECH",
    roleFamily: "Security",
  },
  // QA / Test
  {
    pattern: /\b(qa|quality assurance|test automation|sdet|quality engineer|test engineer)\b/i,
    industry: "TECH",
    roleFamily: "QA",
  },
  // IT / Systems Administration: infrastructure operations, DBA, helpdesk
  {
    pattern:
      /\b(it manager|it director|it specialist|it analyst|it operations|systems administrator|system administrator|sysadmin|database administrator|dba|network administrator|help desk|helpdesk|it support|it technician|network engineer|infrastructure manager|it infrastructure)\b/i,
    industry: "TECH",
    roleFamily: "IT Operations",
  },
  // Marketing: tech marketing roles at tech companies — product marketing, growth, demand gen
  // Scoped to compound titles to avoid matching pure "marketing" which would catch non-tech roles.
  // Listed before Design and SWE to prevent "Growth Marketing Engineer" noise.
  {
    pattern:
      /\b(product marketing|growth marketing|performance marketing|content marketing|marketing manager|demand generation|marketing analyst|field marketing|digital marketing|brand marketing|marketing operations|lifecycle marketing|marketing lead|marketing director|marketing intern|marketing coordinator|marketing specialist|brand ambassador|marketer|marketing)\b/i,
    industry: "TECH",
    roleFamily: "Marketing",
  },
  // Technical Writing / Developer Relations: technical content and community roles
  {
    pattern:
      /\b(technical writer|developer relations|developer advocate|devrel|developer experience|documentation engineer|technical documentation|technical editor|community engineer)\b/i,
    industry: "TECH",
    roleFamily: "Technical Writing",
  },
  // Design: product/UX/brand/web design — must be listed before SWE to prevent
  // "Designer, Web & Brand" from matching the SWE catch-all via "web engineer"
  {
    pattern:
      /\b(designer|design lead|design director|ux design|ui design|product design|brand design|graphic design|visual design|interaction design|design manager|ux researcher)\b/i,
    industry: "TECH",
    roleFamily: "Design",
  },
  // Customer Success: technical customer-facing roles at tech companies
  {
    pattern:
      /\b(customer success|customer success manager|customer success engineer|technical account manager|technical support engineer|support engineer|customer engineer|implementation consultant|onboarding specialist)\b/i,
    industry: "TECH",
    roleFamily: "Customer Success",
  },
  // SWE: broad engineering catch-all — listed last among tech so specific roles above take priority
  // "web" is scoped to "web engineer|web developer" to avoid matching design/content titles.
  // "platform" is also scoped to engineering-specific phrases so business titles like
  // "Platform Partnerships" or "Platform Growth" do not slip into the engineering pool.
  {
    pattern:
      /\b(software|frontend|front-end|back\s*end|back-end|full[- ]stack|platform engineer|platform engineering|platform developer|mobile|ios|android|devops|dev ops|site reliability|sre|web engineer|web developer|cloud engineer|infrastructure engineer|systems engineer|reliability engineer|build engineer|release engineer|automation engineer|engineer|engineering manager|dx engineer|content engineer|design engineer|embedded|firmware|developer|développeur|ingénieur(?:\s+logiciel)?)\b/i,
    industry: "TECH",
    roleFamily: "SWE",
  },

  // ── Finance roles ────────────────────────────────────────────────────────────

  {
    pattern: /\b(financial analyst|corporate finance|finance analyst|treasury|finance manager|finance director|controller|comptroller)\b/i,
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
  // Accounting: accountants, auditors, tax specialists
  {
    pattern:
      /\b(accountant|accounting|accounting manager|fund accountant|tax analyst|tax manager|auditor|audit manager|bookkeeper|accounts payable|accounts receivable|cpa)\b/i,
    industry: "FINANCE",
    roleFamily: "Accounting",
  },
  // Quantitative / Trading: quants, traders, portfolio management
  {
    pattern:
      /\b(quantitative analyst|quant analyst|quant developer|quantitative developer|quantitative researcher|quant researcher|trader|trading analyst|trading desk|portfolio manager|portfolio analyst|fund manager|asset manager|investment analyst)\b/i,
    industry: "FINANCE",
    roleFamily: "Quantitative Finance",
  },
  // Actuarial / Insurance: actuaries, underwriters, claims
  {
    pattern:
      /\b(actuary|actuarial|underwriter|underwriting|claims analyst|insurance analyst|loss adjuster)\b/i,
    industry: "FINANCE",
    roleFamily: "Actuarial",
  },
  {
    pattern: /\b(investment banking|investment bank)\b/i,
    industry: "FINANCE",
    roleFamily: "Investment Banking",
  },
  // Lending / Banking: loan officers, mortgage, banking operations
  {
    pattern:
      /\b(loan officer|mortgage|loan analyst|credit analyst|banking|banker|bank manager|branch manager|teller|relationship manager|commercial banker|private banker|personal banker)\b/i,
    industry: "FINANCE",
    roleFamily: "Banking",
  },
  {
    pattern: /\b(risk)\b/i,
    industry: "FINANCE",
    roleFamily: "Risk",
  },
  {
    pattern: /\b(compliance|aml|anti-money laundering|kyc|know your customer|regulatory)\b/i,
    industry: "FINANCE",
    roleFamily: "Compliance",
  },
  {
    pattern: /\b(credit)\b/i,
    industry: "FINANCE",
    roleFamily: "Credit",
  },
  {
    pattern: /\b(wealth management|wealth|financial advisor|financial planner|financial planning)\b/i,
    industry: "FINANCE",
    roleFamily: "Wealth Management",
  },
  // Operations: finance/tech ops; biz ops at tech companies is also captured here
  {
    pattern: /\b(operations analyst|biz ops|bizops|business operations|operations manager|operations director|operations)\b/i,
    industry: "FINANCE",
    roleFamily: "Operations",
  },

  // ── Cross-industry roles ──────────────────────────────────────────────────────

  // Sales & Revenue: direct revenue-generating roles
  {
    pattern:
      /\b(account executive|sales manager|sales director|sales representatives?|sales lead|inside sales|outside sales|sales operations|revenue manager|revenue operations|sales development|sdr\b|bdr\b|business development representative|enterprise sales|regional sales|national sales|sales analyst|sales enablement|channel sales|partner sales|sales consultant|inbound sales|sales executive|sales team|sales trainer|vendeur|vendeuse|ventes|représentant.*ventes?)\b/i,
    industry: "TECH",
    roleFamily: "Sales",
  },
  // Business Development: partnerships, strategic BD
  {
    pattern:
      /\b(business development|partnerships manager|partnerships director|strategic partnerships|partner manager|alliances manager|channel manager|bd manager)\b/i,
    industry: "TECH",
    roleFamily: "Business Development",
  },
  // Consulting / Advisory: professional services, management consulting
  {
    pattern:
      /\b(consultant|consulting|advisory|practice lead|practice manager|engagement manager|managing consultant|principal consultant|senior consultant)\b/i,
    industry: "TECH",
    roleFamily: "Consulting",
  },
  // Legal: corporate legal, contracts, IP, regulatory counsel
  {
    pattern:
      /\b(attorney|lawyer|counsel|general counsel|paralegal|legal analyst|legal operations|legal manager|contracts manager|contract manager|ip counsel|corporate counsel|legal director)\b/i,
    industry: "FINANCE",
    roleFamily: "Legal",
  },
  // Supply Chain / Procurement: sourcing, logistics, procurement
  {
    pattern:
      /\b(supply chain|procurement|purchasing|logistics manager|logistics analyst|sourcing manager|sourcing analyst|inventory manager|demand planner|supply planner|materials manager|vendor manager)\b/i,
    industry: "TECH",
    roleFamily: "Supply Chain",
  },
  // Communications / PR: corporate communications and public relations
  {
    pattern:
      /\b(communications manager|communications director|public relations|pr manager|corporate communications|internal communications|media relations|investor relations)\b/i,
    industry: "TECH",
    roleFamily: "Communications",
  },
  // Administrative / Executive Support: EA, office management
  {
    pattern:
      /\b(executive assistant|administrative assistant|office manager|office administrator|chief of staff|admin assistant|administrative coordinator)\b/i,
    industry: "TECH",
    roleFamily: "Administrative",
  },

  // Technical / Engineering (non-software): inspectors, lab techs, QC, environmental
  {
    pattern:
      /\b(quality inspector|quality control|environmental.*(?:analyst|monitor|specialist|engineer)|lab(?:oratory)?\s+(?:technician|analyst|assistant)|test(?:er|ing)\b|quality assurance.*(?:analyst|inspector)|maintenance.*(?:engineer|leader|manager|technician)|plant.*(?:manager|engineer)|controls\s+(?:engineer|technician)|field\s+(?:engineer|technician)|process\s+engineer|chemical\s+engineer|mechanical\s+(?:engineer|designer)|electrical\s+engineer|civil\s+engineer|structural\s+engineer|manufacturing\s+engineer|industrial\s+engineer|biostatistic|statistician|scientist|researcher|research\s+(?:analyst|assistant|associate)|webmestre|webmaster)\b/i,
    industry: "TECH",
    roleFamily: "Technical",
  },
  // Internships / Co-ops / Students (tech and finance focused)
  {
    pattern:
      /\b(intern\b|internship|co-?op\b|stagiaire|summer\s+student|work\s+(?:term|placement))\b/i,
    industry: "TECH",
    roleFamily: "Internship",
  },

  // ── General Professional catch-all ─────────────────────────────────────────────
  // Matches any remaining title with common professional keywords.
  // Listed LAST so specific families above always take priority.
  // This captures the long tail of legitimate business roles at tech/finance companies.
  {
    pattern:
      /\b(manager|director|analyst|coordinator|specialist|advisor|officer|lead\b|head of|vp\b|vice president|associate|supervisor|administrator|strategist|planner|representative|clerk|technologist|receptionist|technician|assistant|operator|programmer|buyer|reviewer|trainer|consultant|executive|gestionnaire|analyste|conseill(?:er|ère)|comptable|responsable|coordonnateur|coordonnatrice|technicien(?:ne)?|agent(?:e)?|préposé|commis|adjoint(?:e)?|directeur|directrice|gérant(?:e)?|courtier|inspecteur|opérateur|webmestre|merchant|ambassador)\b/i,
    industry: "TECH",
    roleFamily: "General Professional",
  },
];

const EXCLUDED_TITLE_PATTERNS = [
  // Recruiting / HR
  /\b(recruiter|recruiting coordinator|recruiting ops|talent acquisition|technical recruiter|sourcer)\b/i,
  /\b(people partner|people operations|people ops|hr business partner|human resources)\b/i,
  // Healthcare / Medical
  /\b(registered nurse|\bRN\b|nurse practitioner|nursing|physician|surgeon|medical director|pharmacist|pharmacy|dental|dentist|veterinar|therapist|physiotherapist|occupational therapist|radiolog|pathologist|optometrist|chiropract|paramedic|midwife|phlebotom|sonograph|respiratory|speech.lang|audiolog|dietitian|nutritionist|oncology|hematology|cardiolog|neurolog|dermatolog|psychiatr|anesthesi|medical science liaison|clinical research associate|clinical nurse)\b/i,
  // Trades / Manual labour
  /\b(mechanic|electrician|plumber|welder|carpenter|painter|roofer|mason|hvac|installer(?!\s+(?:software|engineer))|pipefitter|millwright|machinist|sheet metal|ironworker|boilermaker|glazier|drywall|framing)\b/i,
  // Driving / Transportation
  /\b(cdl|truck driver|bus driver|delivery driver|forklift|warehouse associate|sorter|picker|packer)\b/i,
  // Childcare / Domestic
  /\b(babysitter|nanny|caregiver|childcare|au pair)\b/i,
  // Food service / Retail frontline
  /\b(barista|server|cook\b|chef\b|dishwasher|busser|bartender|cashier|stocker|grocery)\b/i,
  // Education (non-tech)
  /\b(teacher|professor|lecturer|tutor(?!ial)|principal(?!\s+(?:engineer|architect|consultant|analyst|developer|scientist|designer|manager|director|swe|technical|planning|product|data|security|program|software|cloud|platform|solutions|financial|investment))|superintendent|librarian|dean\b|provost)\b/i,
  // Skilled trades / Construction
  /\b(crane operator|heavy equipment|excavat|concrete|paving|asphalt|demolition|scaffolding|surveyor)\b/i,
  // Law enforcement / Emergency / Military (not corporate security)
  /\b(police|sheriff|firefighter|paramedic|corrections officer|probation officer|dispatch(?!er\b.*(?:software|tech|logistics)))\b/i,
  // Agriculture / Outdoors
  /\b(farm worker|rancher|horticultur|arborist|landscap|groundskeeper)\b/i,
  // French healthcare / trades / manual exclusions
  /\b(infirmi(?:er|ère)|médecin|chirurgien|pharmacien|dentiste|vétérinaire|ambulancier|sage-femme|préposé aux bénéficiaires|aide-soignant|ouvrier|soudeur|mécanicien|électricien|plombier|charpentier|camionneur|chauffeur(?:\s+de\s+camion)?|enseignant|professeur|journalier|manoeuvre|assembleur|magasinier|opérateur de machinerie|éducateur.*petite enfance|ajusteur|monteur d'avions)\b/i,
  // General spam / non-job patterns
  /\b(door\s+to\s+door|brand\s+ambassador.*activation|remote\s+recruiter.*\$\d|personal\s+development\s+sales)\b/i,
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
  const experienceLevel = inferExperienceLevel(
    title,
    description,
    employmentType,
    roleProfile.roleFamily
  );
  const postedAt = job.postedAt ?? fetchedAt;
  const deadline =
    job.deadline && job.deadline.getTime() > fetchedAt.getTime() ? job.deadline : null;
  const resolvedSalary = resolveJobSalaryRange({
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    description,
    regionHint: region,
  });
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
    salaryMin: resolvedSalary.salaryMin,
    salaryMax: resolvedSalary.salaryMax,
    salaryCurrency: resolvedSalary.salaryCurrency,
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
    normalizedLocation.includes("AMERICAS") ||
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
  const secondTrailingPart = parts[parts.length - 2] ?? "";

  // Structured ATS feeds often emit Canadian locations as "City, BC, CA".
  // Treat the province + trailing country pair as Canada before the lone "CA"
  // token can be misread as California.
  if (trailingPart === "CA" && CA_PROVINCE_CODES.has(secondTrailingPart)) {
    return "CA";
  }

  // Handle trailing country codes: "City, STATE, US" or "City, PROVINCE, CA"
  // Many ATS feeds (Workday, iCIMS, etc.) append country code after state/province.
  if (
    (trailingPart === "US" || trailingPart === "USA") &&
    US_STATE_CODES.has(secondTrailingPart)
  ) {
    return "US";
  }
  if (trailingPart === "CANADA" && CA_PROVINCE_CODES.has(secondTrailingPart)) {
    return "CA";
  }

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
      if (
        normalizedLocation.includes("WORLDWIDE") ||
        normalizedLocation.includes("ANYWHERE") ||
        normalizedLocation === "GLOBAL" ||
        normalizedLocation.includes("NORTH AMERICA") ||
        normalizedLocation.includes("AMERICAS") ||
        normalizedLocation.includes("CANADA") ||
        normalizedLocation.includes("US & CANADA") ||
        normalizedLocation.includes("US/CANADA") ||
        normalizedLocation.includes("US AND CANADA")
      ) {
        return "CA";
      }
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
