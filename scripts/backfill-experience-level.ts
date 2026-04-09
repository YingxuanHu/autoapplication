/**
 * Backfill experience level for all LIVE jobs using the current inference logic.
 *
 * Reads every live job's title, re-infers experienceLevel, and updates any
 * that have changed (including null → inferred).
 *
 * Usage:
 *   npx tsx scripts/backfill-experience-level.ts
 *   npx tsx scripts/backfill-experience-level.ts --dry-run
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { inferExperienceLevel } from "../src/lib/career-stage";

const DRY_RUN = process.argv.includes("--dry-run");

type ExperienceLevel =
  | "ENTRY"
  | "MID"
  | "SENIOR"
  | "LEAD"
  | "EXECUTIVE"
  | "UNKNOWN";

async function main() {
  console.log(`Experience-level backfill ${DRY_RUN ? "(dry run)" : "(live)"}\n`);

  // Fetch all live jobs
  const jobs = await prisma.jobCanonical.findMany({
    where: { status: "LIVE" },
    select: {
      id: true,
      title: true,
      description: true,
      employmentType: true,
      roleFamily: true,
      experienceLevel: true,
    },
  });

  console.log(`Total LIVE jobs: ${jobs.length}`);

  // Tally current distribution
  const currentDist = new Map<string, number>();
  let nullCount = 0;
  for (const job of jobs) {
    const level = job.experienceLevel ?? "null";
    if (job.experienceLevel === null) nullCount++;
    currentDist.set(level, (currentDist.get(level) ?? 0) + 1);
  }

  console.log("\nCurrent distribution:");
  for (const [level, count] of [...currentDist.entries()].sort()) {
    console.log(`  ${level.padEnd(12)} ${count}`);
  }
  console.log(`  (null: ${nullCount})`);

  // Compute changes
  const updates: Array<{ id: string; from: ExperienceLevel | null; to: ExperienceLevel }> = [];
  for (const job of jobs) {
    const inferred = inferExperienceLevel(
      job.title,
      job.description,
      job.employmentType,
      job.roleFamily
    );
    if (job.experienceLevel !== inferred) {
      updates.push({ id: job.id, from: job.experienceLevel as ExperienceLevel | null, to: inferred });
    }
  }

  console.log(`\nJobs that would change: ${updates.length}`);

  // Show breakdown of changes
  const changeSummary = new Map<string, number>();
  for (const u of updates) {
    const key = `${u.from ?? "null"} → ${u.to}`;
    changeSummary.set(key, (changeSummary.get(key) ?? 0) + 1);
  }
  for (const [transition, count] of [...changeSummary.entries()].sort()) {
    console.log(`  ${transition.padEnd(20)} ${count}`);
  }

  if (DRY_RUN) {
    console.log("\n[dry run] No changes written.");
  } else if (updates.length > 0) {
    console.log("\nApplying updates...");
    let done = 0;
    for (const update of updates) {
      await prisma.jobCanonical.update({
        where: { id: update.id },
        data: { experienceLevel: update.to },
      });
      done++;
      if (done % 50 === 0) process.stdout.write(`  ${done}/${updates.length}\r`);
    }
    console.log(`  Done. Updated ${done} jobs.`);
  } else {
    console.log("\nAll jobs already match inferred levels. No updates needed.");
  }

  // Show new distribution
  if (!DRY_RUN && updates.length > 0) {
    const newDist = new Map<string, number>();
    for (const job of jobs) {
      const changed = updates.find((u) => u.id === job.id);
      const level = changed ? changed.to : (job.experienceLevel ?? "null");
      newDist.set(level, (newDist.get(level) ?? 0) + 1);
    }
    console.log("\nNew distribution:");
    for (const [level, count] of [...newDist.entries()].sort()) {
      console.log(`  ${level.padEnd(12)} ${count}`);
    }
  }

  // Role-family breakdown for changed jobs
  if (updates.length > 0) {
    console.log("\nRole-family breakdown of changes:");
    const rfMap = new Map<string, number>();
    for (const u of updates) {
      const job = jobs.find((j) => j.id === u.id)!;
      const rf = job.roleFamily ?? "unknown";
      rfMap.set(rf, (rfMap.get(rf) ?? 0) + 1);
    }
    for (const [rf, count] of [...rfMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${rf.padEnd(30)} ${count}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
