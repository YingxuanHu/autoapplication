"use client";

import Link from "next/link";
import { useState } from "react";
import { JobCardActions } from "@/components/jobs/job-card-actions";
import { JobSummaryCard } from "@/components/jobs/job-summary-card";
import { Button } from "@/components/ui/button";
import { formatDisplayLabel, formatRelativeAge } from "@/lib/job-display";
import type { SavedJobListItem } from "@/types";

export function SavedJobsList({
  initialSavedJobs,
  statusFilter,
  emptyHref = "/jobs",
}: {
  initialSavedJobs: SavedJobListItem[];
  statusFilter: SavedJobListItem["status"];
  emptyHref?: string;
}) {
  const [savedJobs, setSavedJobs] = useState(initialSavedJobs);
  const emptyState = getEmptyState(statusFilter, emptyHref);

  if (savedJobs.length === 0) {
    return (
      <div className="border border-dashed border-border rounded-md px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {emptyState.title}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {emptyState.description}
        </p>
        <div className="mt-3">
          <Link
            href={emptyHref}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {emptyState.ctaLabel}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      {savedJobs.map((savedJob) => (
        <JobSummaryCard
          key={savedJob.id}
          job={savedJob.canonicalJob}
          primaryAction={
            <Button
              size="sm"
              variant={getPrimaryActionVariant(savedJob)}
              render={<Link href={getPrimaryActionHref(savedJob)} />}
            >
              {getPrimaryActionLabel(savedJob)}
            </Button>
          }
          footerActions={
            <div className="flex flex-col items-end gap-1.5">
              <p className="text-xs text-muted-foreground">
                {getSavedStatusNote(savedJob)}
              </p>
              <div className="flex items-center gap-2">
                {getSecondaryLinkHref(savedJob) ? (
                  <Link
                    href={getSecondaryLinkHref(savedJob)!}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {getSecondaryLinkLabel(savedJob)}
                  </Link>
                ) : null}
                <JobCardActions
                  jobId={savedJob.canonicalJob.id}
                  initialSaved
                  mode="saved"
                  align="start"
                  onSavedChange={(saved) => {
                    if (!saved) {
                      setSavedJobs((current) =>
                        current.filter((j) => j.id !== savedJob.id)
                      );
                    }
                  }}
                />
              </div>
            </div>
          }
        />
      ))}
    </div>
  );
}

function canOpenApplyReview(savedJob: SavedJobListItem) {
  return (
    savedJob.canonicalJob.status === "LIVE" &&
    savedJob.canonicalJob.eligibility !== null
  );
}

function getPrimaryActionHref(savedJob: SavedJobListItem) {
  if (savedJob.status === "APPLIED") {
    return `/jobs/${savedJob.canonicalJob.id}/apply`;
  }

  return canOpenApplyReview(savedJob)
    ? `/jobs/${savedJob.canonicalJob.id}/apply`
    : `/jobs/${savedJob.canonicalJob.id}`;
}

function getPrimaryActionLabel(savedJob: SavedJobListItem) {
  if (savedJob.status === "APPLIED") return "Review";

  if (!canOpenApplyReview(savedJob)) {
    return "Details";
  }

  return savedJob.canonicalJob.eligibility?.submissionCategory === "MANUAL_ONLY"
    ? "Apply manually"
    : "Review";
}

function getPrimaryActionVariant(savedJob: SavedJobListItem) {
  return savedJob.status === "APPLIED" ? "secondary" : "default";
}

function getSecondaryLinkHref(savedJob: SavedJobListItem) {
  if (savedJob.status === "APPLIED") return "/applications";
  if (canOpenApplyReview(savedJob)) return `/jobs/${savedJob.canonicalJob.id}`;
  return null;
}

function getSecondaryLinkLabel(savedJob: SavedJobListItem) {
  return savedJob.status === "APPLIED" ? "Applications" : "Details";
}

function getSavedStatusNote(savedJob: SavedJobListItem) {
  const savedAge = formatRelativeAge(savedJob.createdAt);

  switch (savedJob.status) {
    case "ACTIVE":
      return `Active shortlist · saved ${savedAge}`;
    case "APPLIED":
      return `Tracked in applications · saved ${savedAge}`;
    case "EXPIRED":
      return `Posting expired · saved ${savedAge}`;
    case "DISMISSED":
      return `Removed from active shortlist · saved ${savedAge}`;
    default:
      return `${formatDisplayLabel(savedJob.status)} · saved ${savedAge}`;
  }
}

function getEmptyState(statusFilter: SavedJobListItem["status"], emptyHref: string) {
  switch (statusFilter) {
    case "APPLIED":
      return {
        title: "No applied jobs in this view",
        description:
          "Jobs move here after you submit or prepare them in the apply review flow.",
        ctaLabel: "Back to active shortlist",
        href: emptyHref,
      };
    case "EXPIRED":
      return {
        title: "No expired saved jobs",
        description:
          "Expired postings will stay visible here once their application window closes.",
        ctaLabel: "Back to active shortlist",
        href: emptyHref,
      };
    case "DISMISSED":
      return {
        title: "No dismissed jobs",
        description:
          "Passed or cleared shortlist items will appear here when you want to audit them later.",
        ctaLabel: "Back to active shortlist",
        href: emptyHref,
      };
    default:
      return {
        title: "No jobs in this shortlist view",
        description:
          "Save promising jobs from the feed, then come back here to batch-review them.",
        ctaLabel: "Back to feed",
        href: emptyHref,
      };
  }
}
