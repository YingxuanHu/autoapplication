"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApplicationHistoryStatus } from "@/types";

type ApplicationRowActionsProps = {
  jobId: string;
  latestStatus: ApplicationHistoryStatus;
};

export function ApplicationRowActions({
  jobId,
  latestStatus,
}: ApplicationRowActionsProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function patch(intent: "confirm" | "fail" | "withdraw") {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/apply`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent }),
        });
        if (!res.ok) throw new Error(await res.text());
        router.refresh();
      } catch (e) {
        console.error(e);
        setError("Could not update status.");
      }
    });
  }

  const spinner = isPending ? (
    <LoaderCircle className="h-3 w-3 animate-spin" />
  ) : null;

  if (latestStatus === "SUBMITTED") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => patch("confirm")}
            disabled={isPending}
            className="h-8 px-3 text-xs"
          >
            {spinner}
            Confirm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => patch("fail")}
            disabled={isPending}
            className="h-8 px-3 text-xs"
          >
            {spinner}
            Failed
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => patch("withdraw")}
            disabled={isPending}
            className="h-8 px-3 text-xs text-muted-foreground"
          >
            {spinner}
            Withdraw
          </Button>
        </div>
        {error ? (
          <p aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (latestStatus === "CONFIRMED") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => patch("fail")}
            disabled={isPending}
            className="h-8 px-3 text-xs text-muted-foreground"
          >
            {spinner}
            Mark failed
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => patch("withdraw")}
            disabled={isPending}
            className="h-8 px-3 text-xs text-muted-foreground"
          >
            {spinner}
            Withdraw
          </Button>
        </div>
        {error ? (
          <p aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return null;
}
