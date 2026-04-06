export default function JobsLoading() {
  return (
    <div className="app-page space-y-6">
      <header className="page-header">
        <div className="space-y-2">
          <div className="h-8 w-24 animate-pulse rounded-lg bg-muted" />
          <div className="h-4 w-[32rem] max-w-full animate-pulse rounded bg-muted" />
        </div>
      </header>

      <section className="surface-panel p-4 sm:p-5">
        <div className="space-y-3">
          <div className="h-10 w-64 max-w-full animate-pulse rounded-xl bg-muted sm:h-12 sm:w-80" />
          <div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
          <div className="flex flex-wrap gap-3">
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-3 w-48 animate-pulse rounded bg-muted" />
        </div>

        <div className="mt-5 space-y-4 border-t border-border/60 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="h-10 min-w-0 flex-1 animate-pulse rounded-xl bg-muted" />
            <div className="h-10 w-24 animate-pulse rounded-xl bg-muted" />
            <div className="h-10 w-28 animate-pulse rounded-xl bg-muted" />
            <div className="h-10 w-36 animate-pulse rounded-xl bg-muted" />
            <div className="h-10 w-20 animate-pulse rounded-xl bg-muted" />
          </div>

          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                className="h-9 animate-pulse rounded-xl border border-border/60 bg-muted/70"
                key={index}
                style={{ width: `${88 + index * 18}px` }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="surface-panel p-4 sm:p-5">
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <JobRowSkeleton index={index} key={index} />
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="h-4 w-28 animate-pulse rounded bg-muted" />
          <div className="flex items-center gap-2">
            <div className="h-8 w-20 animate-pulse rounded-lg bg-muted" />
            <div className="h-8 w-16 animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      </section>
    </div>
  );
}

function JobRowSkeleton({ index }: { index: number }) {
  const titleWidths = ["w-3/5", "w-2/3", "w-[58%]", "w-1/2"];
  const metaWidths = ["w-72", "w-80", "w-64", "w-76"];
  const footerWidths = ["w-44", "w-56", "w-48", "w-52"];

  return (
    <div className="rounded-2xl border border-border/70 bg-background/45 p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <div
              className={`h-5 max-w-full animate-pulse rounded bg-muted ${titleWidths[index % titleWidths.length]}`}
            />
            <div className="h-4 w-20 animate-pulse rounded-full bg-muted" />
          </div>

          <div
            className={`h-4 max-w-full animate-pulse rounded bg-muted ${metaWidths[index % metaWidths.length]}`}
          />

          <div className="flex flex-wrap items-center gap-2">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1 animate-pulse rounded-full bg-muted" />
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1 animate-pulse rounded-full bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          </div>

          <div
            className={`h-3 max-w-full animate-pulse rounded bg-muted ${footerWidths[index % footerWidths.length]}`}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2 self-start">
          <div className="h-8 w-20 animate-pulse rounded-lg bg-muted" />
          <div className="h-8 w-28 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    </div>
  );
}
