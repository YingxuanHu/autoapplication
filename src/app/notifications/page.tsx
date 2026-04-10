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
    revalidatePath("/applications");
    revalidatePath("/dashboard");
  }

  async function markOneAction(formData: FormData) {
    "use server";

    const notificationId = String(formData.get("notificationId") ?? "").trim();
    if (!notificationId) return;

    await markNotificationRead(notificationId);
    revalidatePath("/notifications");
    revalidatePath("/applications");
    revalidatePath("/dashboard");
  }

  const { notifications, unreadCount } = await getNotificationCenterData();

  return (
    <div className="app-page space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-description">
            Deadline reminders and tracker updates.
          </p>
        </div>
        <div className="page-actions">
          <Link href="/applications">
            Applications
          </Link>
          <Link href="/settings">
            Settings
          </Link>
        </div>
      </div>

      <section className="surface-panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </p>
          {unreadCount > 0 ? (
            <form action={markAllAction}>
              <button
                type="submit"
                className="h-9 rounded-lg border border-border/70 bg-background/60 px-4 text-sm font-medium"
              >
                Mark all as read
              </button>
            </form>
          ) : null}
        </div>

        {notifications.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-border/70 bg-background/50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">No notifications yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Deadline reminders and tracker activity will appear here.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {notifications.map((notification) => (
              <article
                key={notification.id}
                className="rounded-2xl border border-border/60 bg-background/50 p-4"
              >
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
                      className="w-full rounded-xl px-1 py-1 text-left transition hover:bg-muted/40"
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
