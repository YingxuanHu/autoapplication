"use server";

import type {
  TrackedApplicationDocumentSlot,
  TrackedApplicationEventType,
  TrackedApplicationStatus,
} from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  addTrackedApplicationEvent,
  createTrackedApplication,
  deleteTrackedApplication,
  deleteTrackedApplicationEvent,
  linkTrackedApplicationDocument,
  setTrackedApplicationTags,
  unlinkTrackedApplicationDocument,
  updateTrackedApplication,
} from "@/lib/queries/tracker";

type TrackerActionState = {
  error: string | null;
  success: string | null;
};

const statusOptions = new Set<TrackedApplicationStatus>([
  "WISHLIST",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
]);

const eventOptions = new Set<TrackedApplicationEventType>([
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "NOTE",
  "REMINDER",
]);

const slotOptions = new Set<TrackedApplicationDocumentSlot>([
  "SENT_RESUME",
  "SENT_COVER_LETTER",
]);

function parseDate(rawValue: FormDataEntryValue | null) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date.");
  }

  return parsed;
}

function parseDateTime(rawValue: FormDataEntryValue | null) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid reminder time.");
  }

  return parsed;
}

function revalidateTrackerPaths(applicationId?: string) {
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
  revalidatePath("/notifications");
  if (applicationId) {
    revalidatePath(`/applications/${applicationId}`);
    revalidatePath(`/dashboard/${applicationId}`);
  }
}

function toActionState(error: unknown): TrackerActionState {
  return {
    error: error instanceof Error ? error.message : "Request failed.",
    success: null,
  };
}

export async function createTrackedApplicationAction(
  _previousState: TrackerActionState,
  formData: FormData
): Promise<TrackerActionState> {
  try {
    const company = String(formData.get("company") ?? "").trim();
    const roleTitle = String(formData.get("roleTitle") ?? "").trim();
    const roleUrl = String(formData.get("roleUrl") ?? "").trim() || null;
    const statusRaw = String(formData.get("status") ?? "WISHLIST").trim().toUpperCase();
    const notes = String(formData.get("notes") ?? "").trim() || null;

    if (!company || !roleTitle) {
      return { error: "Company and role title are required.", success: null };
    }

    if (!statusOptions.has(statusRaw as TrackedApplicationStatus)) {
      return { error: "Invalid status.", success: null };
    }

    await createTrackedApplication({
      company,
      roleTitle,
      roleUrl,
      status: statusRaw as TrackedApplicationStatus,
      deadline: parseDate(formData.get("deadline")),
      notes,
    });

    revalidateTrackerPaths();
    return {
      error: null,
      success: "Tracked application added.",
    };
  } catch (error) {
    return toActionState(error);
  }
}

export async function saveTrackedApplicationAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();

  try {
    const company = String(formData.get("company") ?? "").trim();
    const roleTitle = String(formData.get("roleTitle") ?? "").trim();
    const statusRaw = String(formData.get("status") ?? "").trim().toUpperCase();

    if (!applicationId || !company || !roleTitle) {
      return;
    }

    if (!statusOptions.has(statusRaw as TrackedApplicationStatus)) {
      return;
    }

    await updateTrackedApplication({
      applicationId,
      company,
      roleTitle,
      roleUrl: String(formData.get("roleUrl") ?? "").trim() || null,
      status: statusRaw as TrackedApplicationStatus,
      deadline: parseDate(formData.get("deadline")),
      notes: String(formData.get("notes") ?? "").trim() || null,
      jobDescription: String(formData.get("jobDescription") ?? "").trim() || null,
      fitAnalysis: String(formData.get("fitAnalysis") ?? "").trim() || null,
    });
    await setTrackedApplicationTags({
      applicationId,
      tags: String(formData.get("tags") ?? ""),
    });
    revalidateTrackerPaths(applicationId);
  } catch (error) {
    console.error("saveTrackedApplicationAction failed:", error);
  }
}

export async function deleteTrackedApplicationAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  if (!applicationId) return;

  try {
    await deleteTrackedApplication(applicationId);
    revalidateTrackerPaths();
  } catch (error) {
    console.error("deleteTrackedApplicationAction failed:", error);
  }

  redirect("/applications");
}

export async function saveTrackedTagsAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  if (!applicationId) return;

  try {
    await setTrackedApplicationTags({
      applicationId,
      tags: String(formData.get("tags") ?? ""),
    });
    revalidateTrackerPaths(applicationId);
  } catch (error) {
    console.error("saveTrackedTagsAction failed:", error);
  }
}

export async function addTrackedEventAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const typeRaw = String(formData.get("type") ?? "").trim().toUpperCase();
  if (!applicationId || !eventOptions.has(typeRaw as TrackedApplicationEventType)) {
    return;
  }

  try {
    await addTrackedApplicationEvent({
      applicationId,
      type: typeRaw as TrackedApplicationEventType,
      note: String(formData.get("note") ?? "").trim() || null,
      reminderAt: parseDateTime(formData.get("reminderAt")),
    });
    revalidateTrackerPaths(applicationId);
  } catch (error) {
    console.error("addTrackedEventAction failed:", error);
  }
}

export async function deleteTrackedEventAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const eventId = String(formData.get("eventId") ?? "").trim();
  if (!applicationId || !eventId) return;

  try {
    await deleteTrackedApplicationEvent({
      applicationId,
      eventId,
    });
    revalidateTrackerPaths(applicationId);
  } catch (error) {
    console.error("deleteTrackedEventAction failed:", error);
  }
}

export async function linkTrackedDocumentAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const documentId = String(formData.get("documentId") ?? "").trim();
  const slotRaw = String(formData.get("slot") ?? "").trim();
  if (!applicationId || !documentId || !slotOptions.has(slotRaw as TrackedApplicationDocumentSlot)) {
    return;
  }

  try {
    await linkTrackedApplicationDocument({
      applicationId,
      documentId,
      slot: slotRaw as TrackedApplicationDocumentSlot,
    });
    revalidateTrackerPaths(applicationId);
  } catch (error) {
    console.error("linkTrackedDocumentAction failed:", error);
  }
}

export async function unlinkTrackedDocumentAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const slotRaw = String(formData.get("slot") ?? "").trim();
  if (!applicationId || !slotOptions.has(slotRaw as TrackedApplicationDocumentSlot)) {
    return;
  }

  try {
    await unlinkTrackedApplicationDocument({
      applicationId,
      slot: slotRaw as TrackedApplicationDocumentSlot,
    });
    revalidateTrackerPaths(applicationId);
  } catch (error) {
    console.error("unlinkTrackedDocumentAction failed:", error);
  }
}
