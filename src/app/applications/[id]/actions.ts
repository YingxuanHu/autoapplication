"use server";

import { revalidatePath } from "next/cache";

import type {
  TrackedApplicationDocumentSlot,
  TrackedApplicationEventType,
  TrackedApplicationStatus,
} from "@/generated/prisma/client";
import {
  requireCurrentAuthUserId,
  requireCurrentUserProfile,
  UnauthorizedError,
} from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { getFastModel, getOpenAIClient, getOpenAIReadiness, getStandardModel } from "@/lib/openai";
import {
  normalizeContact,
  normalizeEducations,
  normalizeExperiences,
  normalizeProjects,
  normalizeSkills,
} from "@/lib/profile";
import { inferProfileDocumentMimeType } from "@/lib/profile-resume-service";
import {
  addTrackedApplicationEvent,
  addTrackedApplicationTag,
  deleteTrackedApplicationEvent,
  linkTrackedApplicationDocument,
  removeTrackedApplicationTag,
  unlinkTrackedApplicationDocument,
  updateTrackedApplicationField,
  updateTrackedApplicationStatus,
} from "@/lib/queries/tracker";
import {
  buildDocumentStorageKey,
  deleteFile,
  getStorageReadiness,
  saveFile,
} from "@/lib/storage";
import { TRACKED_STATUS_LABEL } from "@/lib/tracker-ui";

type ActionState = {
  error: string | null;
  success: string | null;
};

type SummarizeState = ActionState & {
  fetchFailed?: boolean;
};

const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

const ACCEPTED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "application/rtf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/octet-stream",
] as const);

const allowedStatuses = new Set<TrackedApplicationStatus>([
  "WISHLIST",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
]);

const allowedEventTypes = new Set<TrackedApplicationEventType>([
  "NOTE",
  "REMINDER",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
]);

const allowedSlots = new Set<TrackedApplicationDocumentSlot>([
  "SENT_RESUME",
  "SENT_COVER_LETTER",
]);

function revalidateApplication(applicationId: string) {
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
  revalidatePath("/profile");
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath(`/dashboard/${applicationId}`);
}

function toActionState(error: unknown): ActionState {
  return {
    error: error instanceof Error ? error.message : "Request failed.",
    success: null,
  };
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

function stripHtmlToText(html: string) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function inferDocumentMimeType(fileName: string, browserMime: string): string {
  if (browserMime.trim() && browserMime !== "application/octet-stream") {
    return browserMime;
  }

  return inferProfileDocumentMimeType(fileName, browserMime);
}

export async function updateApplicationField(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const field = String(formData.get("field") ?? "").trim();

    if (
      !applicationId ||
      (field !== "notes" && field !== "jobDescription" && field !== "fitAnalysis")
    ) {
      return { error: "Invalid parameters.", success: null };
    }

    await updateTrackedApplicationField({
      applicationId,
      field,
      value: String(formData.get("value") ?? ""),
    });

    revalidateApplication(applicationId);

    const labels = {
      notes: "Notes",
      jobDescription: "Job description",
      fitAnalysis: "Fit analysis",
    } as const;

    return {
      error: null,
      success: `${labels[field]} saved.`,
    };
  } catch (error) {
    return toActionState(error);
  }
}

export async function updateApplicationStatus(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const statusRaw = String(formData.get("status") ?? "").trim().toUpperCase();

    if (!applicationId || !allowedStatuses.has(statusRaw as TrackedApplicationStatus)) {
      return { error: "Invalid parameters.", success: null };
    }

    const status = statusRaw as TrackedApplicationStatus;
    const result = await updateTrackedApplicationStatus({
      applicationId,
      status,
    });

    revalidateApplication(applicationId);

    return {
      error: null,
      success: result.changed
        ? `Status updated to ${TRACKED_STATUS_LABEL[status]}.`
        : "Status unchanged.",
    };
  } catch (error) {
    return toActionState(error);
  }
}

