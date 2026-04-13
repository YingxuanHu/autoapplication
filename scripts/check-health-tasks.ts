import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const now = new Date();
  console.log("Now:", now.toISOString());

  // Check notBeforeAt distribution for pending URL_HEALTH tasks
  const sample = await prisma.sourceTask.findMany({
    where: { kind: "URL_HEALTH", status: "PENDING" },
    select: { id: true, notBeforeAt: true, priorityScore: true, createdAt: true },
    orderBy: { notBeforeAt: "asc" },
    take: 10,
  });
  console.log("\nFirst 10 PENDING URL_HEALTH (by notBeforeAt):");
  for (const t of sample) {
    const diffMs = t.notBeforeAt.getTime() - now.getTime();
    console.log(`  notBeforeAt: ${t.notBeforeAt.toISOString()} (${diffMs > 0 ? '+' : ''}${Math.round(diffMs / 60000)}min from now) priority: ${t.priorityScore}`);
  }

  const late = await prisma.sourceTask.findMany({
    where: { kind: "URL_HEALTH", status: "PENDING", notBeforeAt: { lte: now } },
    select: { id: true },
  });
  console.log(`\nURL_HEALTH PENDING with notBeforeAt <= now: ${late.length}`);

  const future = await prisma.sourceTask.findMany({
    where: { kind: "URL_HEALTH", status: "PENDING", notBeforeAt: { gt: now } },
    select: { id: true, notBeforeAt: true },
    orderBy: { notBeforeAt: "asc" },
    take: 5,
  });
  console.log(`URL_HEALTH PENDING with notBeforeAt > now: ${await prisma.sourceTask.count({ where: { kind: "URL_HEALTH", status: "PENDING", notBeforeAt: { gt: now } } })}`);
  if (future.length > 0) {
    console.log("  Earliest future:", future[0]?.notBeforeAt?.toISOString());
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
