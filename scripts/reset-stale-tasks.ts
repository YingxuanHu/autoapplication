import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const reset = await prisma.sourceTask.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "PENDING",
      startedAt: null,
      lastError: "Reset from RUNNING after daemon restart",
    },
  });
  console.log(`Reset ${reset.count} RUNNING tasks to PENDING`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
