-- CreateEnum
CREATE TYPE "AtsPlatform" AS ENUM (
  'ASHBY',
  'BAMBOOHR',
  'EIGHTFOLD',
  'GENERIC',
  'GREENHOUSE',
  'ICIMS',
  'JOBVITE',
  'LEVER',
  'PARADOX',
  'PHENOM',
  'RECRUITEE',
  'RIPPLING',
  'SMARTRECRUITERS',
  'SUCCESSFACTORS',
  'TALEO',
  'TEAMTAILOR',
  'WORKABLE',
  'WORKDAY'
);

-- CreateEnum
CREATE TYPE "SourceCandidateType" AS ENUM (
  'AGGREGATOR_LEAD',
  'ATS_BOARD',
  'CAREER_PAGE',
  'COMPANY_ROOT',
  'JOB_PAGE',
  'SITEMAP'
);

-- CreateEnum
CREATE TYPE "SourceCandidateStatus" AS ENUM (
  'NEW',
  'VALIDATED',
  'PROMOTED',
  'REJECTED',
  'STALE'
);

-- CreateEnum
CREATE TYPE "DiscoveryMode" AS ENUM (
  'EXPLORATION',
  'EXPLOITATION'
);

-- CreateEnum
CREATE TYPE "NormalizedJobRecordStatus" AS ENUM (
  'STAGED',
  'NORMALIZED',
  'VALIDATED',
  'REJECTED',
  'CANONICALIZED'
);

-- CreateEnum
CREATE TYPE "PipelineQueueName" AS ENUM (
  'SOURCE_DISCOVERY',
  'SOURCE_VALIDATION',
  'CONNECTOR_POLL',
  'RAW_PARSE',
  'NORMALIZE',
  'JOB_INTEGRITY',
  'DEDUPE',
  'LIFECYCLE',
  'SEARCH_INDEX'
);

-- CreateEnum
CREATE TYPE "PipelineTaskStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'SKIPPED'
);

-- AlterTable
ALTER TABLE "CompanySource"
ADD COLUMN "atsTenantId" TEXT;

