import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const rows: any[] = await prisma.$queryRaw`
    SELECT 
      status,
      COUNT(*)::int as count,
      AVG("availabilityScore")::int as avg_score,
      MIN("availabilityScore") as min_score,
      MAX("availabilityScore") as max_score
    FROM "JobCanonical"
    WHERE status IN ('LIVE','AGING','STALE')
    GROUP BY status
    ORDER BY status
  `;
  console.table(rows);

  const hist: any[] = await prisma.$queryRaw`
    SELECT 
      CASE 
        WHEN "availabilityScore" >= 90 THEN '90-100'
        WHEN "availabilityScore" >= 80 THEN '80-89'
        WHEN "availabilityScore" >= 72 THEN '72-79'
        WHEN "availabilityScore" >= 60 THEN '60-71'
        WHEN "availabilityScore" >= 48 THEN '48-59'
        ELSE '<48'
      END as range,
      COUNT(*)::int as count
    FROM "JobCanonical"
    WHERE status = 'AGING'
    GROUP BY range
    ORDER BY range DESC
  `;
  console.log('\nAGING score histogram:');
  console.table(hist);

  // Check URL health confirmed jobs - do they have high scores?
  const [recentlyChecked]: any[] = await prisma.$queryRaw`
    SELECT 
      AVG("availabilityScore")::int as avg_score,
      COUNT(*)::int as count
    FROM "JobCanonical"
    WHERE "lastApplyCheckAt" > NOW() - INTERVAL '3 hours'
    AND status IN ('LIVE','AGING')
  `;
  console.log('\nRecently URL-checked (last 3h):', recentlyChecked);

  await prisma.$disconnect();
}
main().catch(console.error);
// Also check for jobs with huge sourceMappings
async function extraChecks() {
  const bigJobs = await prisma.$queryRaw`
    SELECT j.id, COUNT(sm.id) as mapping_count
    FROM "JobCanonical" j
    JOIN "JobSourceMapping" sm ON sm."canonicalJobId" = j.id
    GROUP BY j.id
    ORDER BY mapping_count DESC
    LIMIT 5
  ` as any[];
  console.log('\nTop 5 jobs by sourceMappings count:');
  console.table(bigJobs);
  
  const avgMappings = await prisma.$queryRaw`
    SELECT AVG(cnt)::float as avg_mappings, MAX(cnt) as max_mappings
    FROM (
      SELECT COUNT(*) as cnt FROM "JobSourceMapping" GROUP BY "canonicalJobId"
    ) sub
  ` as any[];
  console.log('Avg/Max sourceMappings per job:', avgMappings[0]);
}
extraChecks().catch(console.error).finally(() => prisma.$disconnect());
