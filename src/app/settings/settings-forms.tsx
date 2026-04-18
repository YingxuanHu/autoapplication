"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { KeyRound, LoaderCircle } from "lucide-react";

import { useNotifications } from "@/components/ui/notification-provider";
import { cn } from "@/lib/utils";

import { initialSettingsState, type SettingsActionState } from "./action-state";
import {
  saveAccountSettings,
  saveAutomationSettings,
  saveNotificationSettings,
  savePreferencesSettings,
} from "./actions";

// ─── Shared feedback hook ──────────────────────────────────────────

function useSettingsFeedback(
  state: SettingsActionState,
  { resetKey }: { resetKey?: string } = {}
) {
  const { notify } = useNotifications();
  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    const key = `${resetKey ?? ""}::${state.success ?? ""}::${state.error ?? ""}`;
    if (!state.success && !state.error) {
      lastKeyRef.current = key;
      return;
    }
    if (key === lastKeyRef.current) {
      return;
    }
    lastKeyRef.current = key;

    if (state.success) {
      notify({ tone: "success", title: "Saved", message: state.success });
    } else if (state.error) {
      notify({ tone: "error", title: "Save failed", message: state.error });
    }
  }, [notify, resetKey, state.error, state.success]);
}

// ─── Save button (shares pending state via useFormStatus) ──────────

function SaveButton({ label = "Save" }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <>
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          Saving...
        </>
      ) : (
        label
      )}
    </button>
  );
}

// ─── Account section ───────────────────────────────────────────────

export function AccountForm({
  defaultName,
  email,
}: {
  defaultName: string;
  email: string;
}) {
  const [state, formAction] = useActionState(
    saveAccountSettings,
    initialSettingsState
  );
  useSettingsFeedback(state);

  return (
    <form action={formAction} className="mt-4 grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="settings-name"
          >
            Display name
          </label>
          <input
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaultName}
            id="settings-name"
            maxLength={100}
            name="name"
            placeholder="Your name"
            required
            type="text"
          />
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Email
          </p>
          <div className="mt-1 flex h-9 items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 text-sm text-foreground">
            <span className="truncate">{email}</span>
            <Link
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              href="/forgot-password"
            >
              <KeyRound className="h-3 w-3" />
              Change password
            </Link>
          </div>
        </div>
      </div>
      <div>
        <SaveButton label="Save account" />
      </div>
    </form>
  );
}

// ─── Preferences section ───────────────────────────────────────────

const WORK_MODE_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "REMOTE", label: "Remote" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "ONSITE", label: "On-site" },
  { value: "FLEXIBLE", label: "Flexible" },
] as const;

const EXPERIENCE_LEVEL_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "ENTRY", label: "Entry level" },
  { value: "MID", label: "Mid level" },
  { value: "SENIOR", label: "Senior" },
  { value: "LEAD", label: "Lead / Staff" },
  { value: "EXECUTIVE", label: "Executive" },
] as const;

export function PreferencesForm({
  defaults,
}: {
  defaults: {
    preferredWorkMode: string;
    experienceLevel: string;
    salaryMin: string;
    salaryMax: string;
    salaryCurrency: string;
    location: string;
    workAuthorization: string;
  };
}) {
  const [state, formAction] = useActionState(
    savePreferencesSettings,
    initialSettingsState
  );
  useSettingsFeedback(state);

  return (
    <form action={formAction} className="mt-4 grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-work-mode"
          >
            Preferred work mode
          </label>
          <select
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.preferredWorkMode}
            id="pref-work-mode"
            name="preferredWorkMode"
          >
            {WORK_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-experience"
          >
            Experience level
          </label>
          <select
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.experienceLevel}
            id="pref-experience"
            name="experienceLevel"
          >
            {EXPERIENCE_LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-salary-min"
          >
            Target salary min
          </label>
          <input
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.salaryMin}
            id="pref-salary-min"
            inputMode="numeric"
            min={0}
            name="salaryMin"
            placeholder="80000"
            type="number"
          />
        </div>
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-salary-max"
          >
            Target salary max
          </label>
          <input
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.salaryMax}
            id="pref-salary-max"
            inputMode="numeric"
            min={0}
            name="salaryMax"
            placeholder="150000"
            type="number"
          />
        </div>
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-currency"
          >
            Currency
          </label>
          <select
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.salaryCurrency}
            id="pref-currency"
            name="salaryCurrency"
          >
            <option value="USD">USD</option>
            <option value="CAD">CAD</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-location"
          >
            Location
          </label>
          <input
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.location}
            id="pref-location"
            maxLength={120}
            name="location"
            placeholder="Toronto, ON"
            type="text"
          />
        </div>
        <div>
          <label
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="pref-work-auth"
          >
            Work authorization
          </label>
          <input
            className="mt-1 h-9 w-full rounded-lg border border-border/70 bg-background/70 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
            defaultValue={defaults.workAuthorization}
            id="pref-work-auth"
            maxLength={120}
            name="workAuthorization"
            placeholder="US citizen, Canadian PR, etc."
            type="text"
          />
        </div>
      </div>

      <div>
        <SaveButton label="Save preferences" />
      </div>
    </form>
  );
}

