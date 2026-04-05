import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getOptionalSessionUser } from "@/lib/current-user";
import {
  getNotificationCenterData,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/queries/tracker";

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export default async function NotificationsPage() {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  async function markAllAction() {
    "use server";

    await markAllNotificationsRead();
    revalidatePath("/notifications");
    revalidatePath("/dashboard");
  }

  async function markOneAction(formData: FormData) {
    "use server";

    const notificationId = String(formData.get("notificationId") ?? "").trim();
    if (!notificationId) return;

    await markNotificationRead(notificationId);
    revalidatePath("/notifications");
    revalidatePath("/dashboard");
  }

  const { notifications, unreadCount } = await getNotificationCenterData();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Deadline reminders and tracker updates.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link href="/dashboard" className="hover:text-foreground">
            Tracker
          </Link>
          <Link href="/settings" className="hover:text-foreground">
            Settings
          </Link>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </p>
          {unreadCount > 0 ? (
            <form action={markAllAction}>
              <button
                type="submit"
                className="h-9 rounded-lg border border-border px-4 text-sm font-medium"
              >
                Mark all as read
              </button>
            </form>
          ) : null}
        </div>

        {notifications.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No notifications yet.</p>
        ) : (
          <div className="mt-4 divide-y divide-border/60">
            {notifications.map((notification) => (
              <article key={notification.id} className="py-3 first:pt-0 last:pb-0">
                {notification.readAt ? (
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {notification.title}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {notification.message}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDateTime(notification.createdAt)}
                      </p>
                    </div>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                      Read
                    </span>
                  </div>
                ) : (
                  <form action={markOneAction}>
                    <input type="hidden" name="notificationId" value={notification.id} />
                    <button
                      type="submit"
                      className="w-full rounded-lg p-2 text-left transition hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {notification.title}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {notification.message}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatDateTime(notification.createdAt)}
                          </p>
                        </div>
                        <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] text-background">
                          Unread
                        </span>
                      </div>
                    </button>
                  </form>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
