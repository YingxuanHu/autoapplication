-- AlterTable
ALTER TABLE "JobCanonical" ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "JobSourceMapping" ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "removedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobCanonical_status_lastSeenAt_idx" ON "JobCanonical"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "JobCanonical_duplicateClusterId_idx" ON "JobCanonical"("duplicateClusterId");

-- CreateIndex
CREATE INDEX "JobSourceMapping_sourceName_removedAt_idx" ON "JobSourceMapping"("sourceName", "removedAt");

-- CreateIndex
CREATE INDEX "JobSourceMapping_canonicalJobId_removedAt_idx" ON "JobSourceMapping"("canonicalJobId", "removedAt");
