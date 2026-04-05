/**
 * AI-powered job fit analysis.
 *
 * Given a job and a user profile, returns a structured fit assessment:
 * score, matching skills, gaps, strengths, and a brief narrative.
 */
import { aiComplete } from "./provider";

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
  skills: string[];
  experienceLevel: string | null;
  experiences: Array<{
    title: string;
    company: string;
    startDate: string;
    endDate: string;
    description: string;
  }>;
  educations: Array<{
    school: string;
    degree: string;
    field: string;
  }>;
  workAuthorization: string | null;
  preferredWorkMode: string | null;
};

export type FitAnalysis = {
  score: number; // 1–10
  tier: "strong" | "good" | "moderate" | "weak";
  summary: string; // 2–3 sentence narrative
  strengths: string[]; // what the candidate has that matches
  gaps: string[]; // missing requirements or concerns
  keywords: string[]; // key terms from JD to include in application
};

const SYSTEM_PROMPT = `You are a career advisor and expert recruiter analyzing job-candidate fit. Return ONLY valid JSON.

Analyze how well the candidate's profile matches the job, considering:
- Skills alignment (required vs. possessed)
- Experience level match
- Role family / function match
- Work mode preferences
- Any clear blockers or standout strengths

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
Be specific and actionable. Max 4 items per array.`;

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
        content: `JOB:\n${jobText}\n\nCANDIDATE:\n${profileText}`,
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
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.summary) lines.push(`Summary: ${profile.summary}`);
  if (profile.experienceLevel) lines.push(`Level: ${profile.experienceLevel}`);
  if (profile.workAuthorization) lines.push(`Work auth: ${profile.workAuthorization}`);
  if (profile.preferredWorkMode) lines.push(`Preferred mode: ${profile.preferredWorkMode}`);
  if (profile.skills.length > 0) lines.push(`Skills: ${profile.skills.join(", ")}`);

  if (profile.experiences.length > 0) {
    lines.push("\nExperience:");
    for (const e of profile.experiences.slice(0, 5)) {
      lines.push(`  • ${e.title} @ ${e.company} (${e.startDate}–${e.endDate})`);
      if (e.description) lines.push(`    ${e.description.slice(0, 200)}`);
    }
  }

  if (profile.educations.length > 0) {
    lines.push("\nEducation:");
    for (const e of profile.educations.slice(0, 3)) {
      lines.push(`  • ${e.degree} in ${e.field} @ ${e.school}`);
    }
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
