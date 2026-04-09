import Link from "next/link";
import { connection } from "next/server";
import { getDiscoveryOpsOverview } from "@/lib/queries/discovery-ops";

export default async function DiscoveryOpsPage() {
  await connection();
  const overview = await getDiscoveryOpsOverview();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Discovery Ops</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Companies, company-backed sources, and queue backlog for the discovery network.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/ops/ingestion"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ingestion
          </Link>
          <Link
            href="/ops/health"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Health
          </Link>
          <Link
            href="/ops/ranking"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ranking
          </Link>
        </div>
      </div>

      <section className="grid gap-4 border-t border-border py-4 sm:grid-cols-3">
        <SummaryCard
          title="Companies"
          rows={overview.companyCounts.map((row) => ({
            label: row.discoveryStatus,
            value: row._count._all,
          }))}
        />
        <SummaryCard
          title="Company Sources"
          rows={overview.sourceCounts.map((row) => ({
            label: `${row.status} · ${row.extractionRoute}`,
            value: row._count._all,
          }))}
        />
        <SummaryCard
          title="Task Queue"
          rows={overview.taskCounts.map((row) => ({
            label: `${row.kind} · ${row.status}`,
            value: row._count._all,
          }))}
        />
      </section>

      <section className="grid gap-4 border-t border-border py-4 sm:grid-cols-4">
        <SummaryCard
          title="Source Funnel"
          rows={[
            { label: "Companies discovered", value: overview.sourceFunnel.companiesDiscovered },
            { label: "Sources provisioned", value: overview.sourceFunnel.sourcesProvisioned },
            { label: "Unvalidated", value: overview.sourceFunnel.sourcesUnvalidated },
            { label: "Validated", value: overview.sourceFunnel.sourcesValidated },
            { label: "Ready", value: overview.sourceFunnel.sourcesReady },
            { label: "Tracked polls", value: overview.sourceFunnel.sourcesTrackedPolls },
            {
              label: "Polled successfully",
              value: overview.sourceFunnel.sourcesPolledSuccessfully,
            },
            { label: "Yielded jobs", value: overview.sourceFunnel.sourcesYieldedJobs },
            {
              label: "Yielded retained live jobs",
              value: overview.sourceFunnel.sourcesYieldedRetainedLiveJobs,
            },
          ]}
        />
        <div className="rounded-2xl border border-border p-4 sm:col-span-3">
          <h2 className="text-sm font-medium text-foreground">Vendor yield</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs text-muted-foreground">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">Vendor</th>
                  <th className="py-2 pr-3 font-medium">Sources</th>
                  <th className="py-2 pr-3 font-medium">Tracked</th>
                  <th className="py-2 pr-3 font-medium">Avg yield</th>
                  <th className="py-2 pr-3 font-medium">Val success</th>
                  <th className="py-2 pr-3 font-medium">Poll success</th>
                  <th className="py-2 pr-3 font-medium">Fetched</th>
                  <th className="py-2 pr-3 font-medium">Accepted</th>
                  <th className="py-2 pr-3 font-medium">Created</th>
                  <th className="py-2 pr-3 font-medium">Created / poll</th>
                  <th className="py-2 pr-3 font-medium">Tracked retained</th>
                  <th className="py-2 pr-0 font-medium">Historical retained</th>
                </tr>
              </thead>
              <tbody>
                {overview.vendorPerformance.slice(0, 12).map((row) => (
                  <tr key={row.connectorName} className="border-b border-border/40">
                    <td className="py-2 pr-3 text-foreground">{row.connectorName}</td>
                    <td className="py-2 pr-3">{row.sourceCount}</td>
                    <td className="py-2 pr-3">{row.trackedSourceCount}</td>
                    <td className="py-2 pr-3">{Math.round(row.averageYieldScore * 100)}%</td>
                    <td className="py-2 pr-3">
                      {Math.round(row.validationSuccessRate * 100)}%
                    </td>
                    <td className="py-2 pr-3">{Math.round(row.pollSuccessRate * 100)}%</td>
                    <td className="py-2 pr-3">{row.jobsFetched}</td>
                    <td className="py-2 pr-3">{row.jobsAccepted}</td>
                    <td className="py-2 pr-3">{row.jobsCreated}</td>
                    <td className="py-2 pr-3">
                      {row.createdPerSuccessfulPoll.toFixed(1)}
                    </td>
                    <td className="py-2 pr-3 text-foreground">{row.trackedRetainedLiveJobs}</td>
                    <td className="py-2 pr-0 text-foreground">{row.retainedLiveJobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tracked retained counts only sources with at least one managed poll attempt. Historical
            retained includes older mappings that existed before yield counters were added.
          </p>
        </div>
      </section>

      <section className="grid gap-6 border-t border-border py-4 lg:grid-cols-2">
        <div>
          <h2 className="text-sm font-medium text-foreground">Recent companies</h2>
          <div className="mt-3 space-y-3">
            {overview.recentCompanies.map((company) => (
              <div key={company.id} className="rounded-2xl border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{company.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {company.domain ?? "No domain"} · {company.discoveryStatus} ·{" "}
                      {company.crawlStatus}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{company.detectedAts ?? "No ATS"}</div>
                    <div>{Math.round(company.discoveryConfidence * 100)}% confidence</div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Jobs {company._count.jobs} · Sources {company._count.sources} · Pages{" "}
                  {company._count.discoveryPages}
                </div>
                {company.careersUrl ? (
                  <div className="mt-2 truncate text-xs text-muted-foreground">
                    {company.careersUrl}
                  </div>
                ) : null}
                {company.lastDiscoveryError ? (
                  <div className="mt-2 text-xs text-destructive">
                    {company.lastDiscoveryError}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-medium text-foreground">Recent company sources</h2>
          <div className="mt-3 space-y-3">
            {overview.recentSources.map((source) => (
              <div key={source.id} className="rounded-2xl border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{source.sourceName}</div>
                    <div className="text-xs text-muted-foreground">
                      {source.company.name} · {source.status} · {source.extractionRoute}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{source.connectorName}</div>
                    <div>
                      Priority {source.priorityScore.toFixed(2)} · Yield{" "}
                      {Math.round(source.yieldScore * 100)}%
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {source.sourceType ?? "Unknown type"} · {source.validationState} ·{" "}
                  {source.pollState} · cadence {source.pollingCadenceMinutes ?? "—"}m
                </div>
                <div className="mt-2 truncate text-xs text-muted-foreground">
                  {source.boardUrl}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Cooldown {source.cooldownUntil?.toLocaleString() ?? "none"} · overlap{" "}
                  {source.overlapRatio != null ? source.overlapRatio.toFixed(2) : "—"}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <div>
                    Validation {source.validationSuccessCount}/{source.validationAttemptCount}
                  </div>
                  <div>Polls {source.pollSuccessCount}/{source.pollAttemptCount}</div>
                  <div>Accepted {source.jobsAcceptedCount}</div>
                  <div>Retained live {source.retainedLiveJobCount}</div>
                  <div>Last fetched {source.lastJobsFetchedCount}</div>
                  <div>Last accepted {source.lastJobsAcceptedCount}</div>
                  <div>Last created {source.lastJobsCreatedCount}</div>
                  <div>Failures {source.consecutiveFailures}</div>
                </div>
                {source.validationMessage ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {source.validationMessage}
                  </div>
                ) : null}
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
