ALTER TABLE "Document"
ADD COLUMN "title" TEXT,
ADD COLUMN "originalFileName" TEXT,
ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Document" AS d
SET "originalFileName" = d."filename";

UPDATE "Document" AS d
SET "title" = COALESCE(
  (
    SELECT rv."label"
    FROM "ResumeVariant" AS rv
    WHERE rv."documentId" = d."id"
    LIMIT 1
  ),
  NULLIF(regexp_replace(d."filename", '\.[^.]+$', ''), '')
);

UPDATE "Document"
SET "title" = "filename"
WHERE "title" IS NULL;

UPDATE "Document" AS d
SET "isPrimary" = COALESCE(
  (
    SELECT rv."isDefault"
    FROM "ResumeVariant" AS rv
    WHERE rv."documentId" = d."id"
    LIMIT 1
  ),
  false
);

ALTER TABLE "Document"
ALTER COLUMN "title" SET NOT NULL,
ALTER COLUMN "originalFileName" SET NOT NULL;

CREATE TABLE "DocumentAnalysis" (
  "documentId" TEXT NOT NULL,
  "extractedText" TEXT NOT NULL,
  "keywordsJson" JSONB NOT NULL,
  "sectionsJson" JSONB NOT NULL,
  "structuredProfileJson" JSONB,
  "importSummaryJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DocumentAnalysis_pkey" PRIMARY KEY ("documentId")
);

INSERT INTO "DocumentAnalysis" (
  "documentId",
  "extractedText",
  "keywordsJson",
  "sectionsJson",
  "createdAt",
  "updatedAt"
)
SELECT
  d."id",
  d."extractedText",
  '[]'::jsonb,
  '{}'::jsonb,
  COALESCE(d."extractedAt", d."createdAt"),
  d."updatedAt"
FROM "Document" AS d
WHERE d."extractedText" IS NOT NULL;

CREATE INDEX "Document_userId_type_createdAt_idx"
ON "Document"("userId", "type", "createdAt");

CREATE INDEX "Document_userId_type_isPrimary_idx"
ON "Document"("userId", "type", "isPrimary");

ALTER TABLE "DocumentAnalysis"
ADD CONSTRAINT "DocumentAnalysis_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
