import Link from "next/link";
import { connection } from "next/server";
import { getHealthOpsOverview } from "@/lib/queries/discovery-ops";

export default async function HealthOpsPage() {
  await connection();
  const overview = await getHealthOpsOverview();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Health Ops</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            URL health checks, lifecycle evidence, and jobs drifting toward stale or dead states.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/ops/discovery"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Discovery
          </Link>
          <Link
            href="/ops/ingestion"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ingestion
          </Link>
          <Link
            href="/ops/ranking"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ranking
          </Link>
        </div>
      </div>

      <section className="grid gap-4 border-t border-border py-4 sm:grid-cols-2">
        <SummaryCard
          title="Health checks"
          rows={overview.healthCounts.map((row) => ({
            label: `${row.result} · ${row.urlType}`,
            value: row._count._all,
          }))}
        />
        <SummaryCard
          title="Lifecycle states"
          rows={overview.lifecycleCounts.map((row) => ({
            label: row.status,
            value: row._count._all,
          }))}
        />
      </section>

      <section className="grid gap-6 border-t border-border py-4 lg:grid-cols-2">
        <div>
          <h2 className="text-sm font-medium text-foreground">Recent URL checks</h2>
          <div className="mt-3 space-y-3">
            {overview.recentChecks.map((check) => (
              <div key={check.id} className="rounded-2xl border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      {check.canonicalJob.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {check.canonicalJob.company} · {check.result} · {check.urlType}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{check.statusCode ?? "—"}</div>
                    <div>{check.checkedAt.toLocaleString()}</div>
                  </div>
                </div>
                {check.closureReason ? (
                  <div className="mt-2 text-xs text-muted-foreground">{check.closureReason}</div>
                ) : null}
                <div className="mt-2 truncate text-xs text-muted-foreground">
                  {check.finalUrl ?? "No final URL"}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-medium text-foreground">At-risk jobs</h2>
          <div className="mt-3 space-y-3">
            {overview.atRiskJobs.map((job) => (
              <div key={job.id} className="rounded-2xl border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{job.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {job.company} · {job.status}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>Availability {job.availabilityScore}</div>
                    <div>{job.lastApplyCheckAt?.toLocaleString() ?? "Never checked"}</div>
                  </div>
                </div>
                {job.deadSignalReason ? (
                  <div className="mt-2 text-xs text-destructive">{job.deadSignalReason}</div>
                ) : null}
                <div className="mt-2 text-xs text-muted-foreground">
                  Last alive {job.lastConfirmedAliveAt?.toLocaleString() ?? "No confirmation"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
}) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between text-sm text-muted-foreground"
          >
            <span>{row.label}</span>
            <span className="font-medium text-foreground">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
