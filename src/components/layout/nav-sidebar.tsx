"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Briefcase,
  FileCheck2,
  GitCompareArrows,
  Settings,
  User,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Primary surfaces only. Admin/diagnostic routes (/ops/*) stay out of the
// primary nav, but document comparison is part of the main workspace.
const NAV_ITEMS = [
  { href: "/jobs", label: "Jobs", icon: Briefcase },
  { href: "/applications", label: "Applications", icon: FileCheck2 },
  { href: "/documents/compare", label: "Compare", icon: GitCompareArrows },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/profile", label: "Profile", icon: User },
  { href: "/settings", label: "Settings", icon: Settings },
];

const AUTH_ROUTES = new Set([
  "/",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/verify-email-required",
]);

export function NavSidebar() {
  const pathname = usePathname();
  const hideSidebar = Array.from(AUTH_ROUTES).some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );

  if (hideSidebar) {
    return null;
  }

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border/70 bg-sidebar/80 backdrop-blur-sm">
      <div className="px-4 py-5">
        <p className="px-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Workspace
        </p>
        <div className="mt-3 flex items-center gap-3 px-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-foreground text-background">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight text-foreground">AutoApplication</p>
            <p className="text-xs text-muted-foreground">Search, apply, track</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 pb-4">
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              )}
            >
              <item.icon className={cn("h-4 w-4", isActive ? "text-foreground" : "text-muted-foreground")} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
