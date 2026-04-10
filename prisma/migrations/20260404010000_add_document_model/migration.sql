-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DocumentType" AS ENUM ('RESUME', 'COVER_LETTER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Document" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "extractedText" TEXT,
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Document_storageKey_key" ON "Document"("storageKey");
CREATE INDEX IF NOT EXISTS "Document_userId_type_idx" ON "Document"("userId", "type");

-- Add documentId to ResumeVariant
ALTER TABLE "ResumeVariant" ADD COLUMN IF NOT EXISTS "documentId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ResumeVariant_documentId_key" ON "ResumeVariant"("documentId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResumeVariant" ADD CONSTRAINT "ResumeVariant_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
