-- CreateEnum
CREATE TYPE "ATSType" AS ENUM ('GREENHOUSE', 'LEVER', 'ASHBY', 'SMARTRECRUITERS', 'WORKABLE', 'WORKDAY', 'TEAMTAILOR', 'RECRUITEE', 'CUSTOM_SITE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('CAREER_PAGE', 'ATS_BOARD', 'STRUCTURED_DATA', 'AGGREGATOR');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('PENDING', 'CRAWLING', 'SUCCESS', 'FAILED', 'RATE_LIMITED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DiscoveryMethod" AS ENUM ('HOMEPAGE_LINK', 'SITEMAP', 'ROBOTS_TXT', 'DNS_PATTERN', 'ATS_DETECTION', 'MANUAL', 'STRUCTURED_DATA');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobSource" ADD VALUE 'WORKABLE';
ALTER TYPE "JobSource" ADD VALUE 'WORKDAY';
ALTER TYPE "JobSource" ADD VALUE 'TEAMTAILOR';
ALTER TYPE "JobSource" ADD VALUE 'RECRUITEE';
ALTER TYPE "JobSource" ADD VALUE 'COMPANY_SITE';
ALTER TYPE "JobSource" ADD VALUE 'STRUCTURED_DATA';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "isDirectApply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceTrust" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN     "sourceType" "SourceType";

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "careersUrl" TEXT,
    "logoUrl" TEXT,
    "detectedATS" "ATSType",
    "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "crawlStatus" "CrawlStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_sources" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "atsType" "ATSType",
    "sourceUrl" TEXT NOT NULL,
    "boardToken" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastCrawlStatus" "CrawlStatus",
    "lastCrawlAt" TIMESTAMP(3),
    "lastJobCount" INTEGER,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_crawl_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT,
    "status" "CrawlStatus" NOT NULL DEFAULT 'PENDING',
    "jobsFound" INTEGER NOT NULL DEFAULT 0,
    "jobsNew" INTEGER NOT NULL DEFAULT 0,
    "jobsUpdated" INTEGER NOT NULL DEFAULT 0,
    "jobsRemoved" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "source_crawl_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_discoveries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "crawlRunId" TEXT,
    "discoveredUrl" TEXT NOT NULL,
    "discoveryMethod" "DiscoveryMethod" NOT NULL,
    "sourceType" "SourceType",
    "atsType" "ATSType",
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "isPromoted" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_discoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_domain_key" ON "companies"("domain");

-- CreateIndex
CREATE INDEX "companies_domain_idx" ON "companies"("domain");

-- CreateIndex
CREATE INDEX "companies_crawlStatus_idx" ON "companies"("crawlStatus");

-- CreateIndex
CREATE INDEX "companies_trustScore_idx" ON "companies"("trustScore");

-- CreateIndex
CREATE INDEX "company_sources_sourceType_idx" ON "company_sources"("sourceType");

-- CreateIndex
CREATE INDEX "company_sources_atsType_idx" ON "company_sources"("atsType");

-- CreateIndex
CREATE INDEX "company_sources_isActive_idx" ON "company_sources"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "company_sources_companyId_sourceUrl_key" ON "company_sources"("companyId", "sourceUrl");

-- CreateIndex
CREATE INDEX "source_crawl_runs_companyId_idx" ON "source_crawl_runs"("companyId");

-- CreateIndex
CREATE INDEX "source_crawl_runs_sourceId_idx" ON "source_crawl_runs"("sourceId");

-- CreateIndex
CREATE INDEX "source_crawl_runs_status_idx" ON "source_crawl_runs"("status");

-- CreateIndex
CREATE INDEX "source_crawl_runs_startedAt_idx" ON "source_crawl_runs"("startedAt");

-- CreateIndex
CREATE INDEX "source_discoveries_companyId_idx" ON "source_discoveries"("companyId");

-- CreateIndex
CREATE INDEX "source_discoveries_discoveryMethod_idx" ON "source_discoveries"("discoveryMethod");

-- CreateIndex
CREATE INDEX "Job_fingerprint_idx" ON "Job"("fingerprint");

-- CreateIndex
CREATE INDEX "Job_companyId_idx" ON "Job"("companyId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_sources" ADD CONSTRAINT "company_sources_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_crawl_runs" ADD CONSTRAINT "source_crawl_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_crawl_runs" ADD CONSTRAINT "source_crawl_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "company_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_discoveries" ADD CONSTRAINT "source_discoveries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_discoveries" ADD CONSTRAINT "source_discoveries_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "source_crawl_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
