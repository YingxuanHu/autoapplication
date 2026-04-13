import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const [live, aging, stale, expired] = await Promise.all([
    prisma.jobCanonical.count({ where: { status: "LIVE" } }),
    prisma.jobCanonical.count({ where: { status: "AGING" } }),
    prisma.jobCanonical.count({ where: { status: "STALE" } }),
    prisma.jobCanonical.count({ where: { status: "EXPIRED" } }),
  ]);
  const health = await prisma.sourceTask.groupBy({ by: ["status"], where: { kind: "URL_HEALTH" }, _count: true });
  const allTasks = await prisma.sourceTask.groupBy({ by: ["kind", "status"], _count: true, orderBy: [{ kind: "asc" }] });
  console.log("=== Job Status ===");
  console.log(`LIVE: ${live}  AGING: ${aging}  STALE: ${stale}  EXPIRED: ${expired}`);
  console.log("ACTIVE (LIVE+AGING):", live + aging);
  console.log("\n=== URL_HEALTH tasks ===");
  console.log(JSON.stringify(health));
  console.log("\n=== All task types ===");
  for (const t of allTasks) console.log(`  ${t.kind} ${t.status}: ${t._count}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
