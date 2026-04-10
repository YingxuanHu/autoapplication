import { NextResponse } from "next/server";
import { zodResponseFormat } from "openai/helpers/zod";

import {
  UnauthorizedError,
  requireCurrentAuthUserId,
  requireCurrentUserProfile,
} from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { getOpenAIClient, getOpenAIReadiness, getReasoningModel, getStandardModel } from "@/lib/openai";
import type {
  ProfileContact,
  ProfileEducation,
  ProfileExperience,
  ProfileProject,
  ProfileSkill,
} from "@/lib/profile";
import {
  normalizeContact,
  normalizeEducations,
  normalizeExperiences,
  normalizeProjects,
  normalizeSkills,
} from "@/lib/profile";
import {
  compactTailoredResume,
  compileResumePdf,
  generateResumeTeX,
  looksLikeLatexDocument,
  stabilizeTeXSource,
  tailoredResumeSchema,
  truncateWords,
  type TailoredResume,
} from "@/lib/resume-generator";

type RouteParams = {
  params: Promise<{ id: string }>;
};

function normalizeChatMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        const part = item as { type?: unknown; text?: unknown };
        return part.type === "text" && typeof part.text === "string" ? part.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function stripCodeFences(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryParseTailoredResume(rawContent: string): TailoredResume | null {
  const cleaned = stripCodeFences(rawContent);
  const candidates = [cleaned];

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = tailoredResumeSchema.safeParse(parsed);
      if (validated.success) {
        return validated.data;
      }
    } catch {
      // Continue through fallbacks.
    }
  }

  return null;
}

function safeFileSegment(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "resume"
  );
}

function normalizeValue(value: unknown, maxLength = 400) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function uniqueStrings(values: string[], maxItems: number) {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const cleaned = normalizeValue(value, 200);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(cleaned);

    if (results.length >= maxItems) {
      break;
    }
  }

  return results;
}

function descriptionToBullets(value: string, maxItems = 5) {
  return uniqueStrings(
    value
      .split("\n")
      .map((line) => line.replace(/^[\-\u2022*\s]+/, "").trim())
      .filter(Boolean),
    maxItems
  );
}

function buildResumeEntryKey(parts: string[]) {
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("|");
}

function buildBaselineResume(
  structuredProfile: unknown,
  fallbackContact: ProfileContact
): TailoredResume | null {
  if (!structuredProfile || typeof structuredProfile !== "object" || Array.isArray(structuredProfile)) {
    return null;
  }

  const payload = structuredProfile as Record<string, unknown>;
  const overview =
    payload.overview && typeof payload.overview === "object" && !Array.isArray(payload.overview)
      ? (payload.overview as Record<string, unknown>)
      : {};

  const normalizedContact = normalizeContact({
    fullName: overview.fullName,
    email: overview.email,
    phone: overview.phone,
    location: overview.location,
    linkedInUrl: overview.linkedInUrl,
    githubUrl: overview.githubUrl,
    portfolioUrl: overview.portfolioUrl,
  });
  const normalizedSkills = normalizeSkills(payload.skills).map((entry) => entry.name);
  const normalizedExperiences = normalizeExperiences(payload.experiences);
  const normalizedEducations = normalizeEducations(payload.educations);
  const normalizedProjects = normalizeProjects(payload.projects);

  if (
    normalizedSkills.length === 0 &&
    normalizedExperiences.length === 0 &&
    normalizedEducations.length === 0 &&
    normalizedProjects.length === 0 &&
    !normalizeValue(overview.summary, 400)
  ) {
    return null;
  }

  return {
    contact: {
      name: normalizedContact.fullName || fallbackContact.fullName,
      email: normalizedContact.email || fallbackContact.email,
      phone: normalizedContact.phone || fallbackContact.phone,
      location: normalizedContact.location || fallbackContact.location,
      linkedin: normalizedContact.linkedInUrl || fallbackContact.linkedInUrl,
      github: normalizedContact.githubUrl || fallbackContact.githubUrl,
      portfolio: normalizedContact.portfolioUrl || fallbackContact.portfolioUrl,
    },
    summary: normalizeValue(overview.summary, 500),
    skills: uniqueStrings(normalizedSkills, 24),
    experience: normalizedExperiences.map((entry) => ({
      title: entry.title,
      company: entry.company,
      time: entry.time,
      location: entry.location,
      bullets: descriptionToBullets(entry.description, 5),
    })),
    education: normalizedEducations.map((entry) => ({
      degree: entry.degree,
      school: entry.school,
      time: entry.time,
      location: entry.location,
      description: entry.description,
    })),
    projects: normalizedProjects.map((entry) => ({
      name: entry.name || entry.title,
      time: entry.time,
      bullets: descriptionToBullets(entry.description, 4),
    })),
  };
}

