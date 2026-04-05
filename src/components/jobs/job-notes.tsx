"use client";

import { useState, useRef, useCallback } from "react";
import { LoaderCircle, Check } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  jobId: string;
  initialNotes: string | null;
};

export function JobNotes({ jobId, initialNotes }: Props) {
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    async (value: string) => {
      setStatus("saving");
      try {
        const res = await fetch(`/api/jobs/${jobId}/notes`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: value }),
        });
        if (!res.ok) throw new Error("Save failed");
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 2000);
      } catch {
        setStatus("error");
        setTimeout(() => setStatus("idle"), 3000);
      }
    },
    [jobId]
  );

  function onChange(value: string) {
    setNotes(value);
    setStatus("idle");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(value), 1000);
  }

  return (
    <div>
      <Textarea
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Add notes about this job — interview details, contact name, follow-up dates, how you found it…"
        rows={3}
        className="resize-none text-sm"
      />
      <div className="mt-1 flex justify-end">
        {status === "saving" && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <LoaderCircle className="h-3 w-3 animate-spin" />
            Saving…
          </span>
        )}
        {status === "saved" && (
          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
        {status === "error" && (
          <span className="text-xs text-destructive">Failed to save</span>
        )}
      </div>
    </div>
  );
}
