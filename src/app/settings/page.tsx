import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { DeleteAccountCard } from "@/components/profile/delete-account-card";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getTrackerSettingsData, saveTrackerSettings } from "@/lib/queries/tracker";

export default async function SettingsPage() {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  async function saveSettingsAction(formData: FormData) {
    "use server";

    await saveTrackerSettings({
      emailNotificationsEnabled:
        formData.get("emailNotificationsEnabled") === "on",
    });
    revalidatePath("/settings");
    revalidatePath("/notifications");
  }

  const { user } = await getTrackerSettingsData();
  if (!user) {
    redirect("/sign-in");
  }

  return (
    <div className="app-page space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-description">
            Account and notification preferences for the merged tracker.
          </p>
        </div>
        <div className="page-actions">
          <Link href="/applications">
            Applications
          </Link>
          <Link href="/notifications">
            Notifications
          </Link>
        </div>
      </div>

      <section className="surface-panel p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Account</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Name
            </p>
            <p className="mt-1 text-sm text-foreground">{user.name}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Email
            </p>
            <p className="mt-1 text-sm text-foreground">{user.email}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Verification
            </p>
            <p className="mt-1 text-sm text-foreground">
              {user.emailVerified ? "Verified" : "Pending"}
            </p>
          </div>
        </div>
      </section>

      <section className="surface-panel p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Appearance</h2>
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

      <section className="surface-panel p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
        <form action={saveSettingsAction} className="mt-4 grid gap-4">
          <label className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-4 text-sm text-foreground">
            <input
              type="checkbox"
              name="emailNotificationsEnabled"
              defaultChecked={user.emailNotificationsEnabled}
              className="mt-1 h-4 w-4 rounded border border-input"
            />
            <span>
              <span className="font-medium">Email deadline reminders</span>
              <span className="mt-1 block text-muted-foreground">
                Send reminder emails for upcoming and overdue tracked application deadlines.
              </span>
            </span>
          </label>

          <div>
            <button
              type="submit"
              className="h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background"
            >
              Save settings
            </button>
          </div>
        </form>
      </section>

      <section className="surface-panel p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Session</h2>
        <div className="mt-4">
          <SignOutButton />
        </div>
      </section>

      <div>
        <DeleteAccountCard email={user.email} />
      </div>
    </div>
  );
}
