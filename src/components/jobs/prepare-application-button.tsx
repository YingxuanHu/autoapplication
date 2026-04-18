"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePenLine, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNotifications } from "@/components/ui/notification-provider";
import { TRACKED_STATUS_LABEL } from "@/lib/tracker-ui";

type PrepareApplicationButtonProps = {
  jobId: string;
  label?: string;
  size?: "default" | "sm";
  variant?: "default" | "outline" | "secondary" | "ghost";
};

export function PrepareApplicationButton({
  jobId,
  label = "Prepare application",
  size = "sm",
  variant = "outline",
}: PrepareApplicationButtonProps) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [isPending, startTransition] = useTransition();

  function handlePrepare() {
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
    <Button
      disabled={isPending}
      onClick={handlePrepare}
      size={size}
      type="button"
      variant={variant}
    >
      {isPending ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <FilePenLine className="h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  );
}
