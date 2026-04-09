CREATE TYPE "CompanySourceValidationState" AS ENUM (
  'UNVALIDATED',
  'VALIDATING',
  'VALIDATED',
  'SUSPECT',
  'INVALID',
  'NEEDS_REDISCOVERY',
  'BLOCKED'
);

CREATE TYPE "CompanySourcePollState" AS ENUM (
  'READY',
  'ACTIVE',
  'BACKOFF',
  'QUARANTINED',
  'DISABLED'
);

ALTER TYPE "SourceTaskKind" ADD VALUE IF NOT EXISTS 'SOURCE_VALIDATION';

ALTER TABLE "CompanySource"
  ADD COLUMN "validationState" "CompanySourceValidationState" NOT NULL DEFAULT 'UNVALIDATED',
  ADD COLUMN "pollState" "CompanySourcePollState" NOT NULL DEFAULT 'READY',
  ADD COLUMN "sourceQualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lastFailureAt" TIMESTAMP(3),
  ADD COLUMN "lastHttpStatus" INTEGER,
  ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "validationMessage" TEXT;

UPDATE "CompanySource"
SET
  "validationState" = CASE
    WHEN "status" = 'ACTIVE' THEN 'VALIDATED'::"CompanySourceValidationState"
    WHEN "status" = 'DEGRADED' THEN 'SUSPECT'::"CompanySourceValidationState"
    WHEN "status" = 'REDISCOVER_REQUIRED' THEN 'NEEDS_REDISCOVERY'::"CompanySourceValidationState"
    WHEN "status" = 'DISABLED' THEN 'INVALID'::"CompanySourceValidationState"
    ELSE 'UNVALIDATED'::"CompanySourceValidationState"
  END,
  "pollState" = CASE
    WHEN "status" = 'ACTIVE' THEN 'READY'::"CompanySourcePollState"
    WHEN "status" = 'DEGRADED' THEN 'BACKOFF'::"CompanySourcePollState"
    WHEN "status" = 'REDISCOVER_REQUIRED' THEN 'QUARANTINED'::"CompanySourcePollState"
    WHEN "status" = 'DISABLED' THEN 'DISABLED'::"CompanySourcePollState"
    ELSE 'READY'::"CompanySourcePollState"
  END,
  "sourceQualityScore" = LEAST(0.99, GREATEST(0.05, COALESCE("priorityScore", 0.35))),
  "firstSeenAt" = COALESCE("lastProvisionedAt", "lastDiscoveryAt", "createdAt", CURRENT_TIMESTAMP),
  "lastValidatedAt" = CASE
    WHEN "status" = 'ACTIVE' THEN COALESCE("lastSuccessfulPollAt", "lastDiscoveryAt", "updatedAt")
    ELSE NULL
  END,
  "lastFailureAt" = CASE
    WHEN COALESCE("failureStreak", 0) > 0 THEN "updatedAt"
    ELSE NULL
  END,
  "consecutiveFailures" = COALESCE("failureStreak", 0);

CREATE INDEX "CompanySource_validationState_pollState_priorityScore_idx"
  ON "CompanySource"("validationState", "pollState", "priorityScore" DESC);

CREATE INDEX "CompanySource_companyId_validationState_pollState_idx"
  ON "CompanySource"("companyId", "validationState", "pollState");
