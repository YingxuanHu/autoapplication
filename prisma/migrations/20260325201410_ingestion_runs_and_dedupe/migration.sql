-- CreateEnum
CREATE TYPE "IngestionRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "JobCanonical" ADD COLUMN     "applyUrlKey" TEXT,
ADD COLUMN     "companyKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "locationKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "titleCoreKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "titleKey" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceTier" "SourceTier" NOT NULL,
    "status" "IngestionRunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "rawCreatedCount" INTEGER NOT NULL DEFAULT 0,
    "rawUpdatedCount" INTEGER NOT NULL DEFAULT 0,
    "canonicalCreatedCount" INTEGER NOT NULL DEFAULT 0,
    "canonicalUpdatedCount" INTEGER NOT NULL DEFAULT 0,
    "dedupedCount" INTEGER NOT NULL DEFAULT 0,
    "sourceMappingCreatedCount" INTEGER NOT NULL DEFAULT 0,
    "sourceMappingUpdatedCount" INTEGER NOT NULL DEFAULT 0,
    "sourceMappingsRemovedCount" INTEGER NOT NULL DEFAULT 0,
    "liveCount" INTEGER NOT NULL DEFAULT 0,
    "staleCount" INTEGER NOT NULL DEFAULT 0,
    "expiredCount" INTEGER NOT NULL DEFAULT 0,
    "skippedReasons" JSONB,
    "runOptions" JSONB,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestionRun_startedAt_idx" ON "IngestionRun"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "IngestionRun_sourceName_startedAt_idx" ON "IngestionRun"("sourceName", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "IngestionRun_status_startedAt_idx" ON "IngestionRun"("status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_applyUrlKey_idx" ON "JobCanonical"("applyUrlKey");

-- CreateIndex
CREATE INDEX "JobCanonical_companyKey_titleCoreKey_region_idx" ON "JobCanonical"("companyKey", "titleCoreKey", "region");

-- CreateIndex
CREATE INDEX "JobCanonical_companyKey_roleFamily_region_idx" ON "JobCanonical"("companyKey", "roleFamily", "region");

-- CreateIndex
CREATE INDEX "JobCanonical_companyKey_locationKey_region_idx" ON "JobCanonical"("companyKey", "locationKey", "region");
