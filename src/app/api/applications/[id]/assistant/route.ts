import { NextResponse } from "next/server";

import {
  UnauthorizedError,
  requireCurrentAuthUserId,
  requireCurrentUserProfile,
} from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { getOpenAIClient, getOpenAIReadiness, getStandardModel } from "@/lib/openai";
import {
  normalizeContact,
  normalizeEducations,
  normalizeExperiences,
  normalizeProjects,
  normalizeSkills,
} from "@/lib/profile";

type RouteContext = {
  params: Promise<{ id: string }>;
};

type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

function truncate(value: string | null | undefined, maxLength: number) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}\n[...truncated]` : trimmed;
}

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

async function openAIWithRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const status = (error as { status?: number })?.status;
      if (status !== 500 && status !== 502 && status !== 503 && status !== 504) {
        throw error;
      }
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  throw lastError;
}

function sanitizeHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const role = (item as { role?: unknown }).role;
      const content = (item as { content?: unknown }).content;

      if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
        return null;
      }

      const trimmed = content.trim().slice(0, 1600);
      if (!trimmed) {
        return null;
      }

      return { role, content: trimmed } satisfies ChatTurn;
    })
    .filter((item): item is ChatTurn => item !== null)
    .slice(-8);
}

function formatProfileContext(profile: {
  headline: string | null;
  summary: string | null;
  contactJson: unknown;
  skillsJson: unknown;
  experiencesJson: unknown;
  educationsJson: unknown;
  projectsJson: unknown;
}) {
  const contact = normalizeContact(profile.contactJson);
  const skills = normalizeSkills(profile.skillsJson);
  const experiences = normalizeExperiences(profile.experiencesJson);
  const educations = normalizeEducations(profile.educationsJson);
  const projects = normalizeProjects(profile.projectsJson);

  const parts: string[] = [];

  const contactLine = [
    contact.fullName,
    contact.email,
    contact.phone,
    contact.location,
    contact.linkedInUrl,
    contact.githubUrl,
    contact.portfolioUrl,
  ]
    .filter(Boolean)
    .join(" | ");
  if (contactLine) {
    parts.push(`Contact: ${contactLine}`);
  }

  if (profile.headline?.trim()) {
    parts.push(`Headline: ${truncate(profile.headline, 200)}`);
  }

  if (profile.summary?.trim()) {
    parts.push(`Summary: ${truncate(profile.summary, 1200)}`);
  }

  if (skills.length > 0) {
    parts.push(`Skills: ${skills.map((entry) => entry.name).join(", ")}`);
  }

  if (experiences.length > 0) {
    parts.push(
      `Experience:\n${experiences
        .slice(0, 6)
        .map((entry) =>
          [
            `- ${[entry.title, entry.company].filter(Boolean).join(" at ") || "Experience entry"}`,
            [entry.time, entry.location].filter(Boolean).join(" | "),
            truncate(entry.description, 500),
          ]
            .filter(Boolean)
            .join("\n  ")
        )
        .join("\n")}`
    );
  }

  if (educations.length > 0) {
    parts.push(
      `Education:\n${educations
        .slice(0, 4)
        .map((entry) =>
          [
            `- ${[entry.degree, entry.school].filter(Boolean).join(" at ") || "Education entry"}`,
            [entry.time, entry.location].filter(Boolean).join(" | "),
            truncate(entry.description, 300),
          ]
            .filter(Boolean)
            .join("\n  ")
        )
        .join("\n")}`
    );
  }

  if (projects.length > 0) {
    parts.push(
      `Projects:\n${projects
        .slice(0, 5)
        .map((entry) =>
          [
            `- ${entry.name || entry.title || "Project"}`,
            [entry.time, entry.location].filter(Boolean).join(" | "),
            truncate(entry.description, 400),
          ]
            .filter(Boolean)
            .join("\n  ")
        )
        .join("\n")}`
    );
  }

  return parts.join("\n\n");
}

function formatDocumentContext(
  documentLinks: Array<{
    slot: "SENT_RESUME" | "SENT_COVER_LETTER";
    document: {
      title: string;
      analysis: {
        extractedText: string;
      } | null;
    };
  }>
) {
  if (documentLinks.length === 0) {
    return "No resume or cover letter is linked to this application.";
  }

  return documentLinks
    .map((link) => {
      const label = link.slot === "SENT_RESUME" ? "Linked resume" : "Linked cover letter";
      const extractedText = truncate(link.document.analysis?.extractedText, 3500);

      return [
        `${label}: ${link.document.title}`,
        extractedText || "No extracted text is available for this document yet.",
      ].join("\n");
    })
    .join("\n\n");
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [authUserId, profile] = await Promise.all([
      requireCurrentAuthUserId(),
      requireCurrentUserProfile(),
    ]);

    const readiness = getOpenAIReadiness();
    if (!readiness.configured) {
      return NextResponse.json({ error: "OpenAI is not configured." }, { status: 503 });
    }

    const body = await request.json().catch(() => null);
    const question =
      typeof body?.question === "string" ? body.question.trim().slice(0, 2000) : "";
    const history = sanitizeHistory(body?.history);

    if (!question) {
      return NextResponse.json({ error: "Question is required." }, { status: 400 });
    }

    const { id } = await context.params;

    const application = await prisma.trackedApplication.findFirst({
      where: { id, userId: authUserId },
      select: {
        id: true,
        company: true,
        roleTitle: true,
        roleUrl: true,
        status: true,
        deadline: true,
        jobDescription: true,
        fitAnalysis: true,
        notes: true,
        documentLinks: {
          where: { slot: { in: ["SENT_RESUME", "SENT_COVER_LETTER"] } },
          orderBy: { slot: "asc" },
          select: {
            slot: true,
            document: {
              select: {
                title: true,
                analysis: {
                  select: {
                    extractedText: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!application) {
      return NextResponse.json({ error: "Application not found." }, { status: 404 });
    }

    const applicationContext = [
      `Company: ${application.company}`,
      `Role Title: ${application.roleTitle}`,
      application.roleUrl ? `Job Posting URL: ${application.roleUrl}` : "",
      `Status: ${application.status}`,
      application.deadline ? `Deadline: ${application.deadline.toISOString()}` : "",
      application.jobDescription?.trim()
        ? `Saved Job Description:\n${truncate(application.jobDescription, 5000)}`
        : "Saved Job Description: Not available.",
      application.fitAnalysis?.trim()
        ? `Fit Analysis:\n${truncate(application.fitAnalysis, 4000)}`
        : "Fit Analysis: Not available.",
      application.notes?.trim()
        ? `Application Notes:\n${truncate(application.notes, 2500)}`
        : "Application Notes: Not available.",
      `Linked Documents:\n${formatDocumentContext(
        application.documentLinks as Array<{
          slot: "SENT_RESUME" | "SENT_COVER_LETTER";
          document: {
            title: string;
            analysis: { extractedText: string } | null;
          };
        }>
      )}`,
      `Your Profile:\n${formatProfileContext(profile)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const client = getOpenAIClient();
    const result = await openAIWithRetry(() =>
      client.chat.completions.create({
        model: getStandardModel(),
        messages: [
          {
            role: "system",
            content: `You are the job-scoped AI assistant inside Application Tracker.

You answer questions about ONE specific application using ONLY the provided application context, linked document text, fit analysis, notes, and the user's profile.

What you help with:
- understanding the role and priorities
- interview preparation
- resume or cover-letter strategy
- networking or recruiter message drafts
- follow-up planning
- identifying strengths, gaps, and next steps

Rules:
- Ground every answer in the saved context for this application.
- If the saved context does not contain enough information, say that clearly.
- Do not invent company facts, compensation, interview stages, or details about the user's experience.
- Do not claim to have browsed the web.
- When drafting text, make it ready to use and specific to this job.
- Keep answers concise and easy to scan.
- Prefer this formatting style:
  - Use short bold section headers on their own lines, for example **Takeaway** or **Next Steps**
  - Use bullet points for recommendations and observations
  - Use numbered steps when giving a sequence or plan
  - Keep each bullet or step to one or two lines
  - Avoid one long paragraph unless the user explicitly asks for prose
- Talk to the user directly using "you" and "your", not "the candidate".
- If the user asks something unrelated to this job or user context, redirect the answer back to this application.

Current application context:
${applicationContext}`,
          },
          ...history.map((turn) => ({
            role: turn.role,
            content: turn.content,
          })),
          {
            role: "user",
            content: question,
          },
        ],
        max_completion_tokens: 1400,
      })
    );

    const answer = normalizeChatMessageContent(result.choices[0]?.message?.content);
    if (!answer) {
      return NextResponse.json(
        { error: "AI returned an empty response. Please try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ answer });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const friendly =
      message.includes("timeout") || message.includes("ETIMEDOUT")
        ? "The AI request timed out. Please try again."
        : message.includes("rate") || message.includes("429")
          ? "Rate limited by the AI provider. Wait a moment and try again."
          : `Assistant request failed. (${message})`;

    console.error("Job assistant error:", error);
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
}
