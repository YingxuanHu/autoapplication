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
import {
  formatJobDescriptionText,
  isJobDescriptionSummaryUsable,
  isLowQualityJobDescription,
  parseJobDescriptionBlocks,
  pickBestFormattedJobDescription,
} from "@/lib/job-description-format";
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
  "PREPARING",
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

function stripHtmlToText(html: string) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|aside|ul|ol|table|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
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

export async function importJobDescription(
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
        const formattedFromHtml = formatJobDescriptionText(html);
        const formattedFromPlainText = formatJobDescriptionText(stripHtmlToText(html));
        const bestFormatted = pickBestFormattedJobDescription([
          formattedFromHtml,
          formattedFromPlainText,
        ]);

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
        ) && !bestFormatted;

        if (!bestFormatted || looksLikeJsPage) {
          return {
            error: "This job posting requires JavaScript to load. Paste the content below instead.",
            success: null,
            fetchFailed: true,
          };
        }

        content = bestFormatted;
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
        error: "No posting URL set. Paste the job posting content below instead.",
        success: null,
        fetchFailed: true,
      };
    } else {
      return {
        error: "Too little content to format — paste the full job posting text (at least a few sentences).",
        success: null,
        fetchFailed: true,
      };
    }

    const formatted = formatJobDescriptionText(content);
    const structuredBlocks = parseJobDescriptionBlocks(formatted);

    if (
      !formatted ||
      formatted.length < 120 ||
      isLowQualityJobDescription(formatted) ||
      structuredBlocks.length === 0 ||
      !isJobDescriptionSummaryUsable(formatted)
    ) {
      return {
        error: "The fetched page didn't contain enough job details. Paste the full posting text below instead.",
        success: null,
        fetchFailed: true,
      };
    }

    await updateTrackedApplicationField({
      applicationId,
      field: "jobDescription",
      value: formatted,
    });

    revalidateApplication(applicationId);
    return { error: null, success: "Job description imported and organized." };
  } catch (error) {
    return toActionState(error);
  }
}
