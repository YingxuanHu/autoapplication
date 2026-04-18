"use server";

import { revalidatePath } from "next/cache";

import { saveTrackerSettings } from "@/lib/queries/tracker";
import { UnauthorizedError } from "@/lib/current-user";

import type { SettingsActionState } from "./action-state";

function parseOptionalInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function handleError(error: unknown): SettingsActionState {
  if (error instanceof UnauthorizedError) {
    return { error: "Your session has expired. Sign in again.", success: null };
  }
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return { error: message, success: null };
}

export async function saveAccountSettings(
  _prev: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const nameRaw = formData.get("name");
    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!name) {
      return { error: "Name cannot be empty.", success: null };
    }

    await saveTrackerSettings({ name });
    revalidatePath("/settings");
    revalidatePath("/profile");
    return { error: null, success: "Account details updated." };
  } catch (error) {
    return handleError(error);
  }
}

export async function savePreferencesSettings(
  _prev: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const preferredWorkModeRaw = formData.get("preferredWorkMode");
    const experienceLevelRaw = formData.get("experienceLevel");
    const salaryMin = parseOptionalInt(formData.get("salaryMin"));
    const salaryMax = parseOptionalInt(formData.get("salaryMax"));

    if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
      return {
        error: "Minimum salary cannot exceed maximum salary.",
        success: null,
      };
    }

    await saveTrackerSettings({
      preferredWorkMode:
        typeof preferredWorkModeRaw === "string" && preferredWorkModeRaw
          ? (preferredWorkModeRaw as
              | "REMOTE"
              | "HYBRID"
              | "ONSITE"
              | "FLEXIBLE"
              | "UNKNOWN")
          : null,
      experienceLevel:
        typeof experienceLevelRaw === "string" && experienceLevelRaw
          ? (experienceLevelRaw as
              | "ENTRY"
              | "MID"
              | "SENIOR"
              | "LEAD"
              | "EXECUTIVE"
              | "UNKNOWN")
          : null,
      salaryMin,
      salaryMax,
      salaryCurrency:
        typeof formData.get("salaryCurrency") === "string"
          ? String(formData.get("salaryCurrency"))
          : undefined,
      location:
        typeof formData.get("location") === "string"
          ? String(formData.get("location"))
          : undefined,
      workAuthorization:
        typeof formData.get("workAuthorization") === "string"
          ? String(formData.get("workAuthorization"))
          : undefined,
    });
    revalidatePath("/settings");
    revalidatePath("/profile");
    revalidatePath("/jobs");
    return { error: null, success: "Job preferences saved." };
  } catch (error) {
    return handleError(error);
  }
}

export async function saveAutomationSettings(
  _prev: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const raw = formData.get("automationMode");
    await saveTrackerSettings({
      automationMode:
        typeof raw === "string" && raw
          ? (raw as
              | "DISCOVERY_ONLY"
              | "ASSIST"
              | "REVIEW_BEFORE_SUBMIT"
              | "STRICT_AUTO_APPLY")
          : "REVIEW_BEFORE_SUBMIT",
    });
    revalidatePath("/settings");
    revalidatePath("/jobs");
    return { error: null, success: "Automation mode updated." };
  } catch (error) {
    return handleError(error);
  }
}

export async function saveNotificationSettings(
  _prev: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    await saveTrackerSettings({
      emailNotificationsEnabled:
        formData.get("emailNotificationsEnabled") === "on",
    });
    revalidatePath("/settings");
    revalidatePath("/notifications");
    return { error: null, success: "Notification preferences saved." };
  } catch (error) {
    return handleError(error);
  }
}
