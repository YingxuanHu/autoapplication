import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const [
    pendingDiscovery,
    discoveredCompanies,
    failedDiscovery,
    needsRediscovery,
    validatedSources,
    blockedSources,
    suspectSources,
    invalidSources,
    connectorFamilies,
    pendingRediscovery,
  ] = await Promise.all([
    prisma.company.count({ where: { discoveryStatus: "PENDING" } }),
    prisma.company.count({ where: { discoveryStatus: "DISCOVERED" } }),
    prisma.company.count({ where: { discoveryStatus: "FAILED" } }),
    prisma.companySource.count({ where: { validationState: "NEEDS_REDISCOVERY" } }),
    prisma.companySource.count({ where: { validationState: "VALIDATED" } }),
    prisma.companySource.count({ where: { validationState: "BLOCKED" } }),
    prisma.companySource.count({ where: { validationState: "SUSPECT" } }),
    prisma.companySource.count({ where: { validationState: "INVALID" } }),
    prisma.companySource.groupBy({
      by: ["connectorName"],
      where: { validationState: "VALIDATED" },
      _count: true,
      orderBy: { _count: { connectorName: "desc" } },
      take: 20,
    }),
    prisma.sourceTask.count({ where: { kind: "REDISCOVERY", status: "PENDING" } }),
  ]);

  const totalCompanies = pendingDiscovery + discoveredCompanies + failedDiscovery;

  console.log("=== Company Discovery Pipeline ===");
  console.log(`Total companies: ${totalCompanies.toLocaleString()}`);
  console.log(`  PENDING (queued, not yet run): ${pendingDiscovery.toLocaleString()}`);
  console.log(`  DISCOVERED: ${discoveredCompanies.toLocaleString()}`);
  console.log(`  FAILED: ${failedDiscovery.toLocaleString()}`);

  console.log("\n=== Source Health ===");
  console.log(`VALIDATED sources: ${validatedSources.toLocaleString()}`);
  console.log(`NEEDS_REDISCOVERY: ${needsRediscovery} (REDISCOVERY tasks pending: ${pendingRediscovery})`);
  console.log(`BLOCKED: ${blockedSources}`);
  console.log(`SUSPECT: ${suspectSources}`);
  console.log(`INVALID: ${invalidSources}`);

  console.log("\n=== Validated Sources by Connector ===");
  for (const c of connectorFamilies) {
    console.log(`  ${(c.connectorName ?? "unknown").padEnd(25)} ${c._count}`);
  }

  // Jobs by source connector
  const jobsBySource = await prisma.jobSourceMapping.groupBy({
    by: ["sourceName"],
    where: {
      removedAt: null,
      canonicalJob: {
        status: { in: ["LIVE", "AGING"] },
      },
    },
    _count: { sourceName: true },
    orderBy: { _count: { sourceName: "desc" } },
    take: 15,
  });
  console.log("\n=== Active Jobs (LIVE+AGING) by Source ===");
  for (const j of jobsBySource) {
    const family = (j.sourceName ?? "unknown").split(":")[0];
    console.log(`  ${(family ?? "?").padEnd(20)} ${j._count.sourceName.toLocaleString()}`);
  }

  // NEEDS_REDISCOVERY by connector
  const rediscoverByConnector = await prisma.companySource.groupBy({
    by: ["connectorName"],
    where: { validationState: "NEEDS_REDISCOVERY" },
    _count: true,
    orderBy: { _count: { connectorName: "desc" } },
  });
  if (rediscoverByConnector.length > 0) {
    console.log("\n=== NEEDS_REDISCOVERY by connector ===");
    for (const r of rediscoverByConnector) {
      console.log(`  ${(r.connectorName ?? "unknown").padEnd(25)} ${r._count}`);
    }
  }

  // Top PENDING company sources (by retainedLiveJobCount desc)
  const topPendingSources = await prisma.companySource.findMany({
    where: { validationState: "VALIDATED", pollState: "READY" },
    orderBy: { retainedLiveJobCount: "desc" },
    select: { sourceName: true, retainedLiveJobCount: true, connectorName: true },
    take: 10,
  });
  console.log("\n=== Top Sources by Retained Live Jobs ===");
  for (const s of topPendingSources) {
    console.log(`  ${(s.sourceName ?? "").substring(0, 45).padEnd(45)} ${s.retainedLiveJobCount}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
