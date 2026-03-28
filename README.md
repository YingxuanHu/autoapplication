## AutoApplication

North America-focused job search and application engine for tech and finance roles first.

Current implemented slice:

- feed-first `/jobs` experience over a canonical live job pool
- `/jobs` now defaults to live non-demo-backed jobs and resolves outbound links through a trust layer before rendering external actions
- dedicated `/jobs/[id]` detail page with classification, explanation, and source context
- `/jobs/[id]/apply` review flow with resume/package preview and submission tracking
- shortlist workflow through `/saved`
- application history in `/applications`
- profile and resume overview in `/profile`
- internal `/ops/ingestion` visibility page for recent runs, source coverage, schedule cadence, and lifecycle counts
- cron-ready `/api/ingestion/schedule` route plus `npm run ingest:schedule` script for cadence-driven ingestion
- ingestion pipeline with connector interface, normalization, stronger cross-source dedupe, lifecycle sweeps, removal handling, run tracking, and real Greenhouse + Lever + Recruitee + SmartRecruiters connectors
- Prisma/Postgres domain model for canonical jobs, raw jobs, source mappings, eligibility, saved jobs, profile data, and submissions
- seeded demo dataset plus live external ingestion for local development
  - demo-backed canonical jobs stay useful for modeling and local data shape checks, but the main feed hides them when they do not have a trustworthy live source

## Local development

Run the app:

```bash
npm run dev
```

`npm run dev` uses webpack mode with a 2 GB heap cap. That is the safest default for this repo on a memory-constrained laptop.

If dev ever looks stuck compiling after a bad edit or stale `.next` state, stop the current dev server and use:

```bash
npm run dev:fresh
```

If you explicitly want Turbopack for comparison, use:

```bash
npm run dev:turbo
```

If you need the old uncapped behavior, use:

```bash
npm run dev:uncapped
```

Validate the repo state:

```bash
npm run lint
npm run typecheck
npm run build
```

Seed the local database:

```bash
npx prisma db seed
```

Ingest from a public Greenhouse board:

```bash
npm run ingest -- greenhouse --board=vercel
```

Ingest from a public Lever site:

```bash
npm run ingest -- lever --site=plaid
```

Ingest from public Recruitee company careers endpoints:

```bash
npm run ingest -- recruitee --companies=deephealth,huaweicanada
```

Ingest from a public SmartRecruiters company:

```bash
npm run ingest -- smartrecruiters --company=visa --limit=40
```

Ingest from a public Workday board using a `host|tenant|site` source token:

```bash
npm run ingest -- workday '--source=paypal.wd1.myworkdayjobs.com|paypal|jobs'
```

Preview an ingest batch without writing canonical jobs, raw jobs, or source mappings:

```bash
npm run ingest -- ashby --orgs=alchemy,suno --limit=30 --dry-run
npm run ingest -- recruitee --companies=deephealth,huaweicanada --dry-run
npm run ingest -- rippling --boards=tixr,n3xt-jobs --dry-run
npm run ingest -- workable --account=fairmoney --limit=10 --dry-run
npm run ingest -- workday '--source=guidewire.wd5.myworkdayjobs.com|guidewire|external' --limit=20 --dry-run
```

Discover and validate Rippling board slugs from candidate slugs or Rippling-hosted job URLs:

```bash
npm run rippling:discover -- --slugs=tixr,n3xt-jobs,exacare-inc
npm run rippling:discover -- --urls=https://ats.rippling.com/scratch-financial/jobs/1a4c8667-db66-4b73-9936-28ed66c3a100
npm run rippling:discover -- --urls=https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fats.rippling.com%2Ffree-market-health%2Fjobs%2F...
```

Persist Rippling discovery state, keep rejected/promoted boards out of the default retest loop, and surface pending high-yield boards for manual promotion:

```bash
npm run rippling:discover -- --threshold=5 --slugs=patientnow,swimlane,tort-experts
npm run rippling:discover -- --promote=patientnow --slugs=patientnow
npm run rippling:discover -- --source-pages=https://example.com/careers,https://example.com/jobs
npm run rippling:discover -- --dataset=/tmp/linkedin-export.json --no-search
npm run rippling:intake -- --dataset=/tmp/linkedin-export.json
npm run rippling:intake -- --dataset=/path/to/corpus-directory
```

Discover ATS sources generically from the live DB, known company pages, or pasted URLs, then persist promoted / rejected / pending source candidates in a reusable registry:

```bash
npm run source:discover
npm run source:discover -- --urls=https://jobs.lever.co/example/123,https://apply.workable.com/example/j/ABC/
npm run source:discover -- --source-pages=https://example.com/careers,https://example.com/jobs
npm run source:discover -- --urls=https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs
npm run source:discover -- --promote=recruitee:greatminds,greenhouse:contentful
```

Promoted entries in `data/discovery/source-candidates.json` are merged into scheduled ingestion automatically, so strong newly discovered boards do not require another hard-coded coverage edit before the next scheduled run.

Generate a reusable seed corpus of candidate ATS URLs, including constrained Workday endpoint guesses for curated tech / finance companies:

```bash
npx tsx scripts/generate-seed.ts --families=workday --out=data/discovery/seeds/workday-candidates.json
npx tsx scripts/discover-sources.ts --dataset=data/discovery/seeds/workday-candidates.json --limit=5
```

Run the default curated Recruitee expansion batch and print a before/after impact report:

```bash
npm run ingest:expand
```

Preview an expansion batch without consuming the net-new canonical yield during evaluation:

```bash
npm run ingest:expand -- --profile=recruitee_growth_batch --dry-run
```

Run a specific expansion profile:

```bash
npm run ingest:expand -- --profile=greenhouse_trusted_batch
npm run ingest:expand -- --profile=greenhouse_growth_batch
npm run ingest:expand -- --profile=rippling_growth_batch
npm run ingest:expand -- --profile=recruitee_growth_batch
npm run ingest:expand -- --profile=ashby_growth_batch
npm run ingest:expand -- --profile=ashby_yield_batch
npm run ingest:expand -- --profile=ashby_marginal_yield_batch
npm run ingest:expand -- --profile=ashby_next_yield_batch
npm run ingest:expand -- --profile=ashby_strict_yield_batch
```

Run the scheduled ingestion batch locally:

```bash
npm run ingest:schedule -- --force
```

## Product direction

- Feed first, apply flow second
- Total live job pool plus stricter auto-apply eligible pool
- Clear classification per job: auto-apply eligible, review required, manual only
- Deduplication, freshness, expiration tracking, and quality guardrails are foundational
- This is not a blind spam-style mass apply bot

## Main project paths

- `src/app/jobs` for the main feed
- `src/app/saved` for shortlist review
- `src/app/applications` for package and submission history
- `src/app/profile` for profile and resume overview
- `src/app/ops/ingestion` for internal ingestion visibility
- `src/app/api` for route handlers
- `src/lib/queries` for Prisma-backed data access
- `src/lib/ingestion` for connector fetch, normalization, dedupe, lifecycle, eligibility, and scheduling helpers
- `scripts/ingest.ts` for manual ingestion runs
- `scripts/ingest-scheduled.ts` for local scheduled-batch execution
- `prisma/` for schema, migrations, and seed data

Use the actual repository state as the source of truth over older notes or assistant summaries.
