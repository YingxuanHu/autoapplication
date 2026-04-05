"use client";

import { useState } from "react";
import { Ban, BookmarkCheck, BookmarkPlus, LoaderCircle } from "lucide-react";
import { AddToApplicationMenu } from "@/components/jobs/add-to-application-menu";
import { Button } from "@/components/ui/button";
import { useNotifications } from "@/components/ui/notification-provider";
import { cn } from "@/lib/utils";

type JobCardActionsProps = {
  jobId: string;
  initialSaved: boolean;
  align?: "start" | "end";
  onSavedChange?: (saved: boolean) => void;
  onPassed?: () => void;
};

export function JobCardActions({
  jobId,
  initialSaved,
  align = "start",
  onSavedChange,
  onPassed,
}: JobCardActionsProps) {
  const { notify } = useNotifications();
  const [isSaved, setIsSaved] = useState(initialSaved);
  const [error, setError] = useState<string | null>(null);
  const [inflightAction, setInflightAction] = useState<"save" | "pass" | null>(null);

  function handleSaveClick() {
    if (inflightAction === "save") return;

    const nextSaved = !isSaved;
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
        notify({
          title: nextSaved ? "Added to wishlist" : "Removed from wishlist",
          message: nextSaved
            ? "This job is now in your applications wishlist."
            : "This job was removed from your wishlist.",
          tone: "success",
        });
      })
      .catch((actionError) => {
        console.error(actionError);
        // Rollback
        setIsSaved(previousSaved);
        onSavedChange?.(previousSaved);
        setError(
          nextSaved
            ? "Could not add this job to your wishlist right now."
            : "Could not update your wishlist."
        );
        notify({
          title: "Could not update wishlist",
          message: nextSaved
            ? "Could not add this job to your wishlist right now."
            : "Could not update your wishlist.",
          tone: "error",
        });
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
        notify({
          title: "Job dismissed",
          message: "This job was removed from your feed.",
          tone: "success",
        });
      })
      .catch((actionError) => {
        console.error(actionError);
        // Pass rollback is handled by the parent list component
        // via the onPassFailed callback pattern — but since pass is
        // a soft signal (not destructive), we log and move on.
        // The job is already visually dismissed; showing it again
        // after a fade-out would be more jarring than losing a pass signal.
        notify({
          title: "Could not dismiss job",
          message: "Your pass signal could not be saved right now.",
          tone: "error",
        });
      })
      .finally(() => {
        setInflightAction(null);
      });
  }

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
          title={isSaved ? "Remove from wishlist" : "Add to wishlist"}
          aria-label={isSaved ? "Remove from wishlist" : "Add to wishlist"}
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
