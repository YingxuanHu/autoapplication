---
name: auto-apply-rules
description: Use when defining automation eligibility, submission categories, customization thresholds, or quality guardrails.
---

# Auto-apply rules

## Goal

Automation should save time without reducing quality.
A job should only be fully auto-applied if the system has high confidence that the application can be submitted correctly and appropriately.

## Submission categories

### 1. Auto submit ready
Use when:
- job is live
- job is deduplicated
- application flow is structured and stable
- required fields are known
- customization burden is minimal
- best resume/package can be selected confidently
- no heavy custom writing is required
- user rules are fully satisfied

### 2. Auto fill + review
Use when:
- most of the form can be completed reliably
- package fit is reasonably strong
- there may be light customization
- there may be minor uncertainty
- user approval should be required before final submission

### 3. Manual only
Use when:
- flow is unsupported or unstable
- custom writing burden is high
- application requires unusual steps
- package confidence is too low
- quality risk is too high

## Required conditions for auto-apply eligibility

A job is auto-apply eligible only if all of the following are true:
- live and not expired
- canonical and deduplicated
- matches user hard filters
- structurally automatable
- low customization burden
- high package fit confidence
- high submission quality confidence

## Confidence dimensions

### Job validity confidence
How sure we are that the posting is real, current, and not expired.

### Form automation confidence
How sure we are that the submission path can be handled reliably.

### Package fit confidence
How sure we are that the system can select the correct resume and supporting materials.

### Submission quality confidence
How sure we are that automation will not lower quality.

## Customization levels

### Level 1: Minimal customization
Allowed for full auto-apply.
Examples:
- choose best resume
- include optional standard cover letter template
- attach portfolio / GitHub / LinkedIn
- use saved work authorization answer
- use saved salary preference
- fill structured fields

### Level 2: Light customization
Allowed in review-before-submit mode.
Examples:
- choose between two resume variants
- choose between two cover letter variants
- edit a short structured summary
- answer simple short text prompts with reusable templates

### Level 3: Heavy customization
Not allowed for full auto-apply.
Usually manual only or assisted mode.
Examples:
- long written answers
- job-specific custom cover letters
- behavioral essays
- open-ended original writing
- project writeups
- case studies
- video answers

## Hard automation limit

A job can remain fully auto-apply eligible only if it requires:
- one resume selection
- optional standard attachment choices
- structured field filling
- at most one short reusable text response under a strict limit

Anything beyond that should be downgraded to:
- auto fill + review
or
- manual only

## Downgrade triggers

Downgrade a job from auto-apply eligible if:
- expired or stale
- weak resume fit
- unknown required field
- unstable application flow
- custom writing burden too high
- user restrictions conflict
- low quality confidence
- missing required package content

## Automation modes

| Mode | Behavior |
|---|---|
| Discovery only | Find and rank jobs; user handles everything else |
| Assist | Prepare materials; user submits manually |
| Review before submit | Prefill application; user approves before send |
| Strict auto apply | Submit automatically for auto-apply eligible jobs only |

## Transparency rules

Every job should include:
- submission category
- reason code
- why it can or cannot be auto-applied

Example reason codes:
- structured ATS flow detected
- custom written response required
- unsupported portal flow
- missing package confidence
- review required due to light customization