-- AlterTable
ALTER TABLE "JobCanonical"
ADD COLUMN "freshnessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ATSTenant" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "platform" "AtsPlatform" NOT NULL,
  "tenantKey" TEXT NOT NULL,
  "normalizedBoardUrl" TEXT NOT NULL,
  "rootHost" TEXT NOT NULL,
  "status" "SourceCandidateStatus" NOT NULL DEFAULT 'NEW',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discoveryMethod" TEXT,
  "metadataJson" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastValidatedAt" TIMESTAMP(3),
  "lastPromotedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ATSTenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceCandidate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "atsTenantId" TEXT,
  "candidateType" "SourceCandidateType" NOT NULL,
  "status" "SourceCandidateStatus" NOT NULL DEFAULT 'NEW',
  "discoveryMode" "DiscoveryMode" NOT NULL DEFAULT 'EXPLORATION',
  "candidateUrl" TEXT NOT NULL,
  "normalizedUrlKey" TEXT NOT NULL,
  "rootHost" TEXT,
  "rootDomain" TEXT,
  "companyNameHint" TEXT,
  "titleHint" TEXT,
  "atsPlatform" "AtsPlatform",
  "atsTenantKey" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "noveltyScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "coverageGapScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "potentialYieldScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sourceQualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "metadataJson" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastValidatedAt" TIMESTAMP(3),
  "promotedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SourceCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedJobRecord" (
  "id" TEXT NOT NULL,
  "rawJobId" TEXT NOT NULL,
  "canonicalJobId" TEXT,
  "status" "NormalizedJobRecordStatus" NOT NULL DEFAULT 'STAGED',
  "normalizationVersion" TEXT NOT NULL,
  "rejectionReason" TEXT,
  "integrityReason" TEXT,
  "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "freshnessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "title" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "companyKey" TEXT NOT NULL DEFAULT '',
  "titleKey" TEXT NOT NULL DEFAULT '',
  "titleCoreKey" TEXT NOT NULL DEFAULT '',
  "descriptionFingerprint" TEXT NOT NULL DEFAULT '',
  "location" TEXT NOT NULL,
  "locationKey" TEXT NOT NULL DEFAULT '',
  "region" "Region",
  "workMode" "WorkMode" NOT NULL,
  "salaryMin" INTEGER,
  "salaryMax" INTEGER,
  "salaryCurrency" TEXT DEFAULT 'USD',
  "employmentType" "EmploymentType" NOT NULL,
  "experienceLevel" "ExperienceLevel",
  "description" TEXT NOT NULL,
  "shortSummary" TEXT NOT NULL,
  "industry" "Industry",
  "roleFamily" TEXT NOT NULL,
  "applyUrl" TEXT NOT NULL,
  "applyUrlKey" TEXT,
  "postedAt" TIMESTAMP(3) NOT NULL,
  "deadline" TIMESTAMP(3),
  "duplicateClusterId" TEXT NOT NULL,
  "metadataJson" JSONB,
  "warningsJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NormalizedJobRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineTask" (
  "id" TEXT NOT NULL,
  "queueName" "PipelineQueueName" NOT NULL,
  "status" "PipelineTaskStatus" NOT NULL DEFAULT 'PENDING',
  "mode" "DiscoveryMode",
  "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT,
  "notBeforeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "payloadJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PipelineTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobFeedIndex" (
  "canonicalJobId" TEXT NOT NULL,
  "status" "JobStatus" NOT NULL,
  "submissionCategory" "SubmissionCategory",
  "title" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "region" "Region",
  "workMode" "WorkMode" NOT NULL,
  "employmentType" "EmploymentType" NOT NULL,
  "experienceLevel" "ExperienceLevel",
  "industry" "Industry",
  "roleFamily" TEXT NOT NULL,
  "salaryMin" INTEGER,
  "salaryMax" INTEGER,
  "salaryCurrency" TEXT,
  "postedAt" TIMESTAMP(3) NOT NULL,
  "deadline" TIMESTAMP(3),
  "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "freshnessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rankingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sourceCount" INTEGER NOT NULL DEFAULT 0,
  "applyUrl" TEXT NOT NULL,
  "searchText" TEXT NOT NULL,
  "metadataJson" JSONB,
  "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JobFeedIndex_pkey" PRIMARY KEY ("canonicalJobId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanySource_atsTenantId_key" ON "CompanySource"("atsTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ATSTenant_platform_tenantKey_key" ON "ATSTenant"("platform", "tenantKey");

-- CreateIndex
CREATE UNIQUE INDEX "ATSTenant_platform_normalizedBoardUrl_key" ON "ATSTenant"("platform", "normalizedBoardUrl");

-- CreateIndex
CREATE INDEX "ATSTenant_status_confidence_lastSeenAt_idx" ON "ATSTenant"("status", "confidence" DESC, "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "ATSTenant_companyId_status_idx" ON "ATSTenant"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SourceCandidate_candidateType_normalizedUrlKey_key" ON "SourceCandidate"("candidateType", "normalizedUrlKey");

-- CreateIndex
CREATE INDEX "SourceCandidate_status_discoveryMode_coverageGapScore_noveltyScore_idx" ON "SourceCandidate"("status", "discoveryMode", "coverageGapScore" DESC, "noveltyScore" DESC);

-- CreateIndex
CREATE INDEX "SourceCandidate_atsPlatform_status_potentialYieldScore_idx" ON "SourceCandidate"("atsPlatform", "status", "potentialYieldScore" DESC);

-- CreateIndex
CREATE INDEX "SourceCandidate_companyId_status_idx" ON "SourceCandidate"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedJobRecord_rawJobId_key" ON "NormalizedJobRecord"("rawJobId");

-- CreateIndex
CREATE INDEX "NormalizedJobRecord_status_qualityScore_trustScore_idx" ON "NormalizedJobRecord"("status", "qualityScore" DESC, "trustScore" DESC);

-- CreateIndex
CREATE INDEX "NormalizedJobRecord_companyKey_titleCoreKey_region_idx" ON "NormalizedJobRecord"("companyKey", "titleCoreKey", "region");

-- CreateIndex
CREATE INDEX "NormalizedJobRecord_duplicateClusterId_idx" ON "NormalizedJobRecord"("duplicateClusterId");

-- CreateIndex
CREATE INDEX "NormalizedJobRecord_canonicalJobId_idx" ON "NormalizedJobRecord"("canonicalJobId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineTask_queueName_idempotencyKey_key" ON "PipelineTask"("queueName", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PipelineTask_queueName_status_notBeforeAt_priorityScore_idx" ON "PipelineTask"("queueName", "status", "notBeforeAt", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "PipelineTask_status_leaseExpiresAt_idx" ON "PipelineTask"("status", "leaseExpiresAt" ASC);

-- CreateIndex
CREATE INDEX "JobFeedIndex_status_rankingScore_postedAt_idx" ON "JobFeedIndex"("status", "rankingScore" DESC, "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobFeedIndex_region_rankingScore_postedAt_idx" ON "JobFeedIndex"("region", "rankingScore" DESC, "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobFeedIndex_roleFamily_rankingScore_postedAt_idx" ON "JobFeedIndex"("roleFamily", "rankingScore" DESC, "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobFeedIndex_submissionCategory_rankingScore_postedAt_idx" ON "JobFeedIndex"("submissionCategory", "rankingScore" DESC, "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_qualityScore_idx" ON "JobCanonical"("status", "qualityScore" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_freshnessScore_idx" ON "JobCanonical"("status", "freshnessScore" DESC);

-- AddForeignKey
ALTER TABLE "CompanySource"
ADD CONSTRAINT "CompanySource_atsTenantId_fkey"
FOREIGN KEY ("atsTenantId") REFERENCES "ATSTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ATSTenant"
ADD CONSTRAINT "ATSTenant_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCandidate"
ADD CONSTRAINT "SourceCandidate_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCandidate"
ADD CONSTRAINT "SourceCandidate_atsTenantId_fkey"
FOREIGN KEY ("atsTenantId") REFERENCES "ATSTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedJobRecord"
ADD CONSTRAINT "NormalizedJobRecord_rawJobId_fkey"
FOREIGN KEY ("rawJobId") REFERENCES "JobRaw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedJobRecord"
ADD CONSTRAINT "NormalizedJobRecord_canonicalJobId_fkey"
FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFeedIndex"
ADD CONSTRAINT "JobFeedIndex_canonicalJobId_fkey"
FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;
