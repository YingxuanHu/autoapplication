# Project: Job Search and Application Engine

## Purpose
This project is a North America-focused job search and application engine.
It helps users find, review, and apply to jobs at scale while keeping control and maintaining application quality.

## Primary goals
- Maximize relevant job volume
- Save users time
- Avoid blind low-quality mass applying

## Initial market focus
- North America only
- Tech and finance first

## Core product model
The product has two major layers:
1. Total job pool
2. Auto-apply eligible pool

All live, relevant, deduplicated jobs can exist in the total pool.
Only jobs that pass automation and quality thresholds can exist in the auto-apply eligible pool.

## Main user experience
- Feed first
- Apply flow second

Users should be able to quickly:
- Apply
- Pass
- Save
- View details

## Core non-negotiables
- Large multi-source job ingestion
- Fresh jobs, refreshed continuously
- Strong deduplication
- Expiration and deadline tracking
- Clear distinction between auto-apply eligible, review required, and manual only
- No blind spam behavior
- Quality guardrails must override automation

## Supported submission categories
- Auto submit ready
- Auto fill + review
- Manual only

## Product principles
- Speed with control
- Volume with relevance
- Automation with guardrails
- Transparency in why jobs are shown and why they can or cannot be automated

## Skills (on-demand detail)

Use these skills for deeper context instead of asking the user to repeat product details:
- `/product-overview` — vision, workflows, UX, what the app does
- `/auto-apply-rules` — eligibility, submission categories, customization limits, guardrails, automation modes
- `/job-ingestion` — sources, refresh logic, freshness, dedup, scale targets
- `/ranking-and-feed` — feed UX, ranking factors, hard vs soft filters, learned preferences
- `/codebase-map` — subsystem locations, domain objects, file navigation

## Compact instructions
When compacting, preserve:
- product decisions
- auto-apply eligibility rules
- customization limits
- ranking logic
- schema and API decisions
- current implementation status

Do not preserve:
- repeated brainstorming
- long examples unless they became final specs
- rejected alternatives unless later revived