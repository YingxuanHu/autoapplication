"use server";

import type { TrackedApplicationStatus } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";

import { createTrackedApplication } from "@/lib/queries/tracker";

type TrackerActionState = {
  error: string | null;
  success: string | null;
};

const statusOptions = new Set<TrackedApplicationStatus>([
  "WISHLIST",
  "PREPARING",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
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

function revalidateTrackerPaths() {
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
  revalidatePath("/notifications");
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