function preserveBaselineDensity(
  tailored: TailoredResume,
  baseline: TailoredResume | null
): TailoredResume {
  if (!baseline) {
    return tailored;
  }

  const experienceByKey = new Map<string, number>();
  const mergedExperiences = tailored.experience.map((entry, index) => {
    experienceByKey.set(buildResumeEntryKey([entry.title, entry.company, entry.time]), index);
    return { ...entry, bullets: uniqueStrings(entry.bullets, 6) };
  });

  for (const baselineEntry of baseline.experience) {
    const key = buildResumeEntryKey([baselineEntry.title, baselineEntry.company, baselineEntry.time]);
    const existingIndex = experienceByKey.get(key);

    if (existingIndex != null) {
      const current = mergedExperiences[existingIndex];
      mergedExperiences[existingIndex] = {
        title: current.title || baselineEntry.title,
        company: current.company || baselineEntry.company,
        time: current.time || baselineEntry.time,
        location: current.location || baselineEntry.location,
        bullets: uniqueStrings([...current.bullets, ...baselineEntry.bullets], 6),
      };
      continue;
    }

    if (mergedExperiences.length < 6) {
      experienceByKey.set(key, mergedExperiences.length);
      mergedExperiences.push({
        ...baselineEntry,
        bullets: uniqueStrings(baselineEntry.bullets, 4),
      });
    }
  }

  const educationByKey = new Map<string, number>();
  const mergedEducation = tailored.education.map((entry, index) => {
    educationByKey.set(buildResumeEntryKey([entry.school, entry.degree, entry.time]), index);
    return { ...entry };
  });

  for (const baselineEntry of baseline.education) {
    const key = buildResumeEntryKey([baselineEntry.school, baselineEntry.degree, baselineEntry.time]);
    const existingIndex = educationByKey.get(key);

    if (existingIndex != null) {
      const current = mergedEducation[existingIndex];
      mergedEducation[existingIndex] = {
        degree: current.degree || baselineEntry.degree,
        school: current.school || baselineEntry.school,
        time: current.time || baselineEntry.time,
        location: current.location || baselineEntry.location,
        description: current.description || baselineEntry.description,
      };
      continue;
    }

    if (mergedEducation.length < 3) {
      educationByKey.set(key, mergedEducation.length);
      mergedEducation.push({ ...baselineEntry });
    }
  }

  const projectByKey = new Map<string, number>();
  const mergedProjects = tailored.projects.map((entry, index) => {
    projectByKey.set(buildResumeEntryKey([entry.name, entry.time]), index);
    return { ...entry, bullets: uniqueStrings(entry.bullets, 4) };
  });

  for (const baselineEntry of baseline.projects) {
    const key = buildResumeEntryKey([baselineEntry.name, baselineEntry.time]);
    const existingIndex = projectByKey.get(key);

    if (existingIndex != null) {
      const current = mergedProjects[existingIndex];
      mergedProjects[existingIndex] = {
        name: current.name || baselineEntry.name,
        time: current.time || baselineEntry.time,
        bullets: uniqueStrings([...current.bullets, ...baselineEntry.bullets], 3),
      };
      continue;
    }

    if (mergedProjects.length < 5) {
      projectByKey.set(key, mergedProjects.length);
      mergedProjects.push({ ...baselineEntry, bullets: uniqueStrings(baselineEntry.bullets, 4) });
    }
  }

  return {
    contact: {
      name: tailored.contact.name || baseline.contact.name,
      email: tailored.contact.email || baseline.contact.email,
      phone: tailored.contact.phone || baseline.contact.phone,
      location: tailored.contact.location || baseline.contact.location,
      linkedin: tailored.contact.linkedin || baseline.contact.linkedin,
      github: tailored.contact.github || baseline.contact.github,
      portfolio: tailored.contact.portfolio || baseline.contact.portfolio,
    },
    summary:
      tailored.summary.trim().length >= 60 ? tailored.summary : tailored.summary || baseline.summary,
    skills: uniqueStrings([...tailored.skills, ...baseline.skills], 25),
    experience: mergedExperiences,
    education: mergedEducation,
    projects: mergedProjects,
  };
}

