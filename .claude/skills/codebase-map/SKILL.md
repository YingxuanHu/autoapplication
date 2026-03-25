---
name: codebase-map
description: Use when orienting within the repo, locating core subsystems, or avoiding repeated repo exploration.
---

# Codebase map

**Status: Pre-implementation.** No application code exists yet. Update this file as code is added.

## Planned subsystems

| Subsystem | Responsibility |
|---|---|
| frontend | Feed UI, saved jobs, apply flow, profile/settings |
| ingestion | Pull jobs from external sources, schedule refreshes |
| normalization | Standardize raw data (location, salary, work mode, dates) |
| deduplication | Cluster duplicates, produce canonical records |
| ranking | Compute feed order from filters + fit + freshness + behavior |
| automation | Classify submission category, enforce eligibility and guardrails |
| packaging | Select resume, cover letter, saved answers, links per role |
| tracking | Log submissions, resume history, application status |

## Core domain objects

UserProfile, ResumeVariant, JobRaw, JobCanonical, JobSourceMapping, JobEligibility, ApplicationPackage, ApplicationSubmission, SavedJob, UserPreference, UserBehaviorSignal

## How to use this file

Point Claude to where logic belongs and which files are entry points. Keep it as a navigation index — not a design doc. Update paths here as code lands.