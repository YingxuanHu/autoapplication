"use client";

import { useEffect, useState } from "react";
import { SessionProvider, signOut, useSession } from "next-auth/react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Toaster } from "@/components/ui/sonner";
import { Loader2 } from "lucide-react";

function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "authenticated" && !session?.user?.id) {
      void signOut({ callbackUrl: "/login" });
    }
  }, [session?.user?.id, status]);

  if (status === "authenticated" && !session?.user?.id) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Redirecting to login...
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Sidebar (desktop only) */}
      <Sidebar />

      {/* Mobile navigation */}
      <MobileNav
        isOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      {/* Main content area */}
      <div className="flex flex-col flex-1 md:pl-64">
        <Topbar onToggleMobileNav={() => setMobileNavOpen((prev) => !prev)} />

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>

      <Toaster richColors position="bottom-right" />
    </>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <DashboardShell>{children}</DashboardShell>
    </SessionProvider>
  );
}
