import { prisma } from "@/lib/db";

function readArg(name: string) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!exact) return null;
  return exact.slice(name.length + 1);
}

function readIntArg(name: string, fallback: number) {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const sampleLimit = readIntArg("--sample", 20);
  const visibleStatuses = ["LIVE", "AGING", "STALE"] as const;

  const [
    visibleCanonicalCount,
    visibleFeedIndexCount,
    missingIndexRows,
    staleIndexRows,
    orphanIndexRows,
  ] = await Promise.all([
    prisma.jobCanonical.count({
      where: {
        status: { in: [...visibleStatuses] },
      },
    }),
    prisma.jobFeedIndex.count({
      where: {
        status: { in: [...visibleStatuses] },
      },
    }),
    prisma.$queryRaw<Array<{
      id: string;
      title: string;
      company: string;
      status: string;
      updatedAt: Date;
    }>>`
      SELECT
        jc.id,
        jc.title,
        jc.company,
        jc.status::text AS status,
        jc."updatedAt"
      FROM "JobCanonical" jc
      LEFT JOIN "JobFeedIndex" jfi
        ON jfi."canonicalJobId" = jc.id
      WHERE
        jc.status IN ('LIVE', 'AGING', 'STALE')
        AND jfi."canonicalJobId" IS NULL
      ORDER BY jc."updatedAt" DESC
      LIMIT ${sampleLimit}
    `,
    prisma.$queryRaw<Array<{
      id: string;
      title: string;
      company: string;
      status: string;
      updatedAt: Date;
      indexedAt: Date;
    }>>`
      SELECT
        jc.id,
        jc.title,
        jc.company,
        jc.status::text AS status,
        jc."updatedAt",
        jfi."indexedAt"
      FROM "JobCanonical" jc
      JOIN "JobFeedIndex" jfi
        ON jfi."canonicalJobId" = jc.id
      WHERE
        jc.status IN ('LIVE', 'AGING', 'STALE')
        AND jfi."indexedAt" < jc."updatedAt"
      ORDER BY jc."updatedAt" DESC
      LIMIT ${sampleLimit}
    `,
    prisma.$queryRaw<Array<{
      canonicalJobId: string;
      indexedStatus: string;
      canonicalStatus: string;
      indexedAt: Date;
    }>>`
      SELECT
        jfi."canonicalJobId",
        jfi.status::text AS "indexedStatus",
        jc.status::text AS "canonicalStatus",
        jfi."indexedAt"
      FROM "JobFeedIndex" jfi
      JOIN "JobCanonical" jc
        ON jc.id = jfi."canonicalJobId"
      WHERE
        jfi.status IN ('LIVE', 'AGING', 'STALE')
        AND jc.status NOT IN ('LIVE', 'AGING', 'STALE')
      ORDER BY jfi."indexedAt" DESC
      LIMIT ${sampleLimit}
    `,
  ]);

  const coverage =
    visibleCanonicalCount > 0
      ? Number(((visibleFeedIndexCount / visibleCanonicalCount) * 100).toFixed(2))
      : 0;

  console.log(
    JSON.stringify(
      {
        visibleCanonicalCount,
        visibleFeedIndexCount,
        coveragePercent: coverage,
        missingIndexSample: missingIndexRows,
        staleIndexSample: staleIndexRows,
        orphanIndexSample: orphanIndexRows,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
