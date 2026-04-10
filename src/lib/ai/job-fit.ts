/**
 * AI-powered job fit analysis.
 *
 * Given a job and a user profile, returns a structured fit assessment:
 * score, matching skills, gaps, strengths, and a brief narrative.
 */
import { aiComplete } from "./provider";
import type { FitAnalysis } from "./types";

export type JobContext = {
  title: string;
  company: string;
  location: string;
  workMode: string;
  experienceLevel: string | null;
  roleFamily: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  description: string;
};

export type ProfileContext = {
  headline: string | null;
  summary: string | null;
  fullName: string | null;
  location: string | null;
  linkedInUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  skills: string[];
  skillsText: string | null;
  experienceLevel: string | null;
  experiences: Array<{
    title: string;
    time: string;
    company: string;
    location: string;
    description: string;
  }>;
  experienceText: string | null;
  educations: Array<{
    school: string;
    degree: string;
    time: string;
    location: string;
    description: string;
  }>;
  educationText: string | null;
  projects: Array<{
    name: string;
    title: string;
    time: string;
    location: string;
    description: string;
  }>;
  projectsText: string | null;
  workAuthorization: string | null;
  preferredWorkMode: string | null;
};

export type { FitAnalysis } from "./types";

const SYSTEM_PROMPT = `You are a career advisor and expert recruiter analyzing job-profile fit. Return ONLY valid JSON.

Analyze how well the user's profile matches the job, considering:
- Skills alignment (required vs. possessed)
- Experience level match
- Role family / function match
- Work mode preferences
- Any clear blockers or standout strengths
- The full saved profile context, including headline, summary, skills, experience, education, projects, and profile details

Return this exact JSON shape:
{
  "score": number (1-10, be realistic not generous),
  "tier": "strong" | "good" | "moderate" | "weak",
  "summary": "2-3 sentence narrative explaining the fit",
  "strengths": ["bullet 1", "bullet 2", ...],
  "gaps": ["gap 1", "gap 2", ...],
  "keywords": ["keyword1", "keyword2", ...]
}

Scoring guide: 8-10 = strong match, 6-7 = good fit, 4-5 = moderate, 1-3 = weak.
Be specific and actionable. Max 4 items per array.
Write all visible explanation text in second person. Use "you" and "your", never "the candidate".
Base the analysis on the entire profile context provided below. Do not narrow it to a single resume snapshot or only the currently linked resume.`;

export async function analyzeJobFit(
  job: JobContext,
  profile: ProfileContext
): Promise<FitAnalysis> {
  const profileText = buildProfileText(profile);
  const jobText = buildJobText(job);

  const raw = await aiComplete({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `JOB:\n${jobText}\n\nYOUR PROFILE:\n${profileText}`,
      },
    ],
    modelFlavor: "standard",
    maxTokens: 1024,
    temperature: 0,
  });

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

  return normalizeFit(parsed);
}

function buildJobText(job: JobContext): string {
  const lines = [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location} (${job.workMode})`,
    `Role family: ${job.roleFamily}`,
  ];
  if (job.experienceLevel) lines.push(`Experience level: ${job.experienceLevel}`);
  if (job.salaryMin || job.salaryMax) {
    const range = [job.salaryMin, job.salaryMax].filter(Boolean).join("–");
    lines.push(`Salary: ${range} ${job.salaryCurrency ?? "USD"}`);
  }
  lines.push(`\nDescription:\n${job.description.slice(0, 3000)}`);
  return lines.join("\n");
}

function buildProfileText(profile: ProfileContext): string {
  const lines: string[] = [];
  if (profile.fullName) lines.push(`Name: ${profile.fullName}`);
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.summary) lines.push(`Summary: ${profile.summary}`);
  if (profile.location) lines.push(`Location: ${profile.location}`);
  if (profile.experienceLevel) lines.push(`Level: ${profile.experienceLevel}`);
  if (profile.workAuthorization) lines.push(`Work auth: ${profile.workAuthorization}`);
  if (profile.preferredWorkMode) lines.push(`Preferred mode: ${profile.preferredWorkMode}`);
  if (profile.skills.length > 0) lines.push(`Skills: ${profile.skills.join(", ")}`);
  else if (profile.skillsText?.trim()) lines.push(`Skills: ${profile.skillsText}`);

  const links = [
    profile.linkedInUrl ? `LinkedIn: ${profile.linkedInUrl}` : null,
    profile.githubUrl ? `GitHub: ${profile.githubUrl}` : null,
    profile.portfolioUrl ? `Portfolio: ${profile.portfolioUrl}` : null,
  ].filter((value): value is string => Boolean(value));
  if (links.length > 0) {
    lines.push(...links);
  }

  if (profile.experiences.length > 0) {
    lines.push("\nExperience:");
    for (const e of profile.experiences.slice(0, 6)) {
      const headline = [e.title, e.company ? `@ ${e.company}` : ""]
        .filter(Boolean)
        .join(" ");
      const details = [e.time, e.location].filter(Boolean).join(" | ");
      lines.push(`  • ${headline || "Experience entry"}`);
      if (details) lines.push(`    ${details}`);
      if (e.description) lines.push(`    ${e.description.slice(0, 200)}`);
    }
  }
  if (profile.experienceText?.trim()) {
    lines.push(`\nExperience details:\n${profile.experienceText.slice(0, 1800)}`);
  }

  if (profile.educations.length > 0) {
    lines.push("\nEducation:");
    for (const e of profile.educations.slice(0, 4)) {
      const headline = [e.degree, e.school ? `@ ${e.school}` : ""]
        .filter(Boolean)
        .join(" ");
      const details = [e.time, e.location].filter(Boolean).join(" | ");
      lines.push(`  • ${headline || e.school || "Education entry"}`);
      if (details) lines.push(`    ${details}`);
      if (e.description) lines.push(`    ${e.description.slice(0, 180)}`);
    }
  }
  if (profile.educationText?.trim()) {
    lines.push(`\nEducation details:\n${profile.educationText.slice(0, 1200)}`);
  }

  if (profile.projects.length > 0) {
    lines.push("\nProjects:");
    for (const project of profile.projects.slice(0, 5)) {
      const headline = [project.name, project.title].filter(Boolean).join(" | ");
      const details = [project.time, project.location].filter(Boolean).join(" | ");
      lines.push(`  • ${headline || "Project"}`);
      if (details) lines.push(`    ${details}`);
      if (project.description) lines.push(`    ${project.description.slice(0, 220)}`);
    }
  }
  if (profile.projectsText?.trim()) {
    lines.push(`\nProject details:\n${profile.projectsText.slice(0, 1400)}`);
  }

  return lines.join("\n");
}

function normalizeFit(data: unknown): FitAnalysis {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid AI response shape");
  }
  const d = data as Record<string, unknown>;
  const score = typeof d.score === "number" ? Math.min(10, Math.max(1, Math.round(d.score))) : 5;
  const tier = ["strong", "good", "moderate", "weak"].includes(d.tier as string)
    ? (d.tier as FitAnalysis["tier"])
    : scoreTier(score);

  return {
    score,
    tier,
    summary: typeof d.summary === "string" ? d.summary : "Analysis unavailable.",
    strengths: strArr(d.strengths),
    gaps: strArr(d.gaps),
    keywords: strArr(d.keywords),
  };
}

function scoreTier(score: number): FitAnalysis["tier"] {
  if (score >= 8) return "strong";
  if (score >= 6) return "good";
  if (score >= 4) return "moderate";
  return "weak";
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string");
}
