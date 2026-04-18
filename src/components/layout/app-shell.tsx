import { NavSidebar } from "./nav-sidebar";
import { TopBar } from "./top-bar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen">
        <NavSidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <TopBar />
          <div className="min-h-full flex-1">{children}</div>
        </main>
      </div>
    </div>
  );
}
