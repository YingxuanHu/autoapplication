-- Add structured profile fields to UserProfile
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "headline" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "summary" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "skillsJson" JSONB;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "experiencesJson" JSONB;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "educationsJson" JSONB;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "projectsJson" JSONB;
