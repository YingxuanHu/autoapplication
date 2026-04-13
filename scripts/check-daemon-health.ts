import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const now = new Date();

  // Check for RUNNING URL_HEALTH tasks
  const runningHealth = await prisma.sourceTask.findMany({
    where: { kind: "URL_HEALTH", status: "RUNNING" },
    select: { id: true, startedAt: true, canonicalJobId: true },
    take: 5,
  });
  console.log("RUNNING URL_HEALTH tasks:", runningHealth.length);
  if (runningHealth.length > 0) {
    console.log("  First running:", runningHealth[0]?.startedAt?.toISOString());
  }

  // Check when the last URL_HEALTH SUCCESS was
  const lastSuccess = await prisma.sourceTask.findFirst({
    where: { kind: "URL_HEALTH", status: "SUCCESS" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  console.log("Last URL_HEALTH SUCCESS at:", lastSuccess?.finishedAt?.toISOString() ?? "none");

  // Check last CONNECTOR_POLL activity
  const lastPoll = await prisma.sourceTask.findFirst({
    where: { kind: "CONNECTOR_POLL", status: "SUCCESS" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  console.log("Last CONNECTOR_POLL SUCCESS at:", lastPoll?.finishedAt?.toISOString() ?? "none");

  // Check last REDISCOVERY activity
  const lastRediscovery = await prisma.sourceTask.findFirst({
    where: { kind: "REDISCOVERY", status: "SUCCESS" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  console.log("Last REDISCOVERY SUCCESS at:", lastRediscovery?.finishedAt?.toISOString() ?? "none");

  // Check last COMPANY_DISCOVERY activity
  const lastDisc = await prisma.sourceTask.findFirst({
    where: { kind: "COMPANY_DISCOVERY", status: "SUCCESS" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  console.log("Last COMPANY_DISCOVERY SUCCESS at:", lastDisc?.finishedAt?.toISOString() ?? "none");

  console.log("Current time:", now.toISOString());
}

main().catch(console.error).finally(() => prisma.$disconnect());
