import "dotenv/config";
import { prisma } from "../src/lib/db";

/**
 * Deduplicates PENDING companies with the same domain.
 * Keeps the oldest (lowest createdAt) entry per domain, deletes the rest.
 * Also removes known job-aggregator domains that should never be crawled as companies.
 */

// These are job aggregators / not real employer companies
const AGGREGATOR_DOMAINS = [
  "adzuna.com", "adzuna.fr", "adzuna.com.au", "adzuna.co.uk", "adzuna.com.br",
  "adzuna.be", "adzuna.de", "adzuna.ca", "adzuna.in", "adzuna.it", "adzuna.nl",
  "adzuna.pl", "adzuna.ru", "adzuna.es", "adzuna.at", "adzuna.nz", "adzuna.sg",
  "adzuna.za",
  "indeed.com", "glassdoor.com", "linkedin.com", "ziprecruiter.com",
  "monster.com", "careerbuilder.com", "simplyhired.com", "dice.com",
  "themuse.com", "remoteok.com", "remoteok.io", "remotive.io", "remotive.com",
  "himalayas.app", "jobicy.com", "wellfound.com", "angel.co",
];

async function main() {
  console.log("=== Dedup PENDING Companies ===\n");

  // 1. Remove known aggregator domains
  const aggregatorRemoved = await prisma.company.deleteMany({
    where: {
      discoveryStatus: "PENDING",
      domain: { in: AGGREGATOR_DOMAINS },
    },
  });
  console.log(`Removed ${aggregatorRemoved.count} aggregator-domain companies`);

  // 2. For each domain with duplicates, keep the oldest, delete the rest
  const domainsWithDupes = await prisma.company.groupBy({
    by: ["domain"],
    where: { discoveryStatus: "PENDING", domain: { not: null } },
    _count: true,
    having: { domain: { _count: { gt: 1 } } },
  });

  console.log(`Found ${domainsWithDupes.length} domains with duplicates`);

  let totalDeleted = 0;
  for (const { domain } of domainsWithDupes) {
    if (!domain) continue;
    // Get all entries for this domain, oldest first
    const entries = await prisma.company.findMany({
      where: { discoveryStatus: "PENDING", domain },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    // Keep the first (oldest), delete the rest
    const idsToDelete = entries.slice(1).map((e) => e.id);
    if (idsToDelete.length > 0) {
      await prisma.company.deleteMany({ where: { id: { in: idsToDelete } } });
      totalDeleted += idsToDelete.length;
    }
  }
  console.log(`Deleted ${totalDeleted} duplicate entries`);

  // 3. Final count
  const remaining = await prisma.company.count({ where: { discoveryStatus: "PENDING" } });
  const remainingWithDomain = await prisma.company.count({
    where: { discoveryStatus: "PENDING", domain: { not: null } },
  });
  const remainingNoDomain = await prisma.company.count({
    where: { discoveryStatus: "PENDING", domain: null },
  });
  console.log(`\nPENDING companies remaining: ${remaining.toLocaleString()}`);
  console.log(`  With domain: ${remainingWithDomain}`);
  console.log(`  Without domain: ${remainingNoDomain.toLocaleString()}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
