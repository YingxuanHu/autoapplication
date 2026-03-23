-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobSource" ADD VALUE 'REMOTEOK';
ALTER TYPE "JobSource" ADD VALUE 'ARBEITNOW';
ALTER TYPE "JobSource" ADD VALUE 'HIMALAYAS';
ALTER TYPE "JobSource" ADD VALUE 'LINKEDIN';
ALTER TYPE "JobSource" ADD VALUE 'INDEED';
ALTER TYPE "JobSource" ADD VALUE 'GLASSDOOR';
