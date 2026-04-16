import { prisma } from "@/lib/db";

async function main() {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
  );
  const names = tables.map((t) => t.table_name);
  console.log("source/task tables:", names.filter((n) => /source|task|ingest/i.test(n)));

  const companySourceCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*)::bigint as count FROM "CompanySource"'
  );
  console.log("CompanySource total:", Number(companySourceCount[0].count));

  const bySource = await prisma.$queryRawUnsafe<Array<{ sourceType: string; extractionRoute: string; status: string; count: bigint }>>(
    'SELECT "sourceType", "extractionRoute", "status", COUNT(*)::bigint as count FROM "CompanySource" GROUP BY "sourceType", "extractionRoute", "status" ORDER BY count DESC'
  );
  console.log("CompanySource by type:", bySource.map((r) => ({ ...r, count: Number(r.count) })));

  const taskTables = names.filter((n) => /task/i.test(n));
  console.log("Task tables:", taskTables);
  if (taskTables.length > 0) {
    for (const t of taskTables) {
      const rows = await prisma.$queryRawUnsafe<Array<{ kind: string; status: string; count: bigint }>>(
        `SELECT "kind", "status", COUNT(*)::bigint as count FROM "${t}" GROUP BY "kind", "status" ORDER BY count DESC`
      );
      console.log(`${t}:`, rows.map((r) => ({ ...r, count: Number(r.count) })));
    }
  }
  const [live, total] = await Promise.all([
    prisma.jobCanonical.count({ where: { status: "LIVE" } }),
    prisma.jobCanonical.count(),
  ]);
  console.log("Jobs LIVE:", live, "total:", total);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
