/**
 * AI cover letter generation.
 *
 * Produces a concise, professional cover letter tailored to a specific job
 * and the candidate's profile. ~3 paragraphs, no filler.
 */
import { aiComplete } from "./provider";
import type { JobContext, ProfileContext } from "./job-fit";

export type CoverLetterResult = {
  text: string; // The cover letter body (no salutation line — caller adds)
  wordCount: number;
};

const SYSTEM_PROMPT = `You are a professional career writer. Write a concise, targeted cover letter body for a job application.

Rules:
- 3 short paragraphs: why this role, what you bring, call to action
- No generic filler ("I am writing to apply...", "Please find attached...")
- Specific — reference the company name, role, and 1-2 concrete achievements
- Confident and direct tone
- 150–250 words total
- Do NOT include a salutation, date, address, or closing signature
- Return ONLY the cover letter body text, no JSON, no markdown`;

export async function generateCoverLetter(
  job: JobContext,
  profile: ProfileContext
): Promise<CoverLetterResult> {
  const profileText = buildProfileText(profile);

  const text = await aiComplete({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Write a cover letter for this position:\n\nROLE: ${job.title} at ${job.company} (${job.location}, ${job.workMode})\n\nJOB DESCRIPTION:\n${job.description.slice(0, 2000)}\n\nCANDIDATE PROFILE:\n${profileText}`,
      },
    ],
    modelFlavor: "standard",
    maxTokens: 512,
    temperature: 0.4,
  });

  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  return { text: trimmed, wordCount };
}

function buildProfileText(profile: ProfileContext): string {
  const lines: string[] = [];
  if (profile.headline) lines.push(`Title: ${profile.headline}`);
  if (profile.summary) lines.push(`Summary: ${profile.summary}`);
  if (profile.skills.length > 0) lines.push(`Skills: ${profile.skills.slice(0, 20).join(", ")}`);

  if (profile.experiences.length > 0) {
    lines.push("Recent experience:");
    for (const e of profile.experiences.slice(0, 3)) {
      lines.push(`  • ${e.title} at ${e.company}`);
      if (e.description) lines.push(`    ${e.description.slice(0, 200)}`);
    }
  }

  if (profile.educations.length > 0) {
    const edu = profile.educations[0];
    lines.push(`Education: ${edu.degree} in ${edu.field} at ${edu.school}`);
  }

  return lines.join("\n");
}
