"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-24 text-center">
      <h2 className="text-lg font-semibold text-foreground">
        Something went wrong
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        An unexpected error occurred. This has been logged automatically.
      </p>
      {error.digest ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground/60">
          Error ID: {error.digest}
        </p>
      ) : null}
      <Button onClick={reset} variant="outline" size="sm" className="mt-6">
        Try again
      </Button>
    </div>
  );
}
