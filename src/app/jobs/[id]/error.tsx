"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function JobDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Job detail error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <h2 className="text-lg font-semibold text-foreground">
        Failed to load job
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        There was a problem loading this job listing.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={reset} variant="outline" size="sm">
          Try again
        </Button>
        <Button variant="ghost" size="sm" render={<Link href="/jobs" />}>
          Back to jobs
        </Button>
      </div>
    </div>
  );
}
