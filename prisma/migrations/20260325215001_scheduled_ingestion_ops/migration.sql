-- CreateEnum
CREATE TYPE "IngestionRunMode" AS ENUM ('MANUAL', 'SCHEDULED', 'API');

-- AlterEnum
ALTER TYPE "IngestionRunStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "IngestionRun" ADD COLUMN     "removedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "runMode" "IngestionRunMode" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "JobCanonical" ADD COLUMN     "descriptionFingerprint" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "staleAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "IngestionRun_runMode_startedAt_idx" ON "IngestionRun"("runMode", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_companyKey_descriptionFingerprint_region_idx" ON "JobCanonical"("companyKey", "descriptionFingerprint", "region");
