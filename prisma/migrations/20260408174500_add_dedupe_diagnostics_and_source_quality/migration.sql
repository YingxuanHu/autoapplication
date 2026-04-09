-- AlterTable
ALTER TABLE "JobSourceMapping"
ADD COLUMN "applyUrlKey" TEXT,
ADD COLUMN "sourceUrlKey" TEXT,
ADD COLUMN "postingIdKey" TEXT,
ADD COLUMN "sourceQualityKind" TEXT,
ADD COLUMN "sourceQualityRank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "dedupeMatchedBy" TEXT,
ADD COLUMN "dedupeScore" INTEGER,
ADD COLUMN "dedupeEvidence" JSONB,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "JobSourceMapping_applyUrlKey_idx" ON "JobSourceMapping"("applyUrlKey");

-- CreateIndex
CREATE INDEX "JobSourceMapping_sourceUrlKey_idx" ON "JobSourceMapping"("sourceUrlKey");

-- CreateIndex
CREATE INDEX "JobSourceMapping_postingIdKey_idx" ON "JobSourceMapping"("postingIdKey");

-- CreateIndex
CREATE INDEX "JobSourceMapping_canonicalJobId_removedAt_sourceQualityRank_idx"
ON "JobSourceMapping"("canonicalJobId", "removedAt", "sourceQualityRank" DESC);
