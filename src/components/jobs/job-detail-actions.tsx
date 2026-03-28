"use client";

import { useRouter } from "next/navigation";
import { JobCardActions } from "@/components/jobs/job-card-actions";

type JobDetailActionsProps = {
  jobId: string;
  initialSaved: boolean;
};

export function JobDetailActions({ jobId, initialSaved }: JobDetailActionsProps) {
  const router = useRouter();

  return (
    <JobCardActions
      jobId={jobId}
      initialSaved={initialSaved}
      onPassed={() => {
        router.push("/jobs");
        router.refresh();
      }}
    />
  );
}
