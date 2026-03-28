import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const DEMO_SOURCES = ["BoardAggregator-X", "CompanyCareer-Direct", "PartnerAPI-Alpha"];

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  const total = await prisma.jobCanonical.count();
  const realIngested = await prisma.jobCanonical.count({
    where: { sourceMappings: { some: { sourceName: { notIn: DEMO_SOURCES } } } },
  });
  const ingestionRuns = await prisma.ingestionRun.count();

  const sampleRealMapping = await prisma.jobSourceMapping.findFirst({
    where: { sourceName: { notIn: DEMO_SOURCES } },
    select: { sourceName: true, sourceUrl: true, isPrimary: true, canonicalJobId: true },
  });

  const sampleRealJob = sampleRealMapping
    ? await prisma.jobCanonical.findUnique({
        where: { id: sampleRealMapping.canonicalJobId },
        select: { title: true, company: true, applyUrl: true, status: true },
      })
    : null;

  console.log(
    JSON.stringify(
      { total, realIngested, ingestionRuns, sampleRealMapping, sampleRealJob },
      null,
      2
    )
  );

  await prisma.$disconnect();
}

main();
