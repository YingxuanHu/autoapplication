import Link from "next/link";
import { connection } from "next/server";
import { formatDisplayLabel, formatRelativeAge } from "@/lib/job-display";
import { getIngestionOverview } from "@/lib/queries/ingestion";
import type { IngestionRunListItem, IngestionSourceCoverage } from "@/lib/ingestion/types";

export default async function IngestionOpsPage() {
  await connection();
  const overview = await getIngestionOverview();
  const scheduledSourceCount = overview.sources.filter((s) => s.isScheduled).length;
  const activeCanonicalCount = overview.liveCount + overview.staleCount;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ingestion Ops</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connector coverage, recent runs, and live-pool footprint.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/ops/ranking"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ranking
          </Link>
          <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
            Feed
          </Link>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-t border-border py-4 sm:grid-cols-4">
        <Field label="Raw jobs" value={String(overview.rawCount)} />
        <Field label="Live / active" value={`${overview.liveCount} / ${activeCanonicalCount}`} />
        <Field label="Scheduled sources" value={String(scheduledSourceCount)} />
        <Field
          label="Stale / expired / removed"
          value={`${overview.staleCount} / ${overview.expiredCount} / ${overview.removedCount}`}
        />
      </div>

      {/* Classification split */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Classification split
        </p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          <Field label="Auto-apply eligible" value={String(overview.autoEligibleCount)} />
          <Field label="Review required" value={String(overview.reviewRequiredCount)} />
          <Field label="Manual only" value={String(overview.manualOnlyCount)} />
          <Field label="Source mappings" value={String(overview.sourceMappingCount)} />
        </div>
      </div>

      {/* Source coverage */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Connector coverage
        </p>
        <div className="space-y-4">
          {overview.sources.map((source) => (
            <SourceCoverageRow key={source.sourceName} source={source} />
          ))}
        </div>
      </div>

      {/* Recent runs */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent runs
          <span className="ml-1.5 opacity-60">{overview.recentRunCount}</span>
        </p>
        {overview.recentRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ingestion runs recorded yet. Use{" "}
            <code className="text-xs">npm run ingest -- greenhouse --board=vercel</code> to create
            the first tracked run.
          </p>
        ) : (
          <div className="space-y-4">
            {overview.recentRuns.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceCoverageRow({ source }: { source: IngestionSourceCoverage }) {
  return (
    <div className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-foreground">{source.sourceName}</p>
        {source.lastRunStatus ? (
          <span className={`text-xs font-medium ${runStatusColor(source.lastRunStatus)}`}>
            {formatDisplayLabel(source.lastRunStatus)}
          </span>
        ) : null}
        {source.isScheduled ? (
          <span className="text-xs text-muted-foreground">
            · Scheduled every {source.scheduleCadenceMinutes}m
          </span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-x-6 gap-y-1 sm:grid-cols-5">
        <SmallField label="Raw" value={source.rawCount} />
        <SmallField label="Active mappings" value={source.activeMappingCount} />
        <SmallField label="Live canonical" value={source.liveCanonicalCount} />
        <SmallField label="Stale" value={source.staleCanonicalCount} />
        <SmallField label="Removed" value={source.removedMappingCount} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {source.lastRunStartedAt
          ? `Last run ${formatRelativeAge(source.lastRunStartedAt)}`
          : "No tracked runs yet"}
        {source.lastSuccessfulRunAt
          ? ` · last success ${formatRelativeAge(source.lastSuccessfulRunAt)}`
          : ""}
      </p>
    </div>
  );
}

function RunRow({ run }: { run: IngestionRunListItem }) {
  return (
    <div className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-foreground">{run.sourceName}</p>
        <span className={`text-xs font-medium ${runStatusColor(run.status)}`}>
          {formatDisplayLabel(run.status)}
        </span>
        <span className="text-xs text-muted-foreground">{formatDisplayLabel(run.sourceTier)}</span>
        <span className="text-xs text-muted-foreground">{formatDisplayLabel(run.runMode)}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <SmallField label="Fetched" value={run.fetchedCount} />
        <SmallField label="Accepted" value={run.acceptedCount} />
        <SmallField label="Created" value={run.canonicalCreatedCount} />
        <SmallField label="Updated" value={run.canonicalUpdatedCount} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        <span>Rejected: {run.rejectedCount}</span>
        <span>Deduped: {run.dedupedCount}</span>
        <span>
          Mappings +{run.sourceMappingCreatedCount} ~{run.sourceMappingUpdatedCount} -{run.sourceMappingsRemovedCount}
        </span>
        <span>
          Live/stale/expired/removed: {run.liveCount}/{run.staleCount}/{run.expiredCount}/{run.removedCount}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Started {formatRelativeAge(run.startedAt)}
        {run.endedAt ? ` · ${formatRunDuration(run.startedAt, run.endedAt)}` : ""}
      </p>
      {run.errorSummary ? (
        <p className="mt-1 text-xs text-destructive">{run.errorSummary}</p>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function SmallField({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function runStatusColor(status: string) {
  if (status === "SUCCESS") return "text-emerald-600";
  if (status === "FAILED") return "text-destructive";
  return "text-muted-foreground";
}

function formatRunDuration(startedAt: string, endedAt: string) {
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
