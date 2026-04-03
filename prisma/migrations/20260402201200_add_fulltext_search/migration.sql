-- Enable pg_trgm extension for fuzzy/partial matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add a generated tsvector column for full-text search on title, company, roleFamily
ALTER TABLE "JobCanonical"
ADD COLUMN "searchVector" tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
  setweight(to_tsvector('english', coalesce("roleFamily", '')), 'C') ||
  setweight(to_tsvector('english', coalesce(location, '')), 'D')
) STORED;

-- GIN index for fast full-text search
CREATE INDEX "JobCanonical_searchVector_idx" ON "JobCanonical" USING GIN ("searchVector");

-- GIN trigram indexes for partial/fuzzy matching (fallback for short queries)
CREATE INDEX "JobCanonical_title_trgm_idx" ON "JobCanonical" USING GIN (title gin_trgm_ops);
CREATE INDEX "JobCanonical_company_trgm_idx" ON "JobCanonical" USING GIN (company gin_trgm_ops);
