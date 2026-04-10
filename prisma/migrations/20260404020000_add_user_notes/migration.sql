-- Add userNotes to ApplicationPackage for per-job personal notes
ALTER TABLE "ApplicationPackage" ADD COLUMN IF NOT EXISTS "userNotes" TEXT;
