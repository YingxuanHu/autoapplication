export default function JobDetailLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Breadcrumb */}
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />

      {/* Header */}
      <div className="mt-6 space-y-2">
        <div className="h-7 w-3/4 animate-pulse rounded bg-muted" />
        <div className="flex gap-2">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>

      {/* Key fields grid */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-14 animate-pulse rounded bg-muted" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="mt-6 flex gap-2 border-t border-border pt-4">
        <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
        <div className="h-9 w-9 animate-pulse rounded-md bg-muted" />
        <div className="h-9 w-9 animate-pulse rounded-md bg-muted" />
      </div>

      {/* Description skeleton */}
      <div className="mt-6 space-y-2 border-t border-border pt-4">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="h-3.5 animate-pulse rounded bg-muted"
            style={{ width: `${65 + Math.random() * 35}%` }}
          />
        ))}
      </div>
    </div>
  );
}
