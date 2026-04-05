import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/auth/sign-out-button";
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
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Account and notification preferences for the merged tracker.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link href="/dashboard" className="hover:text-foreground">
            Tracker
          </Link>
          <Link href="/notifications" className="hover:text-foreground">
            Notifications
          </Link>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
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

      <section className="mt-6 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
        <form action={saveSettingsAction} className="mt-4 grid gap-4">
          <label className="flex items-start gap-3 text-sm text-foreground">
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

      <section className="mt-6 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Session</h2>
        <div className="mt-4">
          <SignOutButton />
        </div>
      </section>

      <div className="mt-6">
        <DeleteAccountCard email={user.email} />
      </div>
    </div>
  );
}
