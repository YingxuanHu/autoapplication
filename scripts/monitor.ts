import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const now = new Date();

  const [live, aging, stale] = await Promise.all([
    prisma.jobCanonical.count({ where: { status: "LIVE" } }),
    prisma.jobCanonical.count({ where: { status: "AGING" } }),
    prisma.jobCanonical.count({ where: { status: "STALE" } }),
  ]);

  const healthTasks = await prisma.sourceTask.groupBy({
    by: ["status"],
    where: { kind: "URL_HEALTH" },
    _count: true,
  });

  const [lastHealth, lastPoll, lastValidation, lastDisc] = await Promise.all([
    prisma.sourceTask.findFirst({
      where: { kind: "URL_HEALTH", status: "SUCCESS" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    prisma.sourceTask.findFirst({
      where: { kind: "CONNECTOR_POLL", status: "SUCCESS" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    prisma.sourceTask.findFirst({
      where: { kind: "SOURCE_VALIDATION", status: "SUCCESS" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    prisma.sourceTask.findFirst({
      where: { kind: "COMPANY_DISCOVERY", status: "SUCCESS" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
  ]);

  const running = await prisma.sourceTask.groupBy({
    by: ["kind"],
    where: { status: "RUNNING" },
    _count: true,
  });

  // Count jobs that are LIVE but have no recent URL confirmation (at risk of demotion)
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const liveAtRisk = await prisma.jobCanonical.count({
    where: {
      status: "LIVE",
      OR: [
        { lastConfirmedAliveAt: null },
        { lastConfirmedAliveAt: { lt: threeDaysAgo } },
      ],
    },
  });

  console.log(`=== Status at ${now.toISOString()} ===`);
  console.log(`LIVE: ${live.toLocaleString()}  AGING: ${aging.toLocaleString()}  STALE: ${stale}  ACTIVE: ${(live + aging).toLocaleString()}`);
  console.log(`LIVE at-risk (no confirm <3d): ${liveAtRisk.toLocaleString()}`);
  console.log();
  console.log(`URL_HEALTH: ${healthTasks.map((t) => `${t.status}=${t._count}`).join("  ")}`);
  console.log(`Running tasks: ${running.map((t) => `${t.kind}×${t._count}`).join(", ") || "none"}`);
  console.log();
  console.log(`Last activity:`);
  console.log(`  COMPANY_DISCOVERY: ${lastDisc?.finishedAt?.toISOString() ?? "never"}`);
  console.log(`  SOURCE_VALIDATION: ${lastValidation?.finishedAt?.toISOString() ?? "never"}`);
  console.log(`  CONNECTOR_POLL:    ${lastPoll?.finishedAt?.toISOString() ?? "never"}`);
  console.log(`  URL_HEALTH:        ${lastHealth?.finishedAt?.toISOString() ?? "never"}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
