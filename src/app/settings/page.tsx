import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Bell,
  Briefcase,
  Download,
  ExternalLink,
  KeyRound,
  Mail,
  Palette,
  ShieldAlert,
  ShieldCheck,
  User as UserIcon,
  Wand2,
} from "lucide-react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { Avatar } from "@/components/layout/avatar";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { DeleteAccountCard } from "@/components/profile/delete-account-card";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getTrackerSettingsData } from "@/lib/queries/tracker";
import { cn } from "@/lib/utils";

import {
  AccountForm,
  AutomationForm,
  NotificationsForm,
  PreferencesForm,
} from "./settings-forms";

function formatMemberSince(value: Date | null | undefined) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
    }).format(value);
  } catch {
    return "—";
  }
}

export default async function SettingsPage() {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const { user, profile } = await getTrackerSettingsData();
  if (!user) {
    redirect("/sign-in");
  }

  const currentAutomation = profile?.automationMode ?? "REVIEW_BEFORE_SUBMIT";

  return (
    <div className="app-page space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-description">
            Manage your account, job preferences, automation guardrails, and
            workspace experience.
          </p>
        </div>
        <div className="page-actions">
          <Link href="/profile">Profile</Link>
          <Link href="/applications">Applications</Link>
          <Link href="/notifications">Notifications</Link>
        </div>
      </div>

      {/* Identity summary */}
      <section className="surface-panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Avatar
            email={user.email}
            image={user.image}
            name={user.name}
            size="lg"
          />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-foreground">
              {user.name || "Unnamed user"}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {user.email}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                  user.emailVerified
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-500"
                )}
              >
                <ShieldCheck className="h-3 w-3" />
                {user.emailVerified ? "Email verified" : "Email unverified"}
              </span>
              <span className="text-muted-foreground">
                Member since {formatMemberSince(user.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/70"
            href="/profile"
          >
            <UserIcon className="h-3.5 w-3.5" />
            Edit profile
          </Link>
          {!user.emailVerified ? (
            <Link
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-sm font-medium text-amber-500 transition-colors hover:bg-amber-500/20"
              href="/verify-email-required"
            >
              <Mail className="h-3.5 w-3.5" />
              Verify email
            </Link>
          ) : null}
        </div>
      </section>

      {/* Account */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Account</h2>
        </header>
        <p className="mt-1 text-sm text-muted-foreground">
          Your display name appears on documents, messages, and the user menu.
        </p>
        <AccountForm defaultName={user.name} email={user.email} />
      </section>

      {/* Job preferences */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Job preferences
          </h2>
        </header>
        <p className="mt-1 text-sm text-muted-foreground">
          These hints shape the feed ranking and the auto-apply eligibility
          checks.
        </p>
        <PreferencesForm
          defaults={{
            preferredWorkMode: profile?.preferredWorkMode ?? "",
            experienceLevel: profile?.experienceLevel ?? "",
            salaryMin:
              profile?.salaryMin !== null && profile?.salaryMin !== undefined
                ? String(profile.salaryMin)
                : "",
            salaryMax:
              profile?.salaryMax !== null && profile?.salaryMax !== undefined
                ? String(profile.salaryMax)
                : "",
            salaryCurrency: profile?.salaryCurrency ?? "USD",
            location: profile?.location ?? "",
            workAuthorization: profile?.workAuthorization ?? "",
          }}
        />
      </section>

      {/* Automation */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Automation mode
          </h2>
        </header>
        <p className="mt-1 text-sm text-muted-foreground">
          Control how aggressively the engine prepares and submits
          applications. Quality guardrails always override automation.
        </p>
        <AutomationForm currentMode={currentAutomation} />
      </section>

      {/* Notifications */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Notifications
          </h2>
        </header>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose when we email you. In-app notifications remain on for
          everyone.
        </p>
        <NotificationsForm defaultEnabled={user.emailNotificationsEnabled} />
      </section>

      {/* Appearance */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Appearance</h2>
        </header>
        <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border/60 bg-background/60 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Theme</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose light, dark, or system appearance for the workspace.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </section>

      {/* Privacy & Data */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <Download className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Privacy &amp; data
          </h2>
        </header>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-background/60 px-4 py-4">
            <p className="text-sm font-medium text-foreground">
              Export your data
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Download a copy of your profile, tracked applications, and
              notifications. We&apos;ll email you when the export is ready.
            </p>
            <button
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/70 disabled:opacity-60"
              disabled
              type="button"
            >
              <Download className="h-3 w-3" />
              Request export
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Coming soon.
            </p>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/60 px-4 py-4">
            <p className="text-sm font-medium text-foreground">
              Resumes &amp; documents
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Manage uploaded resumes and see what the engine uses for
              tailoring applications.
            </p>
            <Link
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/70"
              href="/documents/compare"
            >
              <ExternalLink className="h-3 w-3" />
              Open documents
            </Link>
          </div>
        </div>
      </section>

      {/* Session */}
      <section className="surface-panel p-5">
        <header className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Session</h2>
        </header>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign out of this device. Sessions on other devices are unaffected.
        </p>
        <div className="mt-4">
          <SignOutButton />
        </div>
      </section>

      {/* Danger zone */}
      <section className="space-y-2">
        <header className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-destructive" />
          <h2 className="text-sm font-semibold text-destructive">
            Danger zone
          </h2>
        </header>
        <DeleteAccountCard email={user.email} />
      </section>
    </div>
  );
}
