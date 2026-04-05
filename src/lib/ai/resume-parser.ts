/**
 * AI-powered resume text → structured profile data extraction.
 *
 * Takes raw text extracted from a PDF/DOCX resume and returns
 * structured profile fields that can be merged into UserProfile.
 */
import { aiComplete } from "./provider";
import type {
  ProfileExperience,
  ProfileEducation,
  ProfileProject,
} from "@/types/profile";

/** The structured result returned by the AI parser. */
export type ParsedResumeData = {
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  skills: string[];
  experiences: ProfileExperience[];
  educations: ProfileEducation[];
  projects: ProfileProject[];
};

const SYSTEM_PROMPT = `You are a precise resume parser. Given raw text extracted from a resume document, extract structured data into a JSON object.

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation.
- Use null for fields that are not found in the resume.
- Use empty arrays [] when a section has no entries.
- For dates, use the format found in the resume (e.g. "Jan 2022", "2022-01", "2022"). Use "Present" for current positions.
- For skills, extract individual skill names as strings.
- For URLs, extract full URLs including https://.
- The headline should be a short professional title (e.g. "Senior Software Engineer").
- The summary should be 1-3 sentences summarizing the candidate's profile.
- Be thorough: extract ALL experiences, educations, and projects listed.

Return this exact JSON shape:
{
  "name": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "headline": string | null,
  "summary": string | null,
  "linkedinUrl": string | null,
  "githubUrl": string | null,
  "portfolioUrl": string | null,
  "skills": string[],
  "experiences": [{ "title": string, "company": string, "location": string, "startDate": string, "endDate": string, "description": string }],
  "educations": [{ "school": string, "degree": string, "field": string, "startDate": string, "endDate": string, "description": string }],
  "projects": [{ "name": string, "url": string, "description": string, "technologies": string }]
}`;

/**
 * Parse resume text into structured profile data using AI.
 * Throws if AI is unavailable or parsing fails.
 */
export async function parseResumeText(
  text: string
): Promise<ParsedResumeData> {
  // Truncate extremely long resumes to avoid token limits
  const trimmed = text.slice(0, 15000);

  const raw = await aiComplete({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Parse the following resume text:\n\n${trimmed}`,
      },
    ],
    maxTokens: 4096,
    temperature: 0,
  });

  // Strip any markdown fences the model might add despite instructions
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`AI returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  return normalize(parsed);
}

/** Normalize and validate the AI response into our expected shape. */
function normalize(data: unknown): ParsedResumeData {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI returned non-object response");
  }

  const d = data as Record<string, unknown>;

  return {
    name: str(d.name),
    email: str(d.email),
    phone: str(d.phone),
    location: str(d.location),
    headline: str(d.headline),
    summary: str(d.summary),
    linkedinUrl: str(d.linkedinUrl),
    githubUrl: str(d.githubUrl),
    portfolioUrl: str(d.portfolioUrl),
    skills: strArr(d.skills),
    experiences: arrOf(d.experiences, normalizeExperience),
    educations: arrOf(d.educations, normalizeEducation),
    projects: arrOf(d.projects, normalizeProject),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

function arrOf<T>(v: unknown, fn: (item: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  return v.map(fn).filter((x): x is T => x !== null);
}

function normalizeExperience(v: unknown): ProfileExperience | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  return {
    title: str(e.title) ?? "",
    company: str(e.company) ?? "",
    location: str(e.location) ?? "",
    startDate: str(e.startDate) ?? "",
    endDate: str(e.endDate) ?? "",
    description: str(e.description) ?? "",
  };
}

function normalizeEducation(v: unknown): ProfileEducation | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  return {
    school: str(e.school) ?? "",
    degree: str(e.degree) ?? "",
    field: str(e.field) ?? "",
    startDate: str(e.startDate) ?? "",
    endDate: str(e.endDate) ?? "",
    description: str(e.description) ?? "",
  };
}

function normalizeProject(v: unknown): ProfileProject | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  return {
    name: str(e.name) ?? "",
    url: str(e.url) ?? "",
    description: str(e.description) ?? "",
    technologies: str(e.technologies) ?? "",
  };
}
