-- CreateEnum
CREATE TYPE "RegionScope" AS ENUM ('US', 'CA', 'NA', 'GLOBAL');

-- CreateEnum
CREATE TYPE "JobFamily" AS ENUM ('SOFTWARE', 'DATA', 'AI_ML', 'SECURITY', 'DEVOPS', 'ENGINEERING', 'SCIENCE', 'ANALYTICS', 'MATH', 'QUANT', 'ACTUARIAL', 'OPERATIONS_RESEARCH', 'OTHER');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "canonicalCompanyDomain" TEXT,
ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "isAgency" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isInternship" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPublicSector" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jobFamily" "JobFamily",
ADD COLUMN     "jobSubfamily" TEXT,
ADD COLUMN     "regionScope" "RegionScope",
ADD COLUMN     "stemScore" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Job_countryCode_idx" ON "Job"("countryCode");

-- CreateIndex
CREATE INDEX "Job_regionScope_idx" ON "Job"("regionScope");

-- CreateIndex
CREATE INDEX "Job_jobFamily_idx" ON "Job"("jobFamily");

-- CreateIndex
CREATE INDEX "Job_stemScore_idx" ON "Job"("stemScore");

-- CreateIndex
CREATE INDEX "Job_canonicalCompanyDomain_idx" ON "Job"("canonicalCompanyDomain");