async function fillLatexTemplate(
  client: ReturnType<typeof getOpenAIClient>,
  templateContent: string,
  resumeData: TailoredResume
) {
  const fillResult = await client.chat.completions.create({
    model: getStandardModel(),
    messages: [
      {
        role: "system",
        content: `You are a LaTeX template filler. Given a COMPLETE LaTeX resume template and structured resume data, produce the complete filled LaTeX file.

Rules:
- Keep the EXACT same document class, packages, formatting commands, spacing, and structure
- Replace ONLY the content (name, dates, bullet text, skills, etc.)
- Preserve one-page resume formatting as much as possible
- Keep bullet points concise and do not add new sections
- Return raw LaTeX only, with no markdown or code fences
- If a section in the template has no matching data, remove or leave it empty in a clean way
- Escape LaTeX-sensitive characters correctly`,
      },
      {
        role: "user",
        content: `Fill this LaTeX template with the resume data below.

TEMPLATE:
${templateContent}

RESUME DATA (JSON):
${JSON.stringify(resumeData, null, 2)}`,
      },
    ],
    max_completion_tokens: 4000,
  });

  const filledTemplate = normalizeChatMessageContent(fillResult.choices[0]?.message?.content);
  return filledTemplate ? stripCodeFences(filledTemplate) : null;
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const [authUserId, profile] = await Promise.all([
      requireCurrentAuthUserId(),
      requireCurrentUserProfile(),
    ]);

    const readiness = getOpenAIReadiness();
    if (!readiness.configured) {
      return NextResponse.json({ error: "OpenAI is not configured." }, { status: 503 });
    }

    const { id: applicationId } = await params;

    const [application, templateDoc] = await Promise.all([
      prisma.trackedApplication.findFirst({
        where: { id: applicationId, userId: authUserId },
        select: {
          company: true,
          roleTitle: true,
          jobDescription: true,
          fitAnalysis: true,
          documentLinks: {
            where: { slot: "SENT_RESUME" },
            select: {
              document: {
                select: {
                  title: true,
                  analysis: {
                    select: {
                      extractedText: true,
                      structuredProfileJson: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.document.findFirst({
        where: { userId: profile.id, type: "RESUME_TEMPLATE", isPrimary: true },
        select: {
          originalFileName: true,
          analysis: {
            select: {
              extractedText: true,
            },
          },
        },
      }),
    ]);

    if (!application) {
      return NextResponse.json({ error: "Application not found." }, { status: 404 });
    }

    if (!application.jobDescription) {
      return NextResponse.json({ error: "Add a job description first." }, { status: 400 });
    }

    let resumeText: string | null = null;
    let resumeStructuredProfile: unknown | null = null;

    const linkedResume = application.documentLinks[0]?.document;
    if (linkedResume?.analysis?.extractedText) {
      resumeText = linkedResume.analysis.extractedText;
      resumeStructuredProfile = linkedResume.analysis.structuredProfileJson ?? null;
    }

    if (!resumeText) {
      const primary = await prisma.document.findFirst({
        where: { userId: profile.id, type: "RESUME", isPrimary: true },
        select: {
          analysis: {
            select: {
              extractedText: true,
              structuredProfileJson: true,
            },
          },
        },
      });

      resumeText = primary?.analysis?.extractedText ?? null;
      resumeStructuredProfile = primary?.analysis?.structuredProfileJson ?? null;
    }

    if (!resumeText) {
      return NextResponse.json({ error: "No resume available." }, { status: 400 });
    }

    const templateContent = templateDoc?.analysis?.extractedText ?? null;

    const contact = (profile.contactJson as ProfileContact | null) ?? {
      fullName: profile.name ?? "",
      email: profile.email ?? "",
      phone: "",
      location: "",
      linkedInUrl: "",
      githubUrl: "",
      portfolioUrl: "",
    };
    const skills = (profile.skillsJson as ProfileSkill[] | null) ?? [];
    const experiences = (profile.experiencesJson as ProfileExperience[] | null) ?? [];
    const educations = (profile.educationsJson as ProfileEducation[] | null) ?? [];
    const projects = (profile.projectsJson as ProfileProject[] | null) ?? [];
    const baselineResume = buildBaselineResume(resumeStructuredProfile, contact);

    const maxChars = 8000;
    const truncate = (value: string) =>
      value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;

    const client = getOpenAIClient();

    const apiMessages = [
      {
        role: "system" as const,
        content: `You are editing an EXISTING one-page resume for a specific job application.

The attached baseline resume is the source document. The full profile is a superset of the user's background. The fit analysis suggestions tell you EXACTLY what changes to make — you MUST act on every suggestion.

Return ONLY valid JSON matching this exact schema (no markdown, no code fences):
{
  "contact": { "name": "", "email": "", "phone": "", "location": "", "linkedin": "", "github": "", "portfolio": "" },
  "summary": "2-3 sentence professional summary tailored to this role",
  "skills": ["skill1", "skill2", ...],
  "experience": [
    { "title": "", "company": "", "time": "", "location": "", "bullets": ["achievement 1", "achievement 2", ...] }
  ],
  "education": [
    { "degree": "", "school": "", "time": "", "location": "", "description": "" }
  ],
  "projects": [
    { "name": "", "time": "", "bullets": ["description 1", ...] }
  ]
}

CRITICAL — Page Density Rules:
- The output resume MUST have AT LEAST as much content as the baseline resume. Never produce a sparser result.
- Every experience entry should have 3-5 bullet points. Do NOT reduce bullets to 1-2 per entry.
- Include ALL experience entries from the baseline. Only drop one if you are replacing it with a more relevant one from the profile.
- Include ALL projects from the baseline, plus any relevant ones from the profile.
- Include 15-25 skills, ordered by relevance to the job.
- The summary should be 2-3 full sentences, not a single short line.
- Education entries should include relevant coursework, GPA, or honors in the description field if available.
- Fill every section generously — a one-page resume should be FULL, not half-empty. HR reviewers expect a dense, information-rich resume.

Fit Analysis Rules:
- If fit analysis suggestions are provided, you MUST implement each suggestion concretely:
  - If it says "add skill X" → add it to the skills list
  - If it says "highlight project Y" → include that project from the profile with detailed bullets
  - If it says "reword bullets to emphasize Z" → actually reword them using the suggested framing
  - If it says "add experience with W" → pull the relevant experience from the profile and include it
- Do NOT just acknowledge suggestions — apply every single one to the resume content.

Content Rules:
- Reword experience bullets to use keywords and language from the job description.
- Bullets should be specific and achievement-oriented (include metrics, tools, outcomes where possible).
- Use the full profile to enrich: add relevant skills, swap in stronger projects, beef up bullet points with details from the profile.
- Keep all facts truthful — do NOT fabricate experience, companies, degrees, or skills.
- Use the user's actual contact info, job titles, company names, and dates.
- Summary should directly address why the user fits this specific role, referencing key qualifications.`,
      },
      {
        role: "user" as const,
        content: `Tailor this resume for: ${application.roleTitle} at ${application.company}

Job Description:
${truncate(application.jobDescription)}

${application.fitAnalysis ? `Fit Analysis Suggestions:\n${truncate(application.fitAnalysis)}` : ""}

Attached Resume Raw Text:
${truncate(resumeText)}

Baseline Resume Structure (edit this; do not rebuild from scratch):
${baselineResume ? JSON.stringify(baselineResume, null, 2) : "Not available"}

Baseline Resume Density (your output MUST match or exceed these counts):
${JSON.stringify(
  baselineResume
    ? {
        skills: baselineResume.skills.length,
        experience_entries: baselineResume.experience.length,
        experience_bullets_per_entry: baselineResume.experience.map((entry) => entry.bullets.length),
        total_experience_bullets: baselineResume.experience.reduce((sum, entry) => sum + entry.bullets.length, 0),
        education_entries: baselineResume.education.length,
        project_entries: baselineResume.projects.length,
        project_bullets_per_entry: baselineResume.projects.map((entry) => entry.bullets.length),
        total_project_bullets: baselineResume.projects.reduce((sum, entry) => sum + entry.bullets.length, 0),
      }
    : {
        skills: 0,
        experience_entries: 0,
        experience_bullets_per_entry: [],
        total_experience_bullets: 0,
        education_entries: 0,
        project_entries: 0,
        project_bullets_per_entry: [],
        total_project_bullets: 0,
      },
  null,
  2
)}

Full Structured Profile Superset:
${JSON.stringify(
  {
    contact,
    headline: profile.headline ?? "",
    summary: profile.summary ?? "",
    skills,
    experiences: experiences.slice(0, 8),
    educations: educations.slice(0, 4),
    projects: projects.slice(0, 6),
  },
  null,
  2
)}`,
      },
    ];

    let tailored: TailoredResume | null = null;
    let lastErrorMessage = "";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await client.chat.completions.parse({
        model: getReasoningModel(),
        messages: apiMessages,
        max_completion_tokens: 8000,
        response_format: zodResponseFormat(tailoredResumeSchema, "tailored_resume"),
      });

      const choice = result.choices[0];
      const message = choice?.message;
      const rawContent = normalizeChatMessageContent(message?.content);

      tailored = message?.parsed ?? (rawContent ? tryParseTailoredResume(rawContent) : null);

      if (tailored) {
        break;
      }

      const refusal = typeof message?.refusal === "string" ? message.refusal : null;
      const finishReason = choice?.finish_reason ?? "unknown";

      lastErrorMessage = refusal
        ? `AI refused the request: ${refusal}`
        : finishReason === "length"
          ? "AI response was truncated before the resume could be generated."
          : rawContent
            ? "AI returned a non-standard response format — try again."
            : "AI returned an empty response.";

      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!tailored) {
      return NextResponse.json({ error: lastErrorMessage }, { status: 502 });
    }

    const densityPreserved = preserveBaselineDensity(tailored, baselineResume);

    if (!densityPreserved.contact.name) densityPreserved.contact.name = contact.fullName;
    if (!densityPreserved.contact.email) densityPreserved.contact.email = contact.email;
    if (!densityPreserved.contact.phone) densityPreserved.contact.phone = contact.phone;
    if (!densityPreserved.contact.location) densityPreserved.contact.location = contact.location;
    if (!densityPreserved.contact.linkedin) densityPreserved.contact.linkedin = contact.linkedInUrl;
    if (!densityPreserved.contact.github) densityPreserved.contact.github = contact.githubUrl;
    if (!densityPreserved.contact.portfolio) densityPreserved.contact.portfolio = contact.portfolioUrl;

    const standardResume = compactTailoredResume(densityPreserved, "standard");

    const templateLooksCompilable =
      Boolean(templateContent) &&
      (/\.tex$/i.test(templateDoc?.originalFileName ?? "") || looksLikeLatexDocument(templateContent ?? ""));

    let preferredTex: string | null = null;
    if (templateLooksCompilable && templateContent) {
      try {
        preferredTex = await fillLatexTemplate(client, templateContent, standardResume);
      } catch (error) {
        console.error("Template fill failed:", error);
      }
    }

    const compileCandidate = async (texSource: string) => {
      const stabilized = stabilizeTeXSource(texSource);
      return compileResumePdf(
        stabilized,
        `${safeFileSegment(application.company)}-${safeFileSegment(application.roleTitle)}`
      );
    };

    type CompileAttempt = {
      label: string;
      texFn: () => string;
      maxOverfull: number;
    };

    const attempts: CompileAttempt[] = [
      {
        label: "standard",
        texFn: () => preferredTex || generateResumeTeX(standardResume),
        maxOverfull: 4,
      },
      {
        label: "tight",
        texFn: () => generateResumeTeX(compactTailoredResume(densityPreserved, "tight")),
        maxOverfull: 6,
      },
    ];

    const aggressiveShrinks = [
      { skills: 10, exp: 3, expBul: 2, edu: 1, proj: 1, projBul: 1, sumWords: 30, sumChars: 180, bulChars: 110 },
      { skills: 8, exp: 2, expBul: 2, edu: 1, proj: 0, projBul: 0, sumWords: 20, sumChars: 120, bulChars: 100 },
    ];

    for (const config of aggressiveShrinks) {
      attempts.push({
        label: `ultra-tight(skills=${config.skills},exp=${config.exp})`,
        texFn: () => {
          const ultraTight: TailoredResume = {
            contact: standardResume.contact,
            summary: truncateWords(densityPreserved.summary, config.sumWords, config.sumChars),
            skills: densityPreserved.skills
              .slice(0, config.skills)
              .map((skill) => truncateWords(skill, 4, 30))
              .filter(Boolean),
            experience: densityPreserved.experience.slice(0, config.exp).map((entry) => ({
              ...entry,
              bullets: entry.bullets
                .slice(0, config.expBul)
                .map((bullet) =>
                  truncateWords(bullet.replace(/^[\-\u2022\s]+/, ""), 18, config.bulChars)
                )
                .filter(Boolean),
            })),
            education: densityPreserved.education.slice(0, config.edu).map((entry) => ({
              ...entry,
              description: truncateWords(entry.description, 15, 100),
            })),
            projects: densityPreserved.projects.slice(0, config.proj).map((entry) => ({
              ...entry,
              bullets: entry.bullets
                .slice(0, config.projBul)
                .map((bullet) =>
                  truncateWords(bullet.replace(/^[\-\u2022\s]+/, ""), 18, config.bulChars)
                )
                .filter(Boolean),
            })),
          };
          return generateResumeTeX(ultraTight);
        },
        maxOverfull: 8,
      });
    }

    let compiledPdf: Awaited<ReturnType<typeof compileResumePdf>> | undefined;
    let usedFallback = false;

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      try {
        compiledPdf = await compileCandidate(attempt.texFn());
        if (index > 0) {
          usedFallback = true;
        }

        const pageOk = !compiledPdf.pageCount || compiledPdf.pageCount <= 1;
        const overflowOk = compiledPdf.maxOverfullPoints <= attempt.maxOverfull;

        if (pageOk && overflowOk) {
          break;
        }
      } catch (compileError) {
        console.error(`PDF compile failed on attempt "${attempt.label}":`, compileError);
      }
    }

    if (!compiledPdf?.pdfBuffer) {
      return NextResponse.json(
        { error: "Resume PDF compilation failed after all attempts. Try using a simpler template." },
        { status: 502 }
      );
    }

    const fileName = `${safeFileSegment(application.company)}-${safeFileSegment(
      application.roleTitle
    )}-tailored-resume.pdf`;

    return NextResponse.json({
      fileName,
      mimeType: "application/pdf",
      pdfBase64: compiledPdf.pdfBuffer.toString("base64"),
      usedFallback,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Tailored resume generation error:", error);
    return NextResponse.json({ error: `Generation failed: ${message}` }, { status: 500 });
  }
}
