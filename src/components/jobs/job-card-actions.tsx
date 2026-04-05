"use client";

import { useState } from "react";
import { Ban, BookmarkCheck, BookmarkPlus, LoaderCircle, Trash2 } from "lucide-react";
import { AddToApplicationMenu } from "@/components/jobs/add-to-application-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type JobCardActionsProps = {
  jobId: string;
  initialSaved: boolean;
  mode?: "feed" | "saved";
  align?: "start" | "end";
  onSavedChange?: (saved: boolean) => void;
  onPassed?: () => void;
};

export function JobCardActions({
  jobId,
  initialSaved,
  mode = "feed",
  align = "start",
  onSavedChange,
  onPassed,
}: JobCardActionsProps) {
  const [isSaved, setIsSaved] = useState(initialSaved);
  const [error, setError] = useState<string | null>(null);
  const [inflightAction, setInflightAction] = useState<"save" | "pass" | null>(null);

  function handleSaveClick() {
    if (inflightAction === "save") return;

    const nextSaved = mode === "saved" ? false : !isSaved;
    const previousSaved = isSaved;

    // Optimistic: flip immediately
    setError(null);
    setIsSaved(nextSaved);
    onSavedChange?.(nextSaved);

    setInflightAction("save");
    fetch(`/api/jobs/${jobId}/save`, {
      method: nextSaved ? "POST" : "DELETE",
    })
      .then((response) => {
        if (!response.ok) throw new Error("save failed");
      })
      .catch((actionError) => {
        console.error(actionError);
        // Rollback
        setIsSaved(previousSaved);
        onSavedChange?.(previousSaved);
        setError(
          nextSaved ? "Could not save this job right now." : "Could not update the shortlist."
        );
      })
      .finally(() => {
        setInflightAction(null);
      });
  }

  function handlePassClick() {
    if (inflightAction === "pass") return;

    setError(null);

    // Optimistic: dismiss immediately
    if (isSaved) {
      setIsSaved(false);
      onSavedChange?.(false);
    }
    onPassed?.();

    setInflightAction("pass");
    fetch(`/api/jobs/${jobId}/pass`, { method: "POST" })
      .then((response) => {
        if (!response.ok) throw new Error("pass failed");
      })
      .catch((actionError) => {
        console.error(actionError);
        // Pass rollback is handled by the parent list component
        // via the onPassFailed callback pattern — but since pass is
        // a soft signal (not destructive), we log and move on.
        // The job is already visually dismissed; showing it again
        // after a fade-out would be more jarring than losing a pass signal.
      })
      .finally(() => {
        setInflightAction(null);
      });
  }

  if (mode === "saved") {
    return (
      <div
        className={cn(
          "flex flex-col gap-2",
          align === "end" ? "items-end" : "items-start"
        )}
      >
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={handleSaveClick}
          disabled={inflightAction === "save"}
        >
          {inflightAction === "save" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Remove
        </Button>
        {error ? (
          <p aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // Feed mode: icon-only compact buttons — no spinners, instant feedback via icon change
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        align === "end" ? "items-end" : "items-start"
      )}
    >
      <div className="flex items-center gap-1.5">
        <AddToApplicationMenu jobId={jobId} align={align} />
        <Button
          type="button"
          variant={isSaved ? "secondary" : "ghost"}
          size="sm"
          onClick={handleSaveClick}
          title={isSaved ? "Remove from saved" : "Save job"}
          aria-label={isSaved ? "Remove from saved" : "Save job"}
          disabled={inflightAction === "save"}
        >
          {isSaved ? (
            <BookmarkCheck className="h-3.5 w-3.5" />
          ) : (
            <BookmarkPlus className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handlePassClick}
          title="Pass on this job"
          aria-label="Pass on this job"
          disabled={inflightAction === "pass"}
        >
          {inflightAction === "pass" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Ban className="h-3.5 w-3.5" />
          )}
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
