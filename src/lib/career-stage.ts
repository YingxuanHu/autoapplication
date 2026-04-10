import type { EmploymentType, ExperienceLevel } from "@/generated/prisma/client";

export type CareerStageFilter =
  | "INTERNSHIP"
  | "ENTRY_LEVEL"
  | "ASSOCIATE"
  | "SENIOR_LEVEL"
  | "ADMINISTRATIVE_SUPPORT";

type CareerStageSignals = {
  title: string;
  description?: string | null;
  employmentType?: EmploymentType | null;
  roleFamily?: string | null;
};

type StageDefinition = {
  titleKeywords: string[];
  descriptionKeywords: string[];
  roleFamilyKeywords?: string[];
  employmentTypes?: EmploymentType[];
};

const INTERNSHIP_KEYWORDS = [
  "internship",
  "intern",
  "co-op",
  "co op",
  "coop",
  "summer student",
  "student intern",
  "student placement",
  "work term",
  "placement student",
];

const ENTRY_LEVEL_TITLE_KEYWORDS = [
  "entry-level",
  "entry level",
  "new grad",
  "new graduate",
  "recent graduate",
  "graduate program",
  "graduate role",
  "campus hire",
  "university hire",
  "early career",
  "apprentice",
  "trainee",
  "rotational program",
];

const ENTRY_LEVEL_DESCRIPTION_KEYWORDS = [
  ...ENTRY_LEVEL_TITLE_KEYWORDS,
  "no prior experience",
  "0-2 years",
  "0 to 2 years",
  "1-2 years",
  "1 to 2 years",
  "up to 2 years",
];

const ASSOCIATE_TITLE_KEYWORDS = [
  "associate",
  "junior",
  "jr.",
  " jr ",
  "associate-level",
  "junior-level",
  "junior level",
];

const ASSOCIATE_DESCRIPTION_KEYWORDS = [
  "associate level",
  "junior level",
  "junior-level",
  "2-4 years",
  "2 to 4 years",
  "3-5 years",
  "3 to 5 years",
];

const SENIOR_LEVEL_TITLE_KEYWORDS = [
  "senior",
  "sr.",
  " sr ",
  "staff",
  "principal",
  "lead",
  "manager",
  "supervisor",
  "head of",
  "director",
  "vice president",
  "vp ",
  " vp",
  "chief",
  "president",
];

const SENIOR_LEVEL_DESCRIPTION_KEYWORDS = [
  "senior-level",
  "leadership role",
  "leadership experience",
  "people management",
  "management experience",
  "5+ years",
  "6+ years",
  "7+ years",
  "8+ years",
  "10+ years",
];

const ADMIN_SUPPORT_TITLE_KEYWORDS = [
  "executive assistant",
  "administrative assistant",
  "administrative coordinator",
  "administrative specialist",
  "administrative support",
  "office manager",
  "office administrator",
  "office coordinator",
  "admin assistant",
  "receptionist",
  "scheduler",
];

const ADMIN_SUPPORT_DESCRIPTION_KEYWORDS = [
  "administrative support",
  "executive support",
  "calendar management",
  "travel arrangements",
  "expense reports",
  "office administration",
];

const EXECUTIVE_TITLE_KEYWORDS = [
  "chief",
  "vice president",
  "vp ",
  " vp",
  "president",
  "head of",
  "director",
];

const LEAD_TITLE_KEYWORDS = [
  "staff",
  "principal",
  "lead",
  "manager",
  "supervisor",
];

const SENIOR_TITLE_KEYWORDS = ["senior", "sr.", " sr "];
const MID_TITLE_KEYWORDS = ["mid", "mid-level", "mid level", "intermediate"];

