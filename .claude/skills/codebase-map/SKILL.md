---
name: codebase-map
description: Use when orienting within the repo, locating core subsystems, or avoiding repeated repo exploration.
---

# Codebase map

**Status: Initial implementation in place.** Prisma, seed data, App Router pages, and API routes exist. Keep this file current as paths change.

## Current subsystem paths

| Subsystem | Responsibility |
|---|---|
| frontend | `src/app/jobs`, `src/app/jobs/[id]`, `src/app/jobs/[id]/apply`, `src/app/saved`, `src/app/applications`, `src/app/profile`, `src/app/ops/ingestion`, `src/components/jobs`, `src/components/layout` |
| api | `src/app/api/**` route handlers for jobs, apply review, saved jobs, stats, and profile |
| queries | `src/lib/queries/**` for Prisma-backed read/write helpers |
| schema/data | `prisma/schema.prisma`, `prisma/migrations`, `prisma/seed.ts`, `src/lib/db.ts` |
| presentation helpers | `src/lib/job-display.ts`, `src/types/jobs.ts` |
| generated prisma client | `src/generated/prisma/**` |
| ingestion/dedup runtime | `src/lib/ingestion/**`, `scripts/ingest.ts`, `scripts/ingest-scheduled.ts`, `scripts/discover-sources.ts`, `scripts/discover-rippling.ts`, `scripts/generate-seed.ts`, and `src/app/api/ingestion/schedule` for connector fetch, discovery, normalization, dedupe, lifecycle sweeps, and scheduled runs |

## Core domain objects

UserProfile, ResumeVariant, JobRaw, JobCanonical, JobSourceMapping, JobEligibility, ApplicationPackage, ApplicationSubmission, SavedJob, UserPreference, UserBehaviorSignal

## Route entry points

- `/jobs` → feed-first live job surface with shortlist decisions, collapsible filters, and trust-scored outbound links that hide demo-only records from the default feed
- `/jobs/[id]` → full job detail page with classification, source summary, and next-step actions
- `/jobs/[id]/apply` → apply-review flow with package preview and submission tracking
- `/saved` → shortlist workspace
- `/applications` → package and submission history across tracked jobs
- `/profile` → current profile, preferences, and resume variants
- `/ops/ingestion` → internal ingestion runs, source coverage, and pool counts
- `/api/ingestion/schedule` → cron-ready scheduled ingestion entrypoint with due-run checks

## Ingestion entry points

- `npm run ingest -- greenhouse --board=vercel`
- `npm run ingest -- lever --site=plaid`
- `npm run ingest -- workday '--source=paypal.wd1.myworkdayjobs.com|paypal|jobs'`
- `npm run ingest -- smartrecruiters --company=visa --limit=40`
- `npm run source:discover -- --urls=https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs`
- `npm run ingest:schedule -- --force`
- `src/lib/ingestion/connectors/greenhouse.ts` → first real public connector
- `src/lib/ingestion/connectors/lever.ts` → second real public connector
- `src/lib/ingestion/connectors/workday.ts` → Workday public careers connector using list JSON + detail-page JSON-LD
- `src/lib/ingestion/connectors/smartrecruiters.ts` → third real public connector
- `src/lib/ingestion/discovery/sources.ts` / `scripts/discover-sources.ts` → generic ATS source discovery registry, preview validation, and promotion flow
- `src/lib/ingestion/pipeline.ts` → raw upsert, canonical upsert, source mapping, dedupe, lifecycle/expiry handling, eligibility, and run tracking
- `src/lib/ingestion/registry.ts` / `src/lib/ingestion/scheduler.ts` → connector resolution, cadence config, and scheduled batch execution

## How to use this file

Point Claude to where logic belongs and which files are entry points. Keep it as a navigation index, not a design doc. Prefer updating this file when new top-level routes or subsystems land.
