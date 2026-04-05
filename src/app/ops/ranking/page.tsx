import Link from "next/link";
import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import { DEMO_SOURCE_NAMES } from "@/lib/job-links";
import {
  loadFeedPrefs,
  loadBehaviorProfile,
  scoreJobDetailed,
  type ScoreBreakdown,
} from "@/lib/queries/jobs";

const DEBUG_LIMIT = 50;

export default async function RankingDebugPage() {
  await connection();

  const [prefs, behavior, jobs] = await Promise.all([
    loadFeedPrefs(),
    loadBehaviorProfile(),
    prisma.jobCanonical.findMany({
      where: {
        status: "LIVE",
        behaviorSignals: {
          none: { userId: DEMO_USER_ID, action: "PASS" },
        },
        sourceMappings: {
          some: { sourceName: { notIn: [...DEMO_SOURCE_NAMES] } },
        },
      },
      select: {
        id: true,
        title: true,
        company: true,
        roleFamily: true,
        workMode: true,
        postedAt: true,
        eligibility: { select: { submissionCategory: true } },
        sourceMappings: {
          where: { removedAt: null },
          select: { sourceName: true },
        },
      },
    }),
  ]);

  type ScoredJob = {
    id: string;
    title: string;
    company: string;
    roleFamily: string | null;
    workMode: string | null;
    postedAt: Date | null;
    submissionCategory: string | null;
    sourceName: string | null;
    breakdown: ScoreBreakdown;
  };

  // Score all jobs once, then derive both the top-N list and distribution stats
  const allBreakdowns = jobs.map((job) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    roleFamily: job.roleFamily,
    workMode: job.workMode,
    postedAt: job.postedAt,
    submissionCategory: job.eligibility?.submissionCategory ?? null,
    sourceName: job.sourceMappings[0]?.sourceName ?? null,
    breakdown: scoreJobDetailed(job, prefs, behavior),
  }));

  const scored: ScoredJob[] = allBreakdowns
    .sort((a, b) => b.breakdown.total - a.breakdown.total)
    .slice(0, DEBUG_LIMIT);

  // Compute score distribution summary from the single scoring pass
  const allScores = allBreakdowns
    .map((j) => j.breakdown.total)
    .sort((a, b) => b - a);
  const maxScore = allScores[0] ?? 0;
  const minScore = allScores[allScores.length - 1] ?? 0;
  const medianScore = allScores[Math.floor(allScores.length / 2)] ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ranking Debug</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Score breakdown for the top {scored.length} of {jobs.length} live jobs.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/ops/ingestion"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ingestion
          </Link>
          <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
            Feed
          </Link>
        </div>
      </div>

      {/* Ranking inputs */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-t border-border py-4 sm:grid-cols-4">
        <Field
          label="Pref role families"
          value={prefs.roleFamilies.length > 0 ? prefs.roleFamilies.join(", ") : "—"}
        />
        <Field
          label="Pref work modes"
          value={prefs.workModes.length > 0 ? prefs.workModes.join(", ") : "—"}
        />
        <Field
          label="Behavior boosts (role)"
          value={
            behavior.boostedRoleFamilies.size > 0
              ? [...behavior.boostedRoleFamilies].join(", ")
              : "—"
          }
        />
        <Field
          label="Behavior boosts (company)"
          value={
            behavior.boostedCompanies.size > 0
              ? [...behavior.boostedCompanies].slice(0, 8).join(", ") +
                (behavior.boostedCompanies.size > 8
                  ? ` +${behavior.boostedCompanies.size - 8}`
                  : "")
              : "—"
          }
        />
        <Field
          label="Suppressed role families"
          value={
            behavior.suppressedRoleFamilies.size > 0
              ? [...behavior.suppressedRoleFamilies].join(", ")
              : "—"
          }
        />
        <Field
          label="Score range"
          value={`${minScore}–${maxScore} (median ${medianScore})`}
        />
        <Field label="Pool size" value={`${jobs.length} live jobs`} />
      </div>

      {/* Score table */}
      <div className="overflow-x-auto border-t border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">#</th>
              <th className="py-2 pr-3 font-medium">Total</th>
              <th className="py-2 pr-3 font-medium">Job</th>
              <th className="py-2 pr-2 font-medium text-center" title="Eligibility (0–20)">Elig</th>
              <th className="py-2 pr-2 font-medium text-center" title="Freshness (-10–20)">Fresh</th>
              <th className="py-2 pr-2 font-medium text-center" title="Pref: Role Family (0–15)">PrfRF</th>
              <th className="py-2 pr-2 font-medium text-center" title="Pref: Work Mode (0–10)">PrfWM</th>
              <th className="py-2 pr-2 font-medium text-center" title="Behavior: Role Family (0–8)">BhvRF</th>
              <th className="py-2 pr-2 font-medium text-center" title="Behavior: Company (0–6)">BhvCo</th>
              <th className="py-2 pr-2 font-medium text-center" title="Behavior: Suppression (-6–0)">Supp</th>
              <th className="py-2 pr-2 font-medium text-center" title="Source Trust (0–5)">Trust</th>
              <th className="py-2 pr-2 font-medium text-center" title="Multi-Source (0–3)">MSrc</th>
              <th className="py-2 pr-3 font-medium">Meta</th>
            </tr>
          </thead>
          <tbody>
            {scored.map((job, idx) => (
              <tr key={job.id} className="border-b border-border/40 hover:bg-muted/30">
                <td className="py-1.5 pr-3 text-xs text-muted-foreground">{idx + 1}</td>
                <td className="py-1.5 pr-3 font-mono text-xs font-semibold">
                  {job.breakdown.total}
                </td>
                <td className="py-1.5 pr-3 max-w-[200px]">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="text-xs font-medium text-foreground hover:underline underline-offset-2 truncate block"
                    title={job.title}
                  >
                    {job.title.length > 35 ? `${job.title.slice(0, 35)}…` : job.title}
                  </Link>
                  <span className="text-[11px] text-muted-foreground">{job.company}</span>
                </td>
                <ScoreCell value={job.breakdown.eligibility} max={20} />
                <ScoreCell value={job.breakdown.freshness} max={20} />
                <ScoreCell value={job.breakdown.prefRoleFamily} max={15} />
                <ScoreCell value={job.breakdown.prefWorkMode} max={10} />
                <ScoreCell value={job.breakdown.behaviorRoleFamily} max={8} />
                <ScoreCell value={job.breakdown.behaviorCompany} max={6} />
                <ScoreCell value={job.breakdown.behaviorSuppression} max={0} negative />
                <ScoreCell value={job.breakdown.sourceTrust} max={5} />
                <ScoreCell value={job.breakdown.multiSource} max={3} />
                <td className="py-1.5 pr-3 text-[11px] text-muted-foreground whitespace-nowrap">
                  {job.roleFamily ?? "—"} · {job.workMode ?? "—"} ·{" "}
                  {job.submissionCategory?.replace("AUTO_", "").replace("_READY", "").replace("_REVIEW", " rev") ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</dd>
    </div>
  );
}

function ScoreCell({
  value,
  max,
  negative,
}: {
  value: number;
  max: number;
  negative?: boolean;
}) {
  const isActive = negative ? value < 0 : value > 0;
  const isMax = !negative && value === max;
  return (
    <td
      className={`py-1.5 pr-2 text-center font-mono text-xs ${
        !isActive
          ? "text-muted-foreground/30"
          : negative
            ? "text-red-500 font-medium"
            : isMax
              ? "text-emerald-600 font-medium"
              : "text-foreground"
      }`}
    >
      {value}
    </td>
  );
}
