export default function ApplicationsLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="pb-4">
        <div className="h-6 w-32 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-56 animate-pulse rounded bg-muted" />
      </div>

      {/* Filter pills */}
      <div className="flex gap-1 border-b border-border pb-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-7 w-20 animate-pulse rounded-md bg-muted" />
        ))}
      </div>

      {/* Application rows */}
      <div className="pt-1 space-y-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border-b border-border py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
                </div>
                <div className="flex gap-2">
                  <div className="h-3 w-28 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                </div>
                <div className="h-3 w-40 animate-pulse rounded bg-muted" />
              </div>
              <div className="flex gap-2">
                <div className="h-8 w-20 animate-pulse rounded-md bg-muted" />
                <div className="h-8 w-16 animate-pulse rounded-md bg-muted" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
