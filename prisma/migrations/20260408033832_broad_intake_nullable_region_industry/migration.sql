-- DropIndex
DROP INDEX IF EXISTS "JobCanonical_company_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "JobCanonical_searchVector_idx";

-- DropIndex
DROP INDEX IF EXISTS "JobCanonical_title_trgm_idx";

-- AlterTable
ALTER TABLE "JobCanonical" ALTER COLUMN "region" DROP NOT NULL,
ALTER COLUMN "industry" DROP NOT NULL;
