"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";

import { UserMenu } from "@/components/layout/user-menu";
import { cn } from "@/lib/utils";

const AUTH_ROUTES = new Set([
  "/",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/verify-email-required",
]);

type SessionSnapshot = {
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
};

export function TopBarInner({
  user,
  unreadNotificationCount,
}: {
  user: SessionSnapshot | null;
  unreadNotificationCount: number;
}) {
  const pathname = usePathname();
  const hide = Array.from(AUTH_ROUTES).some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );

  if (hide) {
    return null;
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-sm sm:px-6">
      <div className="min-w-0" />

      <div className="flex items-center gap-2">
        {user ? (
          <>
            <Link
              aria-label={
                unreadNotificationCount > 0
                  ? `Notifications, ${unreadNotificationCount} unread`
                  : "Notifications"
              }
              className={cn(
                "relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground transition-colors",
                "hover:bg-accent/70 hover:text-foreground"
              )}
              href="/notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadNotificationCount > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground ring-2 ring-background">
                  {unreadNotificationCount > 99
                    ? "99+"
                    : unreadNotificationCount}
                </span>
              ) : null}
            </Link>
            <UserMenu user={user} />
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              href="/sign-in"
            >
              Sign in
            </Link>
            <Link
              className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
              href="/sign-up"
            >
              Sign up
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
