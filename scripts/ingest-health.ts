/**
 * Ingestion health check.
 *
 * Reports at-a-glance status for the 300k pool:
 *  - LIVE job counts (total + last-24h delta)
 *  - Connector family last-run times (stalled if >2× cadence)
 *  - Pending task queue sizes
 *  - CompanySource status breakdown
 *
 *   npx tsx scripts/ingest-health.ts
 *   npx tsx scripts/ingest-health.ts --json
 */
import "dotenv/config";
import { prisma } from "@/lib/db";

type AggregatorExpectation = { connectorKey: string; cadenceMinutes: number };
const AGGREGATOR_EXPECTATIONS: AggregatorExpectation[] = [
  { connectorKey: "himalayas:feed", cadenceMinutes: 720 },
  { connectorKey: "themuse:feed", cadenceMinutes: 720 },
  { connectorKey: "remoteok:feed", cadenceMinutes: 720 },
  { connectorKey: "remotive:feed", cadenceMinutes: 720 },
  { connectorKey: "jobicy:feed", cadenceMinutes: 720 },
  { connectorKey: "weworkremotely:feed", cadenceMinutes: 360 },
];

async function main() {
  const jsonMode = process.argv.includes("--json");
  const now = new Date();

  const [liveCount, totalCount, createdLast24h] = await Promise.all([
    prisma.jobCanonical.count({ where: { status: "LIVE" } }),
    prisma.jobCanonical.count(),
    prisma.jobCanonical.count({
      where: { createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) } },
    }),
  ]);

  // Status breakdown
  const statusBreakdown = (await prisma.$queryRawUnsafe(
    `SELECT "status", COUNT(*)::int as n FROM "JobCanonical" GROUP BY "status" ORDER BY n DESC`
  )) as Array<{ status: string; n: number }>;

  // Per-aggregator last run
  const aggregatorStatus = [] as Array<{
    connectorKey: string;
    lastRun: string | null;
    status: string | null;
    fetched: number | null;
    ageMinutes: number | null;
    cadenceMinutes: number;
    stalled: boolean;
  }>;
  for (const exp of AGGREGATOR_EXPECTATIONS) {
    const last = await prisma.ingestionRun.findFirst({
      where: { connectorKey: exp.connectorKey },
      orderBy: { startedAt: "desc" },
    });
    const ageMinutes = last
      ? Math.floor((now.getTime() - last.startedAt.getTime()) / 60000)
      : null;
    const stalled =
      ageMinutes == null || ageMinutes > exp.cadenceMinutes * 2;
    aggregatorStatus.push({
      connectorKey: exp.connectorKey,
      lastRun: last?.startedAt.toISOString() ?? null,
      status: last?.status ?? null,
      fetched: last?.fetchedCount ?? null,
      ageMinutes,
      cadenceMinutes: exp.cadenceMinutes,
      stalled,
    });
  }

  // Task queue sizes
  const queueBreakdown = (await prisma.$queryRawUnsafe(
    `SELECT kind, status, COUNT(*)::int as n FROM "SourceTask" WHERE status IN ('PENDING','RUNNING') GROUP BY kind, status ORDER BY kind, status`
  )) as Array<{ kind: string; status: string; n: number }>;

  // CompanySource breakdown
  const companySourceBreakdown = (await prisma.$queryRawUnsafe(
    `SELECT "connectorName", "status", COUNT(*)::int as n FROM "CompanySource" GROUP BY "connectorName", "status" ORDER BY "connectorName", n DESC`
  )) as Array<{ connectorName: string; status: string; n: number }>;

  // Recent connector activity (last 30 min)
  const recentActivity = (await prisma.$queryRawUnsafe(
    `SELECT "connectorKey", "status", COUNT(*)::int as n FROM "IngestionRun" WHERE "startedAt" > NOW() - INTERVAL '30 minutes' GROUP BY "connectorKey", "status" ORDER BY n DESC LIMIT 30`
  )) as Array<{ connectorKey: string; status: string; n: number }>;

  // Total LIVE delta rate (last hour)
  const liveCreatedLastHour = await prisma.jobCanonical.count({
    where: {
      createdAt: { gte: new Date(now.getTime() - 3600 * 1000) },
      status: "LIVE",
    },
  });

  const report = {
    timestamp: now.toISOString(),
    pool: {
      live: liveCount,
      total: totalCount,
      target: 300_000,
      gapToTarget: Math.max(300_000 - liveCount, 0),
      createdLast24h,
      liveCreatedLastHour,
    },
    statusBreakdown,
    aggregators: aggregatorStatus,
    stalledAggregators: aggregatorStatus.filter((a) => a.stalled),
    queues: queueBreakdown,
    companySourceBreakdown,
    recentActivity,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Ingestion Health @ ${report.timestamp} ===`);
    console.log(
      `Pool: ${liveCount.toLocaleString()} LIVE / ${totalCount.toLocaleString()} total — gap to 300k: ${report.pool.gapToTarget.toLocaleString()}`
    );
    console.log(
      `Last 24h: ${createdLast24h.toLocaleString()} jobs created; last 1h LIVE created: ${liveCreatedLastHour}`
    );
    console.log(`\nStatus breakdown:`);
    for (const s of statusBreakdown) {
      console.log(`  ${s.status.padEnd(12)} ${s.n.toLocaleString()}`);
    }
    console.log(`\nAggregator connectors:`);
    for (const a of aggregatorStatus) {
      const marker = a.stalled ? "🔴" : "🟢";
      console.log(
        `  ${marker} ${a.connectorKey.padEnd(24)} last=${a.lastRun ?? "never"} ageMin=${a.ageMinutes ?? "∞"} (cadence=${a.cadenceMinutes}, status=${a.status ?? "?"})`
      );
    }
    if (report.stalledAggregators.length > 0) {
      console.log(
        `\n⚠️  ${report.stalledAggregators.length} aggregator(s) STALLED — have not run in >2× their cadence`
      );
    }
    console.log(`\nPending task queues:`);
    for (const q of queueBreakdown) {
      console.log(
        `  ${q.kind.padEnd(20)} ${q.status.padEnd(10)} ${q.n.toLocaleString()}`
      );
    }
    console.log(`\nCompanySource by connector/status:`);
    for (const r of companySourceBreakdown) {
      console.log(
        `  ${r.connectorName.padEnd(20)} ${r.status.padEnd(22)} ${r.n.toLocaleString()}`
      );
    }
    console.log(`\nLast 30 min IngestionRun activity (top 30):`);
    for (const r of recentActivity) {
      console.log(
        `  ${r.connectorKey.padEnd(40)} ${r.status.padEnd(10)} ${r.n}`
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