export const CAREER_STAGE_DEFINITIONS: Record<CareerStageFilter, StageDefinition> = {
  INTERNSHIP: {
    titleKeywords: INTERNSHIP_KEYWORDS,
    descriptionKeywords: INTERNSHIP_KEYWORDS,
    employmentTypes: ["INTERNSHIP"],
  },
  ENTRY_LEVEL: {
    titleKeywords: ENTRY_LEVEL_TITLE_KEYWORDS,
    descriptionKeywords: ENTRY_LEVEL_DESCRIPTION_KEYWORDS,
  },
  ASSOCIATE: {
    titleKeywords: ASSOCIATE_TITLE_KEYWORDS,
    descriptionKeywords: ASSOCIATE_DESCRIPTION_KEYWORDS,
  },
  SENIOR_LEVEL: {
    titleKeywords: SENIOR_LEVEL_TITLE_KEYWORDS,
    descriptionKeywords: SENIOR_LEVEL_DESCRIPTION_KEYWORDS,
  },
  ADMINISTRATIVE_SUPPORT: {
    titleKeywords: ADMIN_SUPPORT_TITLE_KEYWORDS,
    descriptionKeywords: ADMIN_SUPPORT_DESCRIPTION_KEYWORDS,
    roleFamilyKeywords: ["administrative"],
  },
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function hasPositiveCareerStageSignals(
  stage: CareerStageFilter,
  { title, description, employmentType, roleFamily }: CareerStageSignals
) {
  const definition = CAREER_STAGE_DEFINITIONS[stage];
  const normalizedTitle = normalizeText(title);
  const normalizedDescription = normalizeText(description);
  const normalizedRoleFamily = normalizeText(roleFamily);

  if (definition.employmentTypes?.includes(employmentType ?? "FULL_TIME")) {
    return true;
  }

  if (
    definition.roleFamilyKeywords &&
    includesAny(normalizedRoleFamily, definition.roleFamilyKeywords)
  ) {
    return true;
  }

  if (includesAny(normalizedTitle, definition.titleKeywords)) {
    return true;
  }

  if (includesAny(normalizedDescription, definition.descriptionKeywords)) {
    return true;
  }

  return false;
}

export function matchesCareerStage(
  stage: CareerStageFilter,
  signals: CareerStageSignals
) {
  const internship = hasPositiveCareerStageSignals("INTERNSHIP", signals);
  const administrative = hasPositiveCareerStageSignals(
    "ADMINISTRATIVE_SUPPORT",
    signals
  );
  const senior = hasPositiveCareerStageSignals("SENIOR_LEVEL", signals);
  const associate = hasPositiveCareerStageSignals("ASSOCIATE", signals);
  const entry = hasPositiveCareerStageSignals("ENTRY_LEVEL", signals);

  switch (stage) {
    case "INTERNSHIP":
      return internship;
    case "ADMINISTRATIVE_SUPPORT":
      return administrative;
    case "SENIOR_LEVEL":
      return !internship && !administrative && senior;
    case "ASSOCIATE":
      return !internship && !administrative && !senior && associate;
    case "ENTRY_LEVEL":
      return !internship && !administrative && !senior && !associate && entry;
  }
}

export function normalizeCareerStageFilterValue(value?: string) {
  if (!value) return undefined;

  const normalized = value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .flatMap<CareerStageFilter>((entry) => {
      switch (entry) {
        case "INTERNSHIP":
          return ["INTERNSHIP"];
        case "ENTRY":
        case "ENTRY_LEVEL":
          return ["ENTRY_LEVEL"];
        case "MID":
        case "ASSOCIATE":
          return ["ASSOCIATE"];
        case "SENIOR":
        case "LEAD":
        case "EXECUTIVE":
        case "SENIOR_LEVEL":
          return ["SENIOR_LEVEL"];
        case "ADMINISTRATIVE_SUPPORT":
          return ["ADMINISTRATIVE_SUPPORT"];
        default:
          return [];
      }
    });

  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique.join(",") : undefined;
}

export function inferExperienceLevel(
  title: string,
  description?: string | null,
  employmentType?: EmploymentType | null,
  roleFamily?: string | null
): ExperienceLevel {
  const normalizedTitle = normalizeText(title);
  const normalizedDescription = normalizeText(description);
  const signals = {
    title,
    description,
    employmentType,
    roleFamily,
  } satisfies CareerStageSignals;

  if (matchesCareerStage("INTERNSHIP", signals)) {
    return "ENTRY";
  }

  if (
    includesAny(normalizedTitle, EXECUTIVE_TITLE_KEYWORDS) ||
    includesAny(normalizedDescription, ["executive leadership", "director-level"])
  ) {
    return "EXECUTIVE";
  }

  if (
    includesAny(normalizedTitle, LEAD_TITLE_KEYWORDS) ||
    includesAny(normalizedDescription, ["people management", "management experience"])
  ) {
    return "LEAD";
  }

  if (includesAny(normalizedTitle, SENIOR_TITLE_KEYWORDS)) {
    return "SENIOR";
  }

  if (
    matchesCareerStage("ENTRY_LEVEL", signals) ||
    matchesCareerStage("ASSOCIATE", signals)
  ) {
    return "ENTRY";
  }

  if (
    includesAny(normalizedTitle, MID_TITLE_KEYWORDS) ||
    includesAny(normalizedDescription, ["mid-level", "mid level", "intermediate level"])
  ) {
    return "MID";
  }

  return "UNKNOWN";
}
