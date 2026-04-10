// ─── Structured profile JSON shapes ──────────────────────────────────────────
// These types define the shape of the JSON fields stored in UserProfile.
// They're used for display, editing, AI ingestion, and auto-apply field mapping.

export type ProfileExperience = {
  title: string;
  company: string;
  location: string;
  startDate: string;
  endDate: string;
  description: string;
};

export type ProfileEducation = {
  school: string;
  degree: string;
  field: string;
  startDate: string;
  endDate: string;
  description: string;
};

export type ProfileProject = {
  name: string;
  url: string;
  description: string;
  technologies: string;
};

// ─── Parsing helpers ────────────────────────────────────────────────────────
// These safely parse the Json fields from Prisma into typed arrays.

export function parseSkills(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((s): s is string => typeof s === "string");
}

export function parseExperiences(json: unknown): ProfileExperience[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isExperience);
}

export function parseEducations(json: unknown): ProfileEducation[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isEducation);
}

export function parseProjects(json: unknown): ProfileProject[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isProject);
}

function isExperience(v: unknown): v is ProfileExperience {
  return typeof v === "object" && v !== null && "title" in v && "company" in v;
}

function isEducation(v: unknown): v is ProfileEducation {
  return typeof v === "object" && v !== null && "school" in v;
}

function isProject(v: unknown): v is ProfileProject {
  return typeof v === "object" && v !== null && "name" in v;
}

// ─── Empty entry factories ──────────────────────────────────────────────────

export function emptyExperience(): ProfileExperience {
  return { title: "", company: "", location: "", startDate: "", endDate: "", description: "" };
}

export function emptyEducation(): ProfileEducation {
  return { school: "", degree: "", field: "", startDate: "", endDate: "", description: "" };
}

export function emptyProject(): ProfileProject {
  return { name: "", url: "", description: "", technologies: "" };
}