export async function addTimelineEvent(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const typeRaw = String(formData.get("type") ?? "").trim().toUpperCase();

    if (!applicationId || !allowedEventTypes.has(typeRaw as TrackedApplicationEventType)) {
      return { error: "Invalid parameters.", success: null };
    }

    const reminderAtRaw = String(formData.get("reminderAt") ?? "").trim();
    let reminderAt: Date | null = null;

    if (typeRaw === "REMINDER") {
      if (!reminderAtRaw) {
        return { error: "A date and time is required for reminder events.", success: null };
      }

      reminderAt = new Date(reminderAtRaw);
      if (Number.isNaN(reminderAt.getTime())) {
        return { error: "Invalid reminder date/time.", success: null };
      }
      if (reminderAt <= new Date()) {
        return { error: "Reminder date must be in the future.", success: null };
      }
    }

    await addTrackedApplicationEvent({
      applicationId,
      type: typeRaw as TrackedApplicationEventType,
      note: String(formData.get("note") ?? "").trim() || null,
      reminderAt,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Event added." };
  } catch (error) {
    return toActionState(error);
  }
}

export async function deleteTimelineEvent(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const eventId = String(formData.get("eventId") ?? "").trim();

    if (!applicationId || !eventId) {
      return { error: "Invalid parameters.", success: null };
    }

    await deleteTrackedApplicationEvent({
      applicationId,
      eventId,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Event deleted." };
  } catch (error) {
    return toActionState(error);
  }
}

export async function linkDocument(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const documentId = String(formData.get("documentId") ?? "").trim();
    const slotRaw = String(formData.get("slot") ?? "").trim();

    if (!applicationId || !documentId || !allowedSlots.has(slotRaw as TrackedApplicationDocumentSlot)) {
      return { error: "Invalid parameters.", success: null };
    }

    await linkTrackedApplicationDocument({
      applicationId,
      documentId,
      slot: slotRaw as TrackedApplicationDocumentSlot,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Document linked." };
  } catch (error) {
    return toActionState(error);
  }
}

export async function unlinkDocument(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const slotRaw = String(formData.get("slot") ?? "").trim();

    if (!applicationId || !allowedSlots.has(slotRaw as TrackedApplicationDocumentSlot)) {
      return { error: "Invalid parameters.", success: null };
    }

    await unlinkTrackedApplicationDocument({
      applicationId,
      slot: slotRaw as TrackedApplicationDocumentSlot,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Document unlinked." };
  } catch (error) {
    return toActionState(error);
  }
}

export async function uploadWorkspaceDocument(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const [authUserId, profile] = await Promise.all([
      requireCurrentAuthUserId(),
      requireCurrentUserProfile(),
    ]);

    const storageReadiness = getStorageReadiness();
    if (!storageReadiness.configured) {
      return {
        error: `Storage is not configured. Missing: ${storageReadiness.missingKeys.join(", ")}.`,
        success: null,
      };
    }

    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const slotRaw = String(formData.get("slot") ?? "").trim();
    const titleRaw = String(formData.get("title") ?? "").trim();
    const file = formData.get("file");

    if (!applicationId || !allowedSlots.has(slotRaw as TrackedApplicationDocumentSlot)) {
      return { error: "Invalid parameters.", success: null };
    }

    if (!(file instanceof File) || file.size === 0) {
      return { error: "Please choose a file to upload.", success: null };
    }

    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      return { error: "File must be under 10 MB.", success: null };
    }

    const slot = slotRaw as TrackedApplicationDocumentSlot;
    const documentType = slot === "SENT_RESUME" ? "RESUME" : "COVER_LETTER";

    const application = await prisma.trackedApplication.findFirst({
      where: {
        id: applicationId,
        userId: authUserId,
      },
      select: { id: true },
    });

    if (!application) {
      return { error: "Application not found.", success: null };
    }

    const mimeType = inferDocumentMimeType(file.name, file.type);
    if (!ACCEPTED_MIME_TYPES.has(mimeType)) {
      return {
        error: "Unsupported file format. Use PDF, DOCX, DOC, TXT, RTF, PNG, JPG, or WEBP.",
        success: null,
      };
    }

    const title = titleRaw || file.name.replace(/\.[^.]+$/, "");
    const extension = /\.[^.]+$/.exec(file.name)?.[0] ?? ".pdf";
    const storageKey = buildDocumentStorageKey({
      userId: profile.id,
      title,
      extension,
      type: documentType,
    });
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    try {
      await saveFile(storageKey, fileBuffer, { contentType: mimeType });

      await prisma.$transaction(async (tx) => {
        const existingResumeCount =
          documentType === "RESUME"
            ? await tx.document.count({
                where: { userId: profile.id, type: "RESUME" },
              })
            : 0;

        const shouldBePrimary = documentType === "RESUME" && existingResumeCount === 0;

        if (shouldBePrimary) {
          await tx.document.updateMany({
            where: { userId: profile.id, type: "RESUME", isPrimary: true },
            data: { isPrimary: false },
          });
          await tx.resumeVariant.updateMany({
            where: { userId: profile.id, isDefault: true },
            data: { isDefault: false },
          });
        }

        const document = await tx.document.create({
          data: {
            userId: profile.id,
            type: documentType,
            title,
            originalFileName: file.name,
            filename: file.name,
            storageKey,
            mimeType,
            sizeBytes: file.size,
            isPrimary: shouldBePrimary,
          },
        });

        if (documentType === "RESUME") {
          await tx.resumeVariant.create({
            data: {
              userId: profile.id,
              label: title,
              documentId: document.id,
              content: null,
              isDefault: shouldBePrimary,
            },
          });
        }

        await tx.trackedApplicationDocument.upsert({
          where: {
            trackedApplicationId_slot: {
              trackedApplicationId: applicationId,
              slot,
            },
          },
          create: {
            trackedApplicationId: applicationId,
            documentId: document.id,
            slot,
          },
          update: {
            documentId: document.id,
          },
        });

        await tx.trackedApplication.update({
          where: { id: applicationId },
          data: { updatedAt: new Date() },
        });
      });
    } catch (error) {
      try {
        await deleteFile(storageKey);
      } catch {
        // Best-effort cleanup if DB write fails after upload.
      }

      return {
        error: error instanceof Error ? error.message : "Upload failed.",
        success: null,
      };
    }

    revalidateApplication(applicationId);
    return {
      error: null,
      success: `${documentType === "RESUME" ? "Resume" : "Cover letter"} uploaded and linked.`,
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { error: "Sign in required.", success: null };
    }
    return toActionState(error);
  }
}

export async function addTag(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();

    if (!applicationId || !name) {
      return { error: "Tag name is required.", success: null };
    }

    const result = await addTrackedApplicationTag({
      applicationId,
      name,
    });

    revalidateApplication(applicationId);
    return { error: null, success: `Tag "${result.name}" added.` };
  } catch (error) {
    return toActionState(error);
  }
}

export async function removeTag(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const tagId = String(formData.get("tagId") ?? "").trim();

    if (!applicationId || !tagId) {
      return { error: "Invalid parameters.", success: null };
    }

    await removeTrackedApplicationTag({
      applicationId,
      tagId,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Tag removed." };
  } catch (error) {
    return toActionState(error);
  }
}

export async function summarizeJobDescription(
  _prev: SummarizeState,
  formData: FormData
): Promise<SummarizeState> {
  try {
    const authUserId = await requireCurrentAuthUserId();
    const applicationId = String(formData.get("applicationId") ?? "").trim();
    const pastedContent = String(formData.get("content") ?? "").trim();

    if (!applicationId) {
      return { error: "Missing application ID.", success: null };
    }

    const readiness = getOpenAIReadiness();
    if (!readiness.configured) {
      return { error: "OpenAI is not configured. Add OPENAI_API_KEY to .env.", success: null };
    }

    const application = await prisma.trackedApplication.findFirst({
      where: { id: applicationId, userId: authUserId },
      select: {
        id: true,
        company: true,
        roleTitle: true,
        roleUrl: true,
      },
    });

    if (!application) {
      return { error: "Application not found.", success: null };
    }

    let content: string;

    if (pastedContent && pastedContent.length >= 30) {
      content = pastedContent;
    } else if (application.roleUrl) {
      try {
        const response = await fetch(application.roleUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ApplicationTracker/1.0)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          const statusMessage =
            response.status === 403
              ? "The site blocked our request (403 Forbidden)."
              : response.status === 404
                ? "The job posting page was not found (404)."
                : response.status >= 500
                  ? `The job site returned a server error (${response.status}).`
                  : `The site returned HTTP ${response.status}.`;

          return {
            error: `Could not fetch the job posting. ${statusMessage} Paste the content below instead.`,
            success: null,
            fetchFailed: true,
          };
        }

        const html = await response.text();
        const pageText = stripHtmlToText(html);

        const jsPageSignals = [
          "requires JavaScript",
          "enable JavaScript",
          "noscript",
          "__NEXT_DATA__",
          "window.__remixContext",
          "application/json",
        ];
        const looksLikeJsPage = jsPageSignals.some((signal) =>
          html.toLowerCase().includes(signal.toLowerCase())
        ) && pageText.length < 500;

        if (pageText.length < 200 || looksLikeJsPage) {
          return {
            error: "This job posting requires JavaScript to load. Paste the content below instead.",
            success: null,
            fetchFailed: true,
          };
        }

        content = pageText;
      } catch (fetchError) {
        const reason = fetchError instanceof Error ? fetchError.message : "Unknown error";
        const friendlyReason =
          reason.includes("timeout") || reason.includes("abort")
            ? "The request timed out — the site took too long to respond."
            : reason.includes("ENOTFOUND") || reason.includes("getaddrinfo")
              ? "Could not resolve the URL — check that the posting link is correct."
              : reason.includes("ECONNREFUSED")
                ? "Connection refused by the job site."
                : `Network error: ${reason}.`;

        return {
          error: `${friendlyReason} Paste the content below instead.`,
          success: null,
          fetchFailed: true,
        };
      }
    } else if (!pastedContent) {
      return {
        error: "No posting URL set. Paste the job posting content below to summarize.",
        success: null,
        fetchFailed: true,
      };
    } else {
      return {
        error: "Too little content to summarize — paste the full job posting text (at least a few sentences).",
        success: null,
        fetchFailed: true,
      };
    }

    const maxChars = 15000;
    const truncated = content.length > maxChars ? `${content.slice(0, maxChars)}\n[...truncated]` : content;

    const client = getOpenAIClient();
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content: `Summarize this job posting using EXACTLY this format (all 6 sections required, use "Not specified" if absent):

**Role Summary**
2-3 sentences: what the role is, team/product area.

**Responsibilities**
• 5-8 bullet points

**Required Qualifications**
• 5-8 bullet points

**Preferred Qualifications**
• 3-5 bullet points or "Not specified"

**Compensation**
Pay range or "Not specified"

**Details**
Location, work model, logistics or "Not specified"

Keep bullets concise (one line each with •). 200-400 words total. Do not invent information.`,
      },
      {
        role: "user",
        content: `"${application.roleTitle}" at "${application.company}":\n\n${truncated}`,
      },
    ];

    let summary = "";
    let finishReason: string | null | undefined = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await openAIWithRetry(() =>
        client.chat.completions.create({
          model: getFastModel(),
          messages,
          max_completion_tokens: 1000,
        })
      );

      const choice = result.choices[0];
      summary = normalizeChatMessageContent(choice?.message?.content);
      finishReason = choice?.finish_reason;

      if (finishReason === "length" && summary) {
        const lastNewline = summary.lastIndexOf("\n");
        if (lastNewline > summary.length * 0.5) {
          summary = summary.slice(0, lastNewline).trim();
        }
      }

      if (summary) {
        break;
      }

      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!summary) {
      const detail =
        finishReason === "content_filter"
          ? "Content was blocked by the AI safety filter."
          : "AI returned an empty response after retrying. This is a transient issue — please try again.";

      return {
        error: detail,
        success: null,
        fetchFailed: true,
      };
    }

    const lowQualitySignals = [
      "not available",
      "could not be extracted",
      "requires javascript",
      "no job description",
      "were not available",
      "not provided",
      "unable to extract",
    ];
    const summaryLower = summary.toLowerCase();
    const isLowQuality =
      lowQualitySignals.some((signal) => summaryLower.includes(signal)) && summary.length < 300;

    if (isLowQuality) {
      return {
        error: "The fetched page didn't contain enough job details (the site may render content with JavaScript). Paste the full posting text below instead.",
        success: null,
        fetchFailed: true,
      };
    }

    await updateTrackedApplicationField({
      applicationId,
      field: "jobDescription",
      value: summary,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Job description summarized and saved." };
  } catch (error) {
    return toActionState(error);
  }
}

