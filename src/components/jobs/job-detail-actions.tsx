"use client";

import { JobCardActions } from "@/components/jobs/job-card-actions";

type JobDetailActionsProps = {
  jobId: string;
  initialSaved: boolean;
};

export function JobDetailActions({ jobId, initialSaved }: JobDetailActionsProps) {
  return <JobCardActions initialSaved={initialSaved} jobId={jobId} />;
}
