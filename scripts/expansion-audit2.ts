import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  // Jobs by source via mappings
  const jobsBySource = await prisma.jobSourceMapping.groupBy({
    by: ["sourceName"],
    where: { removedAt: null },
    _count: true,
    orderBy: { _count: { sourceName: "desc" } },
    take: 20,
  });

  console.log("=== Active Job Mappings by Source ===");
  for (const j of jobsBySource) {
    const family = (j.sourceName ?? "unknown").split(":")[0];
    console.log(`  ${(family ?? "?").padEnd(20)} ${j._count.toLocaleString()}`);
  }

  // Pending company discovery breakdown: how many pending companies have detectedAts
  const pendingByAts = await prisma.company.groupBy({
    by: ["detectedAts"],
    where: { discoveryStatus: "PENDING" },
    _count: true,
    orderBy: { _count: { detectedAts: "desc" } },
    take: 15,
  });
  console.log("\n=== PENDING Companies by Detected ATS ===");
  for (const p of pendingByAts) {
    console.log(`  ${(p.detectedAts ?? "unknown/undetected").padEnd(25)} ${p._count.toLocaleString()}`);
  }

  // How many PENDING companies have sources vs don't
  const pendingWithSources = await prisma.company.count({
    where: {
      discoveryStatus: "PENDING",
      sources: { some: {} },
    },
  });
  const pendingWithoutSources = await prisma.company.count({
    where: {
      discoveryStatus: "PENDING",
      sources: { none: {} },
    },
  });
  console.log(`\nPENDING companies WITH sources: ${pendingWithSources.toLocaleString()}`);
  console.log(`PENDING companies WITHOUT sources: ${pendingWithoutSources.toLocaleString()}`);

  // NEEDS_REDISCOVERY breakdown
  const rediscoverByConnector = await prisma.companySource.groupBy({
    by: ["connectorName"],
    where: { validationState: "NEEDS_REDISCOVERY" },
    _count: true,
    orderBy: { _count: { connectorName: "desc" } },
  });
  console.log("\n=== NEEDS_REDISCOVERY by Connector ===");
  for (const r of rediscoverByConnector) {
    console.log(`  ${(r.connectorName ?? "unknown").padEnd(25)} ${r._count}`);
  }

  // BLOCKED sources by connector
  const blockedByConnector = await prisma.companySource.groupBy({
    by: ["connectorName"],
    where: { validationState: "BLOCKED" },
    _count: true,
    orderBy: { _count: { connectorName: "desc" } },
  });
  console.log("\n=== BLOCKED Sources by Connector ===");
  for (const b of blockedByConnector) {
    console.log(`  ${(b.connectorName ?? "unknown").padEnd(25)} ${b._count}`);
  }

  // VALIDATED sources with 0 retained live jobs — untapped/misconfigured
  const zeroYieldSources = await prisma.companySource.count({
    where: { validationState: "VALIDATED", retainedLiveJobCount: 0 },
  });
  const lowYieldSources = await prisma.companySource.count({
    where: { validationState: "VALIDATED", retainedLiveJobCount: { gt: 0, lt: 5 } },
  });
  const highYieldSources = await prisma.companySource.count({
    where: { validationState: "VALIDATED", retainedLiveJobCount: { gte: 10 } },
  });
  console.log("\n=== Validated Source Yield Distribution ===");
  console.log(`  0 retained live jobs: ${zeroYieldSources.toLocaleString()}`);
  console.log(`  1–4 retained live jobs: ${lowYieldSources.toLocaleString()}`);
  console.log(`  10+ retained live jobs: ${highYieldSources.toLocaleString()}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
