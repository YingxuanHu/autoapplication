"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { JobCardActions } from "@/components/jobs/job-card-actions";
import { JobSummaryCard } from "@/components/jobs/job-summary-card";
import type { JobCardData } from "@/types";

export function JobsFeedList({ initialJobs }: { initialJobs: JobCardData[] }) {
  const [jobs, setJobs] = useState(initialJobs);
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());
  const [passedCount, setPassedCount] = useState(0);
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Clean up all pending timers on unmount
  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const handlePass = useCallback((jobId: string) => {
    // Start fade-out animation
    setDismissingIds((prev) => new Set(prev).add(jobId));

    // Remove from list after animation completes
    const timer = setTimeout(() => {
      dismissTimers.current.delete(jobId);
      setJobs((current) => current.filter((j) => j.id !== jobId));
      setDismissingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      setPassedCount((c) => c + 1);
    }, 200);
    dismissTimers.current.set(jobId, timer);
  }, []);

  const handleSavedChange = useCallback((jobId: string, saved: boolean) => {
    setJobs((current) =>
      current.map((j) => (j.id === jobId ? { ...j, isSaved: saved } : j))
    );
  }, []);

  if (jobs.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          {passedCount > 0
            ? `Passed ${passedCount} job${passedCount === 1 ? "" : "s"} from this page`
            : "No more jobs on this page"}
        </p>
        <Link
          href="/saved"
          className="mt-2 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Review saved jobs
        </Link>
      </div>
    );
  }

  return (
    <div>
      {jobs.map((job) => (
        <div
          key={job.id}
          className={
            dismissingIds.has(job.id)
              ? "opacity-0 transition-opacity duration-200"
              : "opacity-100 transition-opacity duration-150"
          }
        >
          <JobSummaryCard
            job={job}
            footerActions={
              <JobCardActions
                jobId={job.id}
                initialSaved={job.isSaved}
                align="start"
                onSavedChange={(saved) => handleSavedChange(job.id, saved)}
                onPassed={() => handlePass(job.id)}
              />
            }
          />
        </div>
      ))}
    </div>
  );
}