export async function analyzeResumeFit(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const [authUserId, profile] = await Promise.all([
      requireCurrentAuthUserId(),
      requireCurrentUserProfile(),
    ]);

    const applicationId = String(formData.get("applicationId") ?? "").trim();
    if (!applicationId) {
      return { error: "Missing application ID.", success: null };
    }

    const readiness = getOpenAIReadiness();
    if (!readiness.configured) {
      return { error: "OpenAI is not configured. Add OPENAI_API_KEY to .env.", success: null };
    }

    const application = await prisma.trackedApplication.findFirst({
      where: { id: applicationId, userId: authUserId },
      select: {
        id: true,
        company: true,
        roleTitle: true,
        jobDescription: true,
        documentLinks: {
          where: { slot: "SENT_RESUME" },
          select: {
            document: {
              select: {
                id: true,
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
      return { error: "Application not found.", success: null };
    }

    if (!application.jobDescription || application.jobDescription.trim().length < 20) {
      return {
        error: "Add a job description first (use \"Summarize with AI\" or edit manually).",
        success: null,
      };
    }

    const jobDescription = application.jobDescription;

    let resumeText: string | null = null;
    const linkedResume = application.documentLinks[0]?.document;
    if (linkedResume?.analysis?.extractedText) {
      resumeText = linkedResume.analysis.extractedText;
    }

    if (!resumeText) {
      const primaryResume = await prisma.document.findFirst({
        where: { userId: profile.id, type: "RESUME", isPrimary: true },
        select: {
          analysis: {
            select: {
              extractedText: true,
            },
          },
        },
      });

      if (primaryResume?.analysis?.extractedText) {
        resumeText = primaryResume.analysis.extractedText;
      }
    }

    if (!resumeText) {
      return {
        error: "No resume text available. Link a resume to this application or upload one from your Profile.",
        success: null,
      };
    }

    const contact = normalizeContact(profile.contactJson);
    const skills = normalizeSkills(profile.skillsJson);
    const experiences = normalizeExperiences(profile.experiencesJson);
    const educations = normalizeEducations(profile.educationsJson);
    const projects = normalizeProjects(profile.projectsJson);

    const profileContextParts: string[] = [];
    if (skills.length > 0) {
      profileContextParts.push(`Skills: ${skills.map((entry) => entry.name).join(", ")}`);
    }
    if (experiences.length > 0) {
      profileContextParts.push(
        `Experience: ${experiences
          .slice(0, 6)
          .map((entry) =>
            [entry.title, entry.company, entry.time].filter(Boolean).join(" | ")
          )
          .join("; ")}`
      );
    }
    if (projects.length > 0) {
      profileContextParts.push(
        `Projects: ${projects
          .slice(0, 5)
          .map((entry) => `${entry.name || entry.title}: ${entry.description.slice(0, 80)}`)
          .join("; ")}`
      );
    }
    if (educations.length > 0) {
      profileContextParts.push(
        `Education: ${educations
          .slice(0, 3)
          .map((entry) => [entry.degree, entry.school].filter(Boolean).join(" at "))
          .join("; ")}`
      );
    }
    if (contact.location) {
      profileContextParts.push(`Location: ${contact.location}`);
    }

    const truncate = (value: string, maxChars: number) =>
      value.length > maxChars ? `${value.slice(0, maxChars)}\n[...truncated]` : value;

    const client = getOpenAIClient();
    const result = await openAIWithRetry(() =>
      client.chat.completions.create({
        model: getStandardModel(),
        messages: [
          {
            role: "system",
            content: `You are a career coach analyzing how well a candidate fits a specific job posting. You have TWO sources of information about the candidate:
1. The resume they plan to submit for this job
2. Their full profile data (which includes ALL their skills, experience, projects, and education — a superset of what's on the resume)

Provide actionable, specific feedback using this exact format:

**Match Score**
X/10 — one sentence overall assessment based on the candidate's FULL background (not just the resume).

**Strengths**
• 3-5 bullet points explaining what fits well

**Gaps**
• 2-4 bullet points explaining what is missing or weaker

**What To Emphasize**
• 3-5 bullet points on what to highlight in the application or interview

**Recommended Changes**
• 3-5 bullet points for how to improve the resume or application package for this job

Rules:
- Ground every point in the candidate information provided
- Use the full profile data when relevant, not only the attached resume
- Do not invent experience, skills, or certifications
- Keep bullets concise and specific
- Return plain text in exactly the structure above`,
          },
          {
            role: "user",
            content: `Role: ${application.roleTitle} at ${application.company}

Job Description:
${truncate(jobDescription, 5000)}

Attached Resume:
${truncate(resumeText, 6000)}

Full Candidate Profile:
${truncate(profileContextParts.join("\n"), 3000)}`,
          },
        ],
        max_completion_tokens: 1400,
      })
    );

    const analysis = normalizeChatMessageContent(result.choices[0]?.message?.content);
    if (!analysis) {
      return { error: "AI returned an empty response. Please try again.", success: null };
    }

    await updateTrackedApplicationField({
      applicationId,
      field: "fitAnalysis",
      value: analysis,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Fit analysis saved." };
  } catch (error) {
    return toActionState(error);
  }
}
