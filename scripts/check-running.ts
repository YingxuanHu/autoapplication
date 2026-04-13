import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const running = await prisma.sourceTask.findMany({
    where: { status: "RUNNING" },
    select: { id: true, kind: true, startedAt: true, companySourceId: true, canonicalJobId: true },
    take: 20,
  });
  console.log("RUNNING tasks:", running.length);
  for (const t of running) {
    const age = t.startedAt ? Math.round((Date.now() - t.startedAt.getTime()) / 60000) : "?";
    console.log(" ", t.kind, t.startedAt?.toISOString(), `(${age}min ago)`, t.companySourceId || t.canonicalJobId || "");
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
