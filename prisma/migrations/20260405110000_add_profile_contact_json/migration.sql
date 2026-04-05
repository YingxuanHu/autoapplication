ALTER TABLE "UserProfile"
ADD COLUMN "contactJson" JSONB;

UPDATE "UserProfile"
SET "contactJson" = jsonb_strip_nulls(
  jsonb_build_object(
    'fullName', NULLIF("name", ''),
    'email', NULLIF("email", ''),
    'phone', NULLIF("phone", ''),
    'location', NULLIF("location", ''),
    'linkedInUrl', NULLIF("linkedinUrl", ''),
    'githubUrl', NULLIF("githubUrl", ''),
    'portfolioUrl', NULLIF("portfolioUrl", '')
  )
);
