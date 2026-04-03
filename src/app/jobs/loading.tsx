export default function JobsLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header skeleton */}
      <div className="pb-4">
        <div className="h-6 w-16 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-48 animate-pulse rounded bg-muted" />
      </div>

      {/* Stats bar skeleton */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="h-3 w-12 animate-pulse rounded bg-muted" />
            <div className="mt-1.5 h-6 w-16 animate-pulse rounded bg-muted" />
            <div className="mt-1 h-3 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      {/* Filter pills skeleton */}
      <div className="flex gap-1 border-b border-border pb-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 w-16 animate-pulse rounded-md bg-muted" />
        ))}
      </div>

      {/* Job cards skeleton */}
      <div className="pt-1 space-y-0">
        {Array.from({ length: 8 }).map((_, i) => (
          <JobCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

function JobCardSkeleton() {
  return (
    <div className="border-b border-border py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="flex gap-2">
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex gap-1">
          <div className="h-8 w-8 animate-pulse rounded-md bg-muted" />
          <div className="h-8 w-8 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
    </div>
  );
}
