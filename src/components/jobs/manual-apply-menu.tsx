"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ExternalLink, FilePenLine, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNotifications } from "@/components/ui/notification-provider";
import { TRACKED_STATUS_LABEL } from "@/lib/tracker-ui";
import { cn } from "@/lib/utils";

type ManualApplyMenuProps = {
  jobId: string;
  applyHref?: string | null;
  align?: "start" | "end";
  buttonVariant?: "default" | "outline" | "secondary" | "ghost";
  buttonSize?: "default" | "sm";
};

export function ManualApplyMenu({
  jobId,
  applyHref,
  align = "start",
  buttonVariant = "default",
  buttonSize = "sm",
}: ManualApplyMenuProps) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  function handlePrepareToApply() {
    if (isPending) return;

    startTransition(async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}/prepare`, {
          method: "POST",
        });
        const data = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(data?.error ?? "Could not open the preparation workspace.");
        }

        notify({
          title: data?.created ? "Added to applications" : "Opened application workspace",
          message:
            data?.status === "PREPARING"
              ? "This job is now in your preparing list."
              : `This job is already marked ${TRACKED_STATUS_LABEL[data?.status as keyof typeof TRACKED_STATUS_LABEL] ?? "in applications"}.`,
          tone: "success",
        });
        setOpen(false);
        router.push(data?.workspaceUrl ?? `/applications/${data?.applicationId}`);
      } catch (error) {
        console.error(error);
        notify({
          title: "Could not prepare this job",
          message:
            error instanceof Error
              ? error.message
              : "Could not open the preparation workspace.",
          tone: "error",
        });
      }
    });
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button
        aria-expanded={open}
        className="gap-1.5"
        onClick={() => setOpen((current) => !current)}
        size={buttonSize}
        type="button"
        variant={buttonVariant}
      >
        Manual apply
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </Button>

      {open ? (
        <div
          className={cn(
            "absolute top-[calc(100%+0.5rem)] z-30 w-56 rounded-xl border border-border/70 bg-background/95 p-1.5 shadow-[0_20px_45px_rgba(15,23,42,0.14)] backdrop-blur",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {applyHref ? (
            <Button
              className="w-full justify-start"
              render={
                <a href={applyHref} rel="noreferrer" target="_blank" />
              }
              size="sm"
              variant="ghost"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open application
            </Button>
          ) : (
            <Button
              className="w-full justify-start"
              disabled
              size="sm"
              type="button"
              variant="ghost"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Application link unavailable
            </Button>
          )}

          <Button
            className="mt-1 w-full justify-start"
            disabled={isPending}
            onClick={handlePrepareToApply}
            size="sm"
            type="button"
            variant="ghost"
          >
            {isPending ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FilePenLine className="h-3.5 w-3.5" />
            )}
            Prepare to apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}
