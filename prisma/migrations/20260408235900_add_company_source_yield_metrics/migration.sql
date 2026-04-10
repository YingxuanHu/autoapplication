ALTER TABLE "CompanySource"
ADD COLUMN "yieldScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "validationAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "validationSuccessCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pollAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pollSuccessCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "jobsFetchedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "jobsAcceptedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "jobsDedupedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "jobsCreatedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "retainedLiveJobCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastJobsFetchedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastJobsAcceptedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastJobsDedupedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastJobsCreatedCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "CompanySource"
SET
  "validationAttemptCount" = CASE
    WHEN "lastValidatedAt" IS NOT NULL THEN GREATEST("validationAttemptCount", 1)
    ELSE "validationAttemptCount"
  END,
  "validationSuccessCount" = CASE
    WHEN "validationState" = 'VALIDATED' THEN GREATEST("validationSuccessCount", 1)
    ELSE "validationSuccessCount"
  END,
  "pollAttemptCount" = CASE
    WHEN "lastSuccessfulPollAt" IS NOT NULL OR "lastFailureAt" IS NOT NULL THEN GREATEST("pollAttemptCount", 1)
    ELSE "pollAttemptCount"
  END,
  "pollSuccessCount" = CASE
    WHEN "lastSuccessfulPollAt" IS NOT NULL THEN GREATEST("pollSuccessCount", 1)
    ELSE "pollSuccessCount"
  END,
  "jobsFetchedCount" = COALESCE(("metadataJson"->'lastSummary'->>'fetchedCount')::INTEGER, "jobsFetchedCount"),
  "jobsAcceptedCount" = COALESCE(("metadataJson"->'lastSummary'->>'acceptedCount')::INTEGER, "jobsAcceptedCount"),
  "jobsDedupedCount" = COALESCE(("metadataJson"->'lastSummary'->>'dedupedCount')::INTEGER, "jobsDedupedCount"),
  "jobsCreatedCount" = COALESCE(("metadataJson"->'lastSummary'->>'canonicalCreatedCount')::INTEGER, "jobsCreatedCount"),
  "lastJobsFetchedCount" = COALESCE(("metadataJson"->'lastSummary'->>'fetchedCount')::INTEGER, "lastJobsFetchedCount"),
  "lastJobsAcceptedCount" = COALESCE(("metadataJson"->'lastSummary'->>'acceptedCount')::INTEGER, "lastJobsAcceptedCount"),
  "lastJobsDedupedCount" = COALESCE(("metadataJson"->'lastSummary'->>'dedupedCount')::INTEGER, "lastJobsDedupedCount"),
  "lastJobsCreatedCount" = COALESCE(("metadataJson"->'lastSummary'->>'canonicalCreatedCount')::INTEGER, "lastJobsCreatedCount");

UPDATE "CompanySource" source
SET "retainedLiveJobCount" = live_counts.count
FROM (
  SELECT mapping."sourceName", COUNT(DISTINCT mapping."canonicalJobId")::INTEGER AS count
  FROM "JobSourceMapping" mapping
  INNER JOIN "JobCanonical" job
    ON job."id" = mapping."canonicalJobId"
  WHERE mapping."removedAt" IS NULL
    AND job."status" IN ('LIVE', 'AGING')
  GROUP BY mapping."sourceName"
) AS live_counts
WHERE live_counts."sourceName" = source."sourceName";

UPDATE "CompanySource"
SET "yieldScore" = LEAST(
  0.99,
  GREATEST(
    0,
    "sourceQualityScore" * 0.65 +
    CASE
      WHEN "jobsFetchedCount" > 0
        THEN (("jobsAcceptedCount"::DOUBLE PRECISION / GREATEST("jobsFetchedCount", 1)) * 0.15)
        ELSE 0
    END +
    CASE
      WHEN "jobsFetchedCount" > 0
        THEN (("jobsCreatedCount"::DOUBLE PRECISION / GREATEST("jobsFetchedCount", 1)) * 0.12)
        ELSE 0
    END +
    CASE
      WHEN "jobsAcceptedCount" > 0
        THEN (("retainedLiveJobCount"::DOUBLE PRECISION / GREATEST("jobsAcceptedCount", 1)) * 0.08)
        ELSE 0
    END
  )
);

CREATE INDEX "CompanySource_connectorName_yieldScore_idx"
ON "CompanySource"("connectorName", "yieldScore" DESC);
