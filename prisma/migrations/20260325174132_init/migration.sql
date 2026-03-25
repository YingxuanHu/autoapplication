-- CreateEnum
CREATE TYPE "WorkMode" AS ENUM ('REMOTE', 'HYBRID', 'ONSITE', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('ENTRY', 'MID', 'SENIOR', 'LEAD', 'EXECUTIVE');

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('US', 'CA');

-- CreateEnum
CREATE TYPE "Industry" AS ENUM ('TECH', 'FINANCE');

-- CreateEnum
CREATE TYPE "SubmissionCategory" AS ENUM ('AUTO_SUBMIT_READY', 'AUTO_FILL_REVIEW', 'MANUAL_ONLY');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('DISCOVERY_ONLY', 'ASSIST', 'REVIEW_BEFORE_SUBMIT', 'STRICT_AUTO_APPLY');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'READY', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SavedJobStatus" AS ENUM ('ACTIVE', 'APPLIED', 'EXPIRED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "SourceTier" AS ENUM ('TIER_1', 'TIER_2', 'TIER_3');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('LIVE', 'EXPIRED', 'REMOVED', 'STALE');

-- CreateEnum
CREATE TYPE "UserAction" AS ENUM ('APPLY', 'PASS', 'SAVE', 'VIEW_DETAILS');

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "linkedinUrl" TEXT,
    "githubUrl" TEXT,
    "portfolioUrl" TEXT,
    "workAuthorization" TEXT,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "salaryCurrency" TEXT DEFAULT 'USD',
    "preferredWorkMode" "WorkMode",
    "experienceLevel" "ExperienceLevel",
    "automationMode" "AutomationMode" NOT NULL DEFAULT 'REVIEW_BEFORE_SUBMIT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeVariant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "targetRoleFamily" TEXT,
    "fileUrl" TEXT,
    "content" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResumeVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRaw" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceTier" "SourceTier" NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCanonical" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "region" "Region" NOT NULL,
    "workMode" "WorkMode" NOT NULL,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "salaryCurrency" TEXT DEFAULT 'USD',
    "employmentType" "EmploymentType" NOT NULL,
    "experienceLevel" "ExperienceLevel",
    "description" TEXT NOT NULL,
    "shortSummary" TEXT NOT NULL,
    "industry" "Industry" NOT NULL,
    "roleFamily" TEXT NOT NULL,
    "applyUrl" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "deadline" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'LIVE',
    "duplicateClusterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCanonical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSourceMapping" (
    "id" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "rawJobId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSourceMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEligibility" (
    "id" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "submissionCategory" "SubmissionCategory" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonDescription" TEXT NOT NULL,
    "jobValidityConfidence" DOUBLE PRECISION NOT NULL,
    "formAutomationConfidence" DOUBLE PRECISION NOT NULL,
    "packageFitConfidence" DOUBLE PRECISION NOT NULL,
    "submissionQualityConfidence" DOUBLE PRECISION NOT NULL,
    "customizationLevel" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobEligibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationPackage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "resumeVariantId" TEXT NOT NULL,
    "coverLetterContent" TEXT,
    "savedAnswers" JSONB,
    "attachedLinks" JSONB,
    "whyItMatches" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "packageId" TEXT,
    "status" "ApplicationStatus" NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submissionMethod" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "status" "SavedJobStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isHardFilter" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBehaviorSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalJobId" TEXT NOT NULL,
    "action" "UserAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBehaviorSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_email_key" ON "UserProfile"("email");

-- CreateIndex
CREATE UNIQUE INDEX "JobRaw_sourceName_sourceId_key" ON "JobRaw"("sourceName", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JobEligibility_canonicalJobId_key" ON "JobEligibility"("canonicalJobId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedJob_userId_canonicalJobId_key" ON "SavedJob"("userId", "canonicalJobId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_userId_key_key" ON "UserPreference"("userId", "key");

-- AddForeignKey
ALTER TABLE "ResumeVariant" ADD CONSTRAINT "ResumeVariant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSourceMapping" ADD CONSTRAINT "JobSourceMapping_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSourceMapping" ADD CONSTRAINT "JobSourceMapping_rawJobId_fkey" FOREIGN KEY ("rawJobId") REFERENCES "JobRaw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEligibility" ADD CONSTRAINT "JobEligibility_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationPackage" ADD CONSTRAINT "ApplicationPackage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationPackage" ADD CONSTRAINT "ApplicationPackage_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationPackage" ADD CONSTRAINT "ApplicationPackage_resumeVariantId_fkey" FOREIGN KEY ("resumeVariantId") REFERENCES "ResumeVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationSubmission" ADD CONSTRAINT "ApplicationSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationSubmission" ADD CONSTRAINT "ApplicationSubmission_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationSubmission" ADD CONSTRAINT "ApplicationSubmission_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ApplicationPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedJob" ADD CONSTRAINT "SavedJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedJob" ADD CONSTRAINT "SavedJob_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBehaviorSignal" ADD CONSTRAINT "UserBehaviorSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBehaviorSignal" ADD CONSTRAINT "UserBehaviorSignal_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE CASCADE ON UPDATE CASCADE;
