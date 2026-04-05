import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { JobDetailActions } from "@/components/jobs/job-detail-actions";
import { Button } from "@/components/ui/button";
import {
  APPLICATION_REVIEW_STATE_META,
  buildWhyShown,
  formatDeadlineValue,
  formatDisplayLabel,
  formatPostedAge,
  formatSalary,
  getDeadlineUrgency,
  getEligibilityReasonDescription,
  getSourceShortName,
  getSubmissionMeta,
  shouldShowSubmissionMeta,
  submissionCategoryColor,
  trustLevelColor,
} from "@/lib/job-display";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getApplicationReviewData } from "@/lib/queries/applications";

type JobDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function JobDetailPage({ params }: JobDetailPageProps) {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const { id } = await params;
  const detailData = await getApplicationReviewData(id);

  if (!detailData) {
    notFound();
  }

  const { job, latestPackage, recommendedResume, reviewState, submissions } = detailData;
  const latestSubmission = submissions[0] ?? null;
  const submissionMeta = getSubmissionMeta(job);
  const reviewStateMeta = APPLICATION_REVIEW_STATE_META[reviewState];
  const whyShown = buildWhyShown(job);
  const deadlineUrgency = getDeadlineUrgency(job.deadline);
  const deadlineValue = formatDeadlineValue(job.deadline);
  // EXPIRED jobs: show detail but block the apply flow
  const canStartApplyFlow = reviewState !== "NOT_ELIGIBLE" && job.status !== "EXPIRED";
  const applyLabel = reviewState === "MANUAL_ONLY" ? "Apply manually" : "Apply";
  const sourceShortName = getSourceShortName(job.primaryExternalLink?.sourceName ?? null);
  const showSubmissionMeta = shouldShowSubmissionMeta(job);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Breadcrumb */}
      <div className="mb-3">
        <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
          ← Jobs
        </Link>
      </div>

      {/* Header — stacks on mobile, row on sm+ */}
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{job.title}</h1>
            {showSubmissionMeta ? (
              <span
                className={`shrink-0 text-xs font-medium ${submissionCategoryColor(job.eligibility?.submissionCategory)}`}
              >
                {submissionMeta.label}
              </span>
            ) : null}
          </div>

          {/* Meta row: company (with ATS trust cue) · location · workMode · salary */}
          <p className="mt-0.5 text-sm text-muted-foreground">
            {job.company}
            {job.primaryExternalLink ? (
              <a
                href={job.primaryExternalLink.href}
                target="_blank"
                rel="noreferrer"
                title={`${job.primaryExternalLink.label} · ${job.primaryExternalLink.sourceName ?? "external source"}`}
                className="ml-1 inline-flex items-center gap-0.5 align-middle opacity-40 transition-opacity hover:opacity-80"
              >
                {sourceShortName ? (
                  <span className="text-[10px] font-semibold uppercase leading-none tracking-wide">
                    {sourceShortName}
                  </span>
                ) : null}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            <Sep />
            {job.location}
            <Sep />
            {formatDisplayLabel(job.workMode)}
            {formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency) ? (
              <>
                <Sep />
                {formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency)}
              </>
            ) : null}
          </p>
        </div>

        {canStartApplyFlow ? (
          <div className="shrink-0">
            <Button size="sm" render={<Link href={`/jobs/${job.id}/apply`} />}>
              {applyLabel}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Lifecycle notice — only shown for STALE or EXPIRED */}
      {job.status === "STALE" || job.status === "EXPIRED" ? (
        <div className="border-t border-border py-3">
          <p
            className={`text-sm ${
              job.status === "EXPIRED" ? "text-destructive" : "text-amber-600"
            }`}
          >
            {job.status === "EXPIRED"
              ? "This posting has expired — the application window is likely closed."
              : "This posting hasn't been confirmed in a recent crawl and may no longer be active."}
          </p>
        </div>
      ) : null}

      {/* Key fields */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-t border-border py-4 sm:grid-cols-4">
        <Field
          label="Salary"
          value={formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency) || "—"}
        />
        <Field label="Posted" value={formatPostedAge(job.postedAt)} />
        {/* Deadline field — colored when urgent */}
        <div>
          <p className="text-xs text-muted-foreground">Deadline</p>
          <p
            className={`mt-0.5 text-sm font-medium ${
              deadlineUrgency ? deadlineUrgency.color : "text-foreground"
            }`}
          >
            {deadlineValue ?? "None listed"}
          </p>
        </div>
        <Field label="Automation" value={reviewStateMeta.label} />
      </div>

      {/* Save / Pass + submission status */}
      <div className="flex items-center justify-between border-t border-border py-3">
        <JobDetailActions jobId={job.id} initialSaved={job.isSaved} />
        {latestSubmission ? (
          <p className="text-xs text-muted-foreground">
            {formatDisplayLabel(latestSubmission.status)}
            {latestSubmission.submittedAt
              ? ` · submitted ${formatPostedAge(latestSubmission.submittedAt)}`
              : ""}
          </p>
        ) : null}
      </div>

      {/* Why shown — secondary, collapsed by default */}
      <details className="border-t border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm text-muted-foreground hover:text-foreground">
          Why shown
        </summary>
        <div className="pb-4 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {whyShown.map((reason) => (
              <span
                key={reason}
                className="text-xs text-muted-foreground"
              >
                {reason}
              </span>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {getEligibilityReasonDescription(job.eligibility)}
          </p>
        </div>
      </details>

      {/* Resume / package snapshot */}
      {recommendedResume || latestPackage ? (
        <div className="border-t border-border py-4">
          <p className="mb-1.5 text-xs text-muted-foreground">
            {latestPackage ? "Latest package" : "Recommended resume"}
          </p>
          <p className="text-sm font-medium text-foreground">
            {latestPackage ? latestPackage.resumeVariant.label : recommendedResume?.label}
          </p>
          {latestPackage?.whyItMatches ? (
            <p className="mt-1 text-sm text-muted-foreground">{latestPackage.whyItMatches}</p>
          ) : recommendedResume?.targetRoleFamily ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Targeted at {recommendedResume.targetRoleFamily}.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Sources — secondary, collapsed by default */}
      <details className="border-t border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between py-3 text-sm text-muted-foreground hover:text-foreground">
          <span>Sources</span>
          <span className={`text-xs font-medium ${trustLevelColor(job.linkTrust.level)}`}>
            {job.linkTrust.label}
          </span>
        </summary>
        <div className="space-y-3 pb-4">
          {job.sourceMappings.map((sm) => (
            <div
              key={`${sm.sourceName}-${sm.sourceUrl ?? "local"}`}
              className="flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  {sm.sourceName}
                  {sm.isPrimary ? (
                    <span className="ml-2 text-xs text-muted-foreground">primary</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {sm.sourceUrl ?? "No URL captured"}
                </p>
              </div>
              <span className={`shrink-0 text-xs font-medium ${trustLevelColor(sm.trust.level)}`}>
                {sm.trust.label}
              </span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{job.linkTrust.summary}</p>
        </div>
      </details>

      {/* Full description */}
      <div className="border-t border-border py-4">
        <p className="mb-3 text-xs text-muted-foreground">Description</p>
        <div className="space-y-2.5 text-sm text-foreground/80">
          {parseDescriptionBlocks(job.description).map((block, i) => {
            if (block.kind === "header") {
              return (
                <p
                  key={i}
                  className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:pt-0"
                >
                  {block.text}
                </p>
              );
            }
            if (block.kind === "list") {
              return (
                <ul key={i} className="ml-4 space-y-1 list-disc marker:text-muted-foreground/50">
                  {block.items.map((item, j) => (
                    <li key={j} className="leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={i} className="leading-relaxed">
                {block.text}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function Sep() {
  return <span className="mx-1.5 text-border">·</span>;
}

// ─── Description parsing ──────────────────────────────────────────────────────

type DescriptionBlock =
  | { kind: "header"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

/**
 * Parse a job description into typed blocks for structured rendering.
 *
 * Handles two input formats:
 *   1. Structured text (post-fix sanitizer): newlines preserved, ALL-CAPS
 *      section headers on their own lines, bullet markers on their own lines.
 *   2. Legacy flat text: everything on one line; we inject breaks before
 *      ALL-CAPS sequences to recover rough structure.
 */
function parseDescriptionBlocks(raw: string): DescriptionBlock[] {
  if (!raw.trim()) return [];

  // Pre-clean: strip repeated boilerplate / duplicate headers
  const cleaned = raw
    // Remove common junk: "Apply now!", "Click here to apply", etc.
    .replace(/\b(click here to apply|apply now!?|submit your application today)\b[.!]*/gi, "")
    // Remove excessive separator lines (=== --- ***)
    .replace(/^[=\-*_]{3,}\s*$/gm, "")
    // Normalize fancy quotes
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  // Detect whether the text has meaningful newlines
  const hasStructure = /\n/.test(cleaned) && cleaned.split(/\n/).filter(Boolean).length > 2;

  const normalized = hasStructure
    ? cleaned
    : // Inject line breaks before ALL-CAPS section headers in flat text.
      cleaned
        .replace(
          /(?<![A-Z])\s+(?=[A-Z][A-Z\s&'/()-]{4,}(?:\s|$|:))/g,
          "\n\n"
        )
        // Inject breaks before bullet-like items in flat text
        .replace(/\s+-\s+/g, "\n- ")
        // Inject breaks before numbered items in flat text (e.g. "1. ", "2. ")
        .replace(/\s+(\d{1,2}\.\s+)/g, "\n$1");

  const lines = normalized.split(/\n/).map((l) => l.trim()).filter(Boolean);

  // All-caps: "ABOUT THE ROLE", "KEY RESPONSIBILITIES"
  // Colon-terminated short line: "You Will:", "About the Role:", "Ideally You'd Have:"
  // Markdown heading: "## Section"
  const ALL_CAPS_HEADER = /^[A-Z][A-Z\s&'/():-]{3,}$|^#{1,3}\s+\S/;
  const TITLE_HEADER = /^[A-Z][^.!?]{0,55}:$/;
  const BOLD_HEADER = /^\*\*([^*]+)\*\*:?$/; // **Section Title** or **Section Title:**
  const BULLET = /^[-•*–·]\s+(.+)$/;
  const NUMBERED_ITEM = /^\d{1,2}\.\s+(.+)$/;

  const blocks: DescriptionBlock[] = [];
  let pendingBullets: string[] = [];
  let prevBlockWasHeader = false;

  const flushBullets = () => {
    if (pendingBullets.length > 0) {
      blocks.push({ kind: "list", items: [...pendingBullets] });
      pendingBullets = [];
    }
  };

  for (const line of lines) {
    const bulletMatch = line.match(BULLET);
    const numberedMatch = !bulletMatch ? line.match(NUMBERED_ITEM) : null;
    const boldMatch = !bulletMatch && !numberedMatch ? line.match(BOLD_HEADER) : null;

    const isHeader =
      (!bulletMatch && !numberedMatch && ALL_CAPS_HEADER.test(line) && !/[a-z]/.test(line)) ||
      (!bulletMatch && !numberedMatch && TITLE_HEADER.test(line)) ||
      Boolean(boldMatch);

    // Skip duplicate consecutive headers
    if (isHeader && prevBlockWasHeader && blocks.length > 0) {
      const prevHeader = blocks[blocks.length - 1];
      if (prevHeader.kind === "header" && prevHeader.text.toLowerCase() === (boldMatch?.[1] ?? line.replace(/:$/, "")).trim().toLowerCase()) {
        continue;
      }
    }

    if (isHeader) {
      flushBullets();
      const headerText = boldMatch
        ? boldMatch[1].trim()
        : line.replace(/:$/, "").replace(/^#+\s*/, "").trim();
      blocks.push({ kind: "header", text: headerText });
      prevBlockWasHeader = true;
    } else if (bulletMatch) {
      pendingBullets.push(bulletMatch[1].trim());
      prevBlockWasHeader = false;
    } else if (numberedMatch) {
      pendingBullets.push(numberedMatch[1].trim());
      prevBlockWasHeader = false;
    } else {
      flushBullets();
      blocks.push({ kind: "paragraph", text: line });
      prevBlockWasHeader = false;
    }
  }

  flushBullets();
  return blocks;
}
