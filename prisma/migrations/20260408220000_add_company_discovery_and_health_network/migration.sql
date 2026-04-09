DO $$ BEGIN
  CREATE TYPE "JobUrlHealthResult" AS ENUM ('ALIVE', 'SUSPECT', 'DEAD', 'BLOCKED', 'ERROR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "JobUrlHealthUrlType" AS ENUM ('APPLY', 'DETAIL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CompanyDiscoveryStatus" AS ENUM ('PENDING', 'DISCOVERING', 'DISCOVERED', 'NEEDS_REVIEW', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CrawlStatus" AS ENUM ('IDLE', 'ACTIVE', 'DEGRADED', 'BLOCKED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ExtractionRouteKind" AS ENUM ('ATS_NATIVE', 'STRUCTURED_JSON', 'STRUCTURED_API', 'STRUCTURED_SITEMAP', 'HTML_FALLBACK', 'UNKNOWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CompanySourceStatus" AS ENUM ('DISCOVERED', 'PROVISIONED', 'ACTIVE', 'DEGRADED', 'REDISCOVER_REQUIRED', 'DISABLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SourceTaskKind" AS ENUM ('CONNECTOR_POLL', 'COMPANY_DISCOVERY', 'REDISCOVERY', 'URL_HEALTH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SourceTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "JobCanonical" ADD COLUMN "companyId" TEXT;

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyKey" TEXT NOT NULL,
    "domain" TEXT,
    "careersUrl" TEXT,
    "discoveryStatus" "CompanyDiscoveryStatus" NOT NULL DEFAULT 'PENDING',
    "crawlStatus" "CrawlStatus" NOT NULL DEFAULT 'IDLE',
    "detectedAts" TEXT,
    "discoveryConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastDiscoveryAt" TIMESTAMP(3),
    "lastSuccessfulPollAt" TIMESTAMP(3),
    "lastDiscoveryError" TEXT,
    "lastRediscoveryAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobUrlHealthCheck" (
    "id" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlType" "JobUrlHealthUrlType" NOT NULL,
    "result" "JobUrlHealthResult" NOT NULL,
    "statusCode" INTEGER,
    "finalUrl" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseTimeMs" INTEGER,
    "closureReason" TEXT,
    "responseSnippet" TEXT,
    "metadataJson" JSONB,

    CONSTRAINT "JobUrlHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDiscoveryPage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isChosen" BOOLEAN NOT NULL DEFAULT false,
    "extractorRoute" "ExtractionRouteKind" NOT NULL DEFAULT 'UNKNOWN',
    "parserVersion" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyDiscoveryPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySource" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "connectorName" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "boardUrl" TEXT NOT NULL,
    "status" "CompanySourceStatus" NOT NULL DEFAULT 'DISCOVERED',
    "sourceType" TEXT,
    "extractionRoute" "ExtractionRouteKind" NOT NULL DEFAULT 'UNKNOWN',
    "parserVersion" TEXT,
    "pollingCadenceMinutes" INTEGER,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cooldownUntil" TIMESTAMP(3),
    "lastProvisionedAt" TIMESTAMP(3),
    "lastDiscoveryAt" TIMESTAMP(3),
    "lastSuccessfulPollAt" TIMESTAMP(3),
    "failureStreak" INTEGER NOT NULL DEFAULT 0,
    "overlapRatio" DOUBLE PRECISION,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceTask" (
    "id" TEXT NOT NULL,
    "kind" "SourceTaskKind" NOT NULL,
    "status" "SourceTaskStatus" NOT NULL DEFAULT 'PENDING',
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notBeforeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "payloadJson" JSONB,
    "companyId" TEXT,
    "companySourceId" TEXT,
    "canonicalJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_companyKey_key" ON "Company"("companyKey");

-- CreateIndex
CREATE INDEX "Company_discoveryStatus_lastDiscoveryAt_idx" ON "Company"("discoveryStatus", "lastDiscoveryAt" DESC);

-- CreateIndex
CREATE INDEX "Company_crawlStatus_lastSuccessfulPollAt_idx" ON "Company"("crawlStatus", "lastSuccessfulPollAt" DESC);

-- CreateIndex
CREATE INDEX "Company_domain_idx" ON "Company"("domain");

-- CreateIndex
CREATE INDEX "JobUrlHealthCheck_canonicalJobId_checkedAt_idx" ON "JobUrlHealthCheck"("canonicalJobId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "JobUrlHealthCheck_result_checkedAt_idx" ON "JobUrlHealthCheck"("result", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "JobUrlHealthCheck_urlType_checkedAt_idx" ON "JobUrlHealthCheck"("urlType", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "CompanyDiscoveryPage_companyId_isChosen_idx" ON "CompanyDiscoveryPage"("companyId", "isChosen");

-- CreateIndex
CREATE INDEX "CompanyDiscoveryPage_extractorRoute_lastCheckedAt_idx" ON "CompanyDiscoveryPage"("extractorRoute", "lastCheckedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDiscoveryPage_companyId_url_key" ON "CompanyDiscoveryPage"("companyId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "CompanySource_sourceName_key" ON "CompanySource"("sourceName");

-- CreateIndex
CREATE INDEX "CompanySource_status_priorityScore_idx" ON "CompanySource"("status", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "CompanySource_companyId_status_idx" ON "CompanySource"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompanySource_companyId_connectorName_token_key" ON "CompanySource"("companyId", "connectorName", "token");

-- CreateIndex
CREATE INDEX "SourceTask_kind_status_notBeforeAt_priorityScore_idx" ON "SourceTask"("kind", "status", "notBeforeAt", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "SourceTask_companyId_kind_status_idx" ON "SourceTask"("companyId", "kind", "status");

-- CreateIndex
CREATE INDEX "SourceTask_companySourceId_kind_status_idx" ON "SourceTask"("companySourceId", "kind", "status");

-- CreateIndex
CREATE INDEX "SourceTask_canonicalJobId_kind_status_idx" ON "SourceTask"("canonicalJobId", "kind", "status");

-- CreateIndex
CREATE INDEX "JobCanonical_companyId_idx" ON "JobCanonical"("companyId");

-- AddForeignKey
ALTER TABLE "JobCanonical" ADD CONSTRAINT "JobCanonical_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobUrlHealthCheck" ADD CONSTRAINT "JobUrlHealthCheck_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDiscoveryPage" ADD CONSTRAINT "CompanyDiscoveryPage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySource" ADD CONSTRAINT "CompanySource_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceTask" ADD CONSTRAINT "SourceTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceTask" ADD CONSTRAINT "SourceTask_companySourceId_fkey" FOREIGN KEY ("companySourceId") REFERENCES "CompanySource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceTask" ADD CONSTRAINT "SourceTask_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;
