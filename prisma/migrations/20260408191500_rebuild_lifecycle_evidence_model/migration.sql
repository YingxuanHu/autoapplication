-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'AGING';

-- AlterTable
ALTER TABLE "JobCanonical"
ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastSourceSeenAt" TIMESTAMP(3),
ADD COLUMN "lastApplyCheckAt" TIMESTAMP(3),
ADD COLUMN "lastConfirmedAliveAt" TIMESTAMP(3),
ADD COLUMN "availabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "deadSignalAt" TIMESTAMP(3),
ADD COLUMN "deadSignalReason" TEXT;

-- AlterTable
ALTER TABLE "JobSourceMapping"
ADD COLUMN "sourceType" TEXT,
ADD COLUMN "sourceReliability" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN "isFullSnapshot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pollPattern" TEXT;

-- CreateIndex
CREATE INDEX "JobCanonical_status_availabilityScore_idx"
ON "JobCanonical"("status", "availabilityScore" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_lastSourceSeenAt_idx"
ON "JobCanonical"("lastSourceSeenAt");

-- CreateIndex
CREATE INDEX "JobCanonical_lastConfirmedAliveAt_idx"
ON "JobCanonical"("lastConfirmedAliveAt");
