/**
 * Batch eligibility classifier for canonical jobs.
 *
 * Creates or updates JobEligibility records for all LIVE canonical jobs
 * that don't yet have one. Uses the rules-based classifier from
 * src/lib/ingestion/classify.ts.
 *
 * Usage:
 *   npx tsx -r dotenv/config scripts/classify-eligibility.ts [--limit=50000] [--force]
 *
 * Options:
 *   --limit=N   Maximum number of jobs to classify (default: 100000)
 *   --force     Re-classify all jobs, even those with existing eligibility records
 */
import { prisma } from "@/lib/db";
import { buildEligibilityDraft } from "@/lib/ingestion/classify";
import type { NormalizedJobInput } from "@/lib/ingestion/types";
import type { Region, WorkMode, EmploymentType, ExperienceLevel, Industry } from "@/generated/prisma/client";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const forceMode = args.includes("--force");
const BATCH_LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : 100_000;
const BATCH_SIZE = 500;

async function main() {
  console.log(
    `Classifying eligibility (limit: ${BATCH_LIMIT}, force: ${forceMode})`
  );
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let offset = 0;

  // Category counters
  const categoryCounts = {
    AUTO_SUBMIT_READY: 0,
    AUTO_FILL_REVIEW: 0,
    MANUAL_ONLY: 0,
  };

  while (totalProcessed < BATCH_LIMIT) {
    const batchSize = Math.min(BATCH_SIZE, BATCH_LIMIT - totalProcessed);

    // Fetch canonical jobs with their primary source mapping
    const jobs = await prisma.jobCanonical.findMany({
      where: {
        status: "LIVE",
        ...(forceMode ? {} : { eligibility: null }),
      },
      include: {
        sourceMappings: {
          take: 1,
          orderBy: { lastSeenAt: "desc" },
        },
        eligibility: true,
      },
      take: batchSize,
      skip: offset,
      orderBy: { createdAt: "desc" },
    });

    if (jobs.length === 0) {
      console.log("No more unclassified jobs.");
      break;
    }

    for (const job of jobs) {
      totalProcessed++;
      const sourceName = job.sourceMappings[0]?.sourceName ?? "Unknown";

      // Build a minimal NormalizedJobInput for the classifier
      const normalizedJob: NormalizedJobInput = {
        title: job.title,
        company: job.company,
        companyKey: job.companyKey,
        titleKey: job.titleKey,
        titleCoreKey: job.titleCoreKey ?? job.titleKey,
        descriptionFingerprint: job.descriptionFingerprint ?? "",
        location: job.location,
        locationKey: job.locationKey ?? "",
        region: job.region as Region | null,
        workMode: job.workMode as WorkMode,
        salaryMin: job.salaryMin ? Number(job.salaryMin) : null,
        salaryMax: job.salaryMax ? Number(job.salaryMax) : null,
        salaryCurrency: job.salaryCurrency,
        employmentType: job.employmentType as EmploymentType,
        experienceLevel: (job.experienceLevel as ExperienceLevel | null) ?? "UNKNOWN",
        description: job.description ?? "",
        shortSummary: job.shortSummary ?? "",
        industry: job.industry as Industry | null,
        roleFamily: job.roleFamily ?? "",
        applyUrl: job.applyUrl,
        applyUrlKey: job.applyUrlKey,
        postedAt: job.postedAt,
        deadline: job.deadline,
        duplicateClusterId: job.duplicateClusterId ?? "",
      };

      const draft = buildEligibilityDraft({ job: normalizedJob, sourceName });
      categoryCounts[draft.submissionCategory]++;

      if (job.eligibility && forceMode) {
        // Update existing
        await prisma.jobEligibility.update({
          where: { id: job.eligibility.id },
          data: {
            submissionCategory: draft.submissionCategory,
            reasonCode: draft.reasonCode,
            reasonDescription: draft.reasonDescription,
            jobValidityConfidence: draft.jobValidityConfidence,
            formAutomationConfidence: draft.formAutomationConfidence,
            packageFitConfidence: draft.packageFitConfidence,
            submissionQualityConfidence: draft.submissionQualityConfidence,
            customizationLevel: draft.customizationLevel,
            evaluatedAt: draft.evaluatedAt,
          },
        });
        totalUpdated++;
      } else if (!job.eligibility) {
        // Create new
        await prisma.jobEligibility.create({
          data: {
            canonicalJobId: job.id,
            submissionCategory: draft.submissionCategory,
            reasonCode: draft.reasonCode,
            reasonDescription: draft.reasonDescription,
            jobValidityConfidence: draft.jobValidityConfidence,
            formAutomationConfidence: draft.formAutomationConfidence,
            packageFitConfidence: draft.packageFitConfidence,
            submissionQualityConfidence: draft.submissionQualityConfidence,
            customizationLevel: draft.customizationLevel,
            evaluatedAt: draft.evaluatedAt,
          },
        });
        totalCreated++;
      } else {
        totalSkipped++;
      }
    }

    offset += jobs.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `Processed: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated} | Skipped: ${totalSkipped} | ${elapsed}s`
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s.`);
  console.log(`  Created: ${totalCreated}`);
  console.log(`  Updated: ${totalUpdated}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`\nCategory breakdown:`);
  console.log(`  Auto-submit ready: ${categoryCounts.AUTO_SUBMIT_READY}`);
  console.log(`  Auto-fill + review: ${categoryCounts.AUTO_FILL_REVIEW}`);
  console.log(`  Manual only:       ${categoryCounts.MANUAL_ONLY}`);

  // Final stats
  const totalEligibility = await prisma.jobEligibility.count();
  const totalLive = await prisma.jobCanonical.count({ where: { status: "LIVE" } });
  console.log(`\nTotal eligibility records: ${totalEligibility} / ${totalLive} LIVE jobs`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("Classification failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
