---
name: ranking-and-feed
description: Use when discussing feed UX, job ranking, user actions, recommendation logic, or learned preferences.
---

# Ranking and feed

## Goal

Turn a large job pool into a fast decision experience.

The feed should help users move quickly through relevant jobs without overwhelming them.

## Default actions
- Apply
- Pass
- Save
- Details

## Feed design

Each card should be compact and show only essential information:
- company
- role title
- location
- work mode
- salary if available
- posting age
- source
- short summary
- why it matches
- automation category

## Ranking factors

Rank jobs using a combination of:
- hard filter match
- resume fit
- role family match
- location match
- work mode match
- salary preference match
- freshness
- source trust
- automation feasibility
- prior user behavior

## Hard filters vs soft signals

### Hard filters
Must be respected strictly.
Examples:
- geography
- work mode restrictions
- salary minimum if user set it as strict
- industry inclusion/exclusion
- work authorization limitations

### Soft signals
Can improve ranking but should not override hard rules.
Examples:
- preferred company type
- startup vs large company preference
- roles user tends to save
- roles user tends to apply to
- roles user tends to pass on

## Learning from user behavior

Use behavior to improve ranking, not to silently change explicit rules.

Useful signals:
- repeated saves
- repeated applies
- repeated passes
- time spent on job categories
- selected resume variants
- selected industries or companies

## Why this matches

Every job should explain why it is shown.

Examples:
- matches your software engineering target
- strong overlap with Python, SQL, and analytics
- remote preference match
- salary within target range
- auto-apply eligible

## Why this cannot be auto-applied

Also show when relevant:
- custom question detected
- unsupported application flow
- review required due to light customization
- manual only due to external portal complexity

## Feed quality rules

Do not push jobs high in the feed if:
- they are stale
- they are weak fit
- they are likely duplicates
- they conflict with user restrictions
- they have low application quality confidence

## Saved jobs

Saved jobs should go into a shortlist workspace for later review and batch actions.

## Batch actions

Useful batch actions:
- apply to top review-ready jobs
- save selected jobs
- pass selected low-fit jobs
- apply using a chosen resume variant to a filtered group

Batch actions must still respect automation and quality guardrails.