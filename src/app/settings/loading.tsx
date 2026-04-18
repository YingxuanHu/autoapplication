export default function SettingsLoading() {
  return (
    <div className="app-page space-y-6">
      <div className="page-header">
        <div className="space-y-2">
          <div className="h-8 w-24 animate-pulse rounded bg-muted" />
          <div className="h-4 w-80 max-w-full animate-pulse rounded bg-muted" />
        </div>
      </div>

      {/* Account section */}
      <section className="surface-panel p-4 sm:p-5">
        <div className="h-4 w-20 animate-pulse rounded bg-muted" />
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </section>

      {/* Appearance */}
      <section className="surface-panel p-4 sm:p-5">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 px-4 py-4">
          <div className="space-y-2">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-3 w-64 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-8 w-28 animate-pulse rounded-md bg-muted" />
        </div>
      </section>

      {/* Notifications */}
      <section className="surface-panel p-4 sm:p-5">
        <div className="h-4 w-28 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-16 w-full animate-pulse rounded-xl bg-muted" />
      </section>
    </div>
  );
}
