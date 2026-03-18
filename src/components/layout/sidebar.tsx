"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Layers,
  Search,
  FileText,
  File,
  User,
  Settings,
  Briefcase,
} from "lucide-react";

const navItems = [
  { label: "Feed", href: "/feed", icon: Layers },
  { label: "Jobs", href: "/jobs", icon: Search },
  { label: "Applications", href: "/applications", icon: FileText },
  { label: "Resumes", href: "/resumes", icon: File },
  { label: "Profile", href: "/profile", icon: User },
  { label: "Settings", href: "/settings", icon: Settings },
];

export { navItems };

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 z-30">
      <div className="flex flex-col flex-1 bg-sidebar border-r border-sidebar-border">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-6 h-16 border-b border-sidebar-border">
          <Briefcase className="size-6 text-sidebar-primary" />
          <span className="text-lg font-semibold text-sidebar-foreground tracking-tight">
            AutoApplication
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 flex flex-col gap-1 px-3 py-4">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-sidebar-border">
          <p className="text-xs text-sidebar-foreground/50">
            AutoApplication v0.1
          </p>
        </div>
      </div>
    </aside>
  );
}