// ─── Automation section ────────────────────────────────────────────

const AUTOMATION_MODE_OPTIONS = [
  {
    value: "DISCOVERY_ONLY",
    label: "Discovery only",
    description:
      "Surface and rank relevant jobs. Never prepare or submit an application on your behalf.",
  },
  {
    value: "ASSIST",
    label: "Assist",
    description:
      "Pre-fill application materials and draft tailored content. You review and submit every application.",
  },
  {
    value: "REVIEW_BEFORE_SUBMIT",
    label: "Review before submit",
    description:
      "Prepare and stage applications automatically. Final submission waits for your approval.",
  },
  {
    value: "STRICT_AUTO_APPLY",
    label: "Strict auto-apply",
    description:
      "Auto-submit only for jobs that meet every quality guardrail. Review-required jobs still wait on you.",
  },
] as const;

export function AutomationForm({
  currentMode,
}: {
  currentMode: string;
}) {
  const [state, formAction] = useActionState(
    saveAutomationSettings,
    initialSettingsState
  );
  useSettingsFeedback(state);

  return (
    <form action={formAction} className="mt-4 grid gap-3">
      <div
        aria-label="Automation mode"
        className="grid gap-3 sm:grid-cols-2"
        role="radiogroup"
      >
        {AUTOMATION_MODE_OPTIONS.map((option) => {
          const isActive = currentMode === option.value;
          return (
            <label
              className={cn(
                "relative flex cursor-pointer flex-col gap-1 rounded-xl border px-4 py-3 transition-colors",
                isActive
                  ? "border-foreground bg-accent/40"
                  : "border-border/70 bg-background/60 hover:bg-accent/30"
              )}
              key={option.value}
            >
              <input
                className="sr-only"
                defaultChecked={isActive}
                name="automationMode"
                type="radio"
                value={option.value}
              />
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {option.label}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded-full border",
                    isActive ? "border-foreground" : "border-border"
                  )}
                >
                  {isActive ? (
                    <span className="h-2 w-2 rounded-full bg-foreground" />
                  ) : null}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
      <div>
        <SaveButton label="Save automation mode" />
      </div>
    </form>
  );
}

// ─── Notifications section ─────────────────────────────────────────

export function NotificationsForm({
  defaultEnabled,
}: {
  defaultEnabled: boolean;
}) {
  const [state, formAction] = useActionState(
    saveNotificationSettings,
    initialSettingsState
  );
  useSettingsFeedback(state);

  return (
    <form action={formAction} className="mt-4 grid gap-3">
      <label className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3 text-sm text-foreground">
        <input
          className="mt-1 h-4 w-4 rounded border border-input"
          defaultChecked={defaultEnabled}
          name="emailNotificationsEnabled"
          type="checkbox"
        />
        <span className="min-w-0">
          <span className="font-medium">Email deadline reminders</span>
          <span className="mt-0.5 block text-muted-foreground">
            Send reminder emails for upcoming and overdue tracked application
            deadlines.
          </span>
        </span>
      </label>
      <div>
        <SaveButton label="Save notifications" />
      </div>
    </form>
  );
}
