"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LoaderCircle } from "lucide-react";

import type { TrackedApplicationStatus } from "@/generated/prisma/client";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNotifications } from "@/components/ui/notification-provider";
import { TRACKED_STATUS_LABEL } from "@/lib/tracker-ui";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: TrackedApplicationStatus[] = [
  "WISHLIST",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
];

const STATUS_DESCRIPTION: Record<TrackedApplicationStatus, string> = {
  WISHLIST: "Track it before you apply",
  APPLIED: "Mark it already submitted",
  SCREEN: "You are in recruiter review",
  INTERVIEW: "An interview is in progress",
  OFFER: "An offer is on the table",
  REJECTED: "Keep the result in your history",
  WITHDRAWN: "Track it as withdrawn",
};

export function AddToApplicationMenu({
  jobId,
  align = "end",
}: {
  jobId: string;
  align?: "start" | "end";
}) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [pendingStatus, setPendingStatus] = useState<TrackedApplicationStatus | null>(null);

  async function handleSelect(status: TrackedApplicationStatus) {
    if (pendingStatus) {
      return;
    }

    setPendingStatus(status);

    try {
      const response = await fetch(`/api/jobs/${jobId}/track`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { created?: boolean; status?: TrackedApplicationStatus; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not add this job to applications.");
      }

      const nextStatus = payload?.status ?? status;
      notify({
        title: payload?.created ? "Added to applications" : "Application updated",
        message: payload?.created
          ? `${TRACKED_STATUS_LABEL[nextStatus]} status saved from the jobs feed.`
          : `Application status updated to ${TRACKED_STATUS_LABEL[nextStatus]}.`,
        tone: "success",
      });
      router.refresh();
    } catch (error) {
      console.error(error);
      notify({
        title: "Could not update applications",
        message:
          error instanceof Error
            ? error.message
            : "Could not add this job to applications right now.",
        tone: "error",
      });
    } finally {
      setPendingStatus(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "gap-1.5"
        )}
        disabled={pendingStatus !== null}
      >
        {pendingStatus ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : null}
        Add to application
        <ChevronDown className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64 min-w-[16rem]">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {STATUS_OPTIONS.map((status) => (
          <DropdownMenuItem
            key={status}
            className="cursor-pointer items-start"
            disabled={pendingStatus !== null}
            onClick={() => void handleSelect(status)}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {TRACKED_STATUS_LABEL[status]}
              </p>
              <p className="text-xs text-muted-foreground">
                {STATUS_DESCRIPTION[status]}
              </p>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
