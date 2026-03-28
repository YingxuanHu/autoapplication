---
name: job-ingestion
description: Use when discussing job sources, refresh logic, freshness, region focus, expiration handling, or large-scale job supply.
---

# Job ingestion

## Goal

The product depends on a large, continuously refreshed, multi-source North American job supply.
This is a core foundation, not a side feature.

## Main requirements

- pull from many sources
- prioritize North America
- focus first on tech and finance
- maintain a large live job pool
- keep data fresh
- remove expired jobs
- avoid duplicates
- preserve source mappings

## Source categories

### Tier 1: Structured and reliable sources
Examples:
- partner APIs
- stable job data providers
- structured ATS-backed feeds

Best for:
- consistency
- refresh reliability
- normalized data quality

### Tier 2: Official company career pages
Examples:
- public company careers portals
- ATS-powered company listings

Best for:
- official source confidence
- high-value direct listings

### Tier 3: Aggregators and broader job web sources
Examples:
- public job boards
- aggregators
- weaker or noisier sources

Best for:
- coverage
But they require stronger dedupe and validation.

## Geographic scope

Initial focus:
- Canada
- United States

Reason:
- manageable scope
- better relevance
- easier normalization
- easier user fit assumptions

## Pool design

### Total job pool
Contains:
- all live
- relevant
- deduplicated
- North America-focused jobs

### Auto-apply eligible pool
Subset of total job pool.
Only jobs that pass automation thresholds.

## Refresh requirements

The system should not rely on a static database.
It must continuously refresh and revalidate jobs.

Refresh responsibilities:
- pull new postings
- recheck live status
- mark expired postings
- detect removed jobs
- update deadlines
- re-evaluate automation eligibility

## Freshness principles

Prefer:
- recent jobs
- still-live jobs
- jobs with valid application links

Avoid showing:
- removed postings
- closed postings
- stale listings that were never refreshed
- duplicates

## User-facing freshness signals

The jobs page should surface:
- new jobs since last visit
- jobs expired since last visit
- saved jobs nearing deadline
- jobs newly classified as auto-apply eligible

## Scale target

Target a large deduplicated live pool, roughly:
- 50k to 100k jobs

Quality matters more than raw count.
A smaller clean pool is better than a larger noisy one.

## Ingestion pipeline stages

1. Source fetch
2. Raw storage
3. normalization
4. deduplication
5. freshness validation
6. eligibility classification
7. ranking/indexing

## Required normalized fields

- canonical job id
- source id
- company
- title
- location
- region
- work mode
- salary if available
- employment type
- experience level
- description
- posting date
- deadline if available
- apply url
- source name
- industry / role family
- automation tag
- duplicate cluster id