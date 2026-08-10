-- The default public board filters to LIVE entries and orders by the complete
-- relevance tuple below. The older index stopped after rankingScore, forcing
-- PostgreSQL to read and incrementally sort a large portion of the feed on
-- cache-cold requests.
CREATE INDEX IF NOT EXISTS "JobFeedIndex_live_relevance_order_idx"
  ON "JobFeedIndex"(
    "rankingScore" DESC,
    "freshnessScore" DESC,
    "qualityScore" DESC,
    "trustScore" DESC,
    "postedAt" DESC,
    "canonicalJobId" DESC
  )
  WHERE "status" = 'LIVE';
