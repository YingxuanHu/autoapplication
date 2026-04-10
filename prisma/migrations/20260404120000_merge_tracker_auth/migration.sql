-- Auth + tracker merge. Keep existing full-text search infrastructure intact.

-- CreateEnum
CREATE TYPE "TrackedApplicationStatus" AS ENUM ('WISHLIST', 'APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TrackedApplicationEventType" AS ENUM ('APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'REJECTED', 'NOTE', 'REMINDER');

-- CreateEnum
CREATE TYPE "TrackedApplicationDocumentSlot" AS ENUM ('SENT_RESUME', 'SENT_COVER_LETTER');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DEADLINE_REMINDER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DeadlineReminderType" AS ENUM ('DEADLINE_D7', 'DEADLINE_D3', 'DEADLINE_D1', 'DEADLINE_TODAY', 'DEADLINE_OVERDUE_D1');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'RESUME_TEMPLATE';

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "authUserId" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalJobId" TEXT,
    "company" TEXT NOT NULL,
    "roleTitle" TEXT NOT NULL,
    "roleUrl" TEXT,
    "status" "TrackedApplicationStatus" NOT NULL DEFAULT 'WISHLIST',
    "deadline" TIMESTAMP(3),
    "jobDescription" TEXT,
    "fitAnalysis" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedApplicationEvent" (
    "id" TEXT NOT NULL,
    "trackedApplicationId" TEXT NOT NULL,
    "type" "TrackedApplicationEventType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "reminderAt" TIMESTAMP(3),
    "reminderNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "TrackedApplicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedApplicationTag" (
    "trackedApplicationId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TrackedApplicationTag_pkey" PRIMARY KEY ("trackedApplicationId","tagId")
);

-- CreateTable
CREATE TABLE "TrackedApplicationDocument" (
    "id" TEXT NOT NULL,
    "trackedApplicationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "slot" "TrackedApplicationDocumentSlot" NOT NULL,

    CONSTRAINT "TrackedApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackedApplicationId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackedApplicationId" TEXT NOT NULL,
    "reminderType" "DeadlineReminderType" NOT NULL,
    "deadlineDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "TrackedApplication_userId_idx" ON "TrackedApplication"("userId");

-- CreateIndex
CREATE INDEX "TrackedApplication_status_idx" ON "TrackedApplication"("status");

-- CreateIndex
CREATE INDEX "TrackedApplication_deadline_idx" ON "TrackedApplication"("deadline");

-- CreateIndex
CREATE INDEX "TrackedApplication_canonicalJobId_idx" ON "TrackedApplication"("canonicalJobId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedApplication_userId_canonicalJobId_key" ON "TrackedApplication"("userId", "canonicalJobId");

-- CreateIndex
CREATE INDEX "TrackedApplicationEvent_trackedApplicationId_idx" ON "TrackedApplicationEvent"("trackedApplicationId");

-- CreateIndex
CREATE INDEX "TrackedApplicationEvent_timestamp_idx" ON "TrackedApplicationEvent"("timestamp");

-- CreateIndex
CREATE INDEX "TrackedApplicationEvent_reminderAt_idx" ON "TrackedApplicationEvent"("reminderAt");

-- CreateIndex
CREATE INDEX "Tag_userId_idx" ON "Tag"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_name_key" ON "Tag"("userId", "name");

-- CreateIndex
CREATE INDEX "TrackedApplicationTag_tagId_idx" ON "TrackedApplicationTag"("tagId");

-- CreateIndex
CREATE INDEX "TrackedApplicationDocument_documentId_idx" ON "TrackedApplicationDocument"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedApplicationDocument_trackedApplicationId_slot_key" ON "TrackedApplicationDocument"("trackedApplicationId", "slot");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_trackedApplicationId_idx" ON "Notification"("trackedApplicationId");

-- CreateIndex
CREATE INDEX "Notification_readAt_idx" ON "Notification"("readAt");

-- CreateIndex
CREATE INDEX "ReminderLog_userId_createdAt_idx" ON "ReminderLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReminderLog_trackedApplicationId_idx" ON "ReminderLog"("trackedApplicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_userId_trackedApplicationId_reminderType_deadli_key" ON "ReminderLog"("userId", "trackedApplicationId", "reminderType", "deadlineDate");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_authUserId_key" ON "UserProfile"("authUserId");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_authUserId_fkey" FOREIGN KEY ("authUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplication" ADD CONSTRAINT "TrackedApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplication" ADD CONSTRAINT "TrackedApplication_canonicalJobId_fkey" FOREIGN KEY ("canonicalJobId") REFERENCES "JobCanonical"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplicationEvent" ADD CONSTRAINT "TrackedApplicationEvent_trackedApplicationId_fkey" FOREIGN KEY ("trackedApplicationId") REFERENCES "TrackedApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplicationTag" ADD CONSTRAINT "TrackedApplicationTag_trackedApplicationId_fkey" FOREIGN KEY ("trackedApplicationId") REFERENCES "TrackedApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplicationTag" ADD CONSTRAINT "TrackedApplicationTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplicationDocument" ADD CONSTRAINT "TrackedApplicationDocument_trackedApplicationId_fkey" FOREIGN KEY ("trackedApplicationId") REFERENCES "TrackedApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedApplicationDocument" ADD CONSTRAINT "TrackedApplicationDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_trackedApplicationId_fkey" FOREIGN KEY ("trackedApplicationId") REFERENCES "TrackedApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_trackedApplicationId_fkey" FOREIGN KEY ("trackedApplicationId") REFERENCES "TrackedApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
