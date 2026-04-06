"use client";

import { useState } from "react";
import { BookmarkCheck, BookmarkPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNotifications } from "@/components/ui/notification-provider";
import { cn } from "@/lib/utils";

type JobCardActionsProps = {
  jobId: string;
  initialSaved: boolean;
  align?: "start" | "end";
  onSavedChange?: (saved: boolean) => void;
};

export function JobCardActions({
  jobId,
  initialSaved,
  align = "start",
  onSavedChange,
}: JobCardActionsProps) {
  const { notify } = useNotifications();
  const [isSaved, setIsSaved] = useState(initialSaved);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function handleSaveClick() {
    if (isSaving) return;

    const nextSaved = !isSaved;
    const previousSaved = isSaved;

    setError(null);
    setIsSaved(nextSaved);
    onSavedChange?.(nextSaved);

    setIsSaving(true);
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
        setIsSaving(false);
      });
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        align === "end" ? "items-end" : "items-start"
      )}
    >
      <Button
        aria-label={isSaved ? "Remove from wishlist" : "Add to wishlist"}
        className="gap-1.5"
        disabled={isSaving}
        onClick={handleSaveClick}
        size="sm"
        title={isSaved ? "Remove from wishlist" : "Add to wishlist"}
        type="button"
        variant={isSaved ? "secondary" : "ghost"}
      >
        {isSaved ? (
          <BookmarkCheck className="h-3.5 w-3.5" />
        ) : (
          <BookmarkPlus className="h-3.5 w-3.5" />
        )}
        <span>{isSaved ? "In wishlist" : "Add to wishlist"}</span>
      </Button>
      {error ? (
        <p aria-live="polite" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
