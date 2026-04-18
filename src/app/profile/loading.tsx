export default function ProfileLoading() {
  return (
    <div className="app-page space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-muted" />
      </div>

      {/* Resumes section skeleton */}
      <section className="surface-panel p-4 sm:p-5">
        <div className="h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/40 p-3"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              </div>
              <div className="h-8 w-20 animate-pulse rounded-md bg-muted" />
            </div>
          ))}
        </div>
      </section>

      {/* Cover letters section skeleton */}
      <section className="surface-panel p-4 sm:p-5">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4">
          <div className="h-10 w-40 animate-pulse rounded-md bg-muted" />
        </div>
      </section>

      {/* Profile data skeleton */}
      <section className="surface-panel p-4 sm:p-5">
        <div className="h-5 w-36 animate-pulse rounded bg-muted" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
