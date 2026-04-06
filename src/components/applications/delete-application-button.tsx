"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { useNotifications } from "@/components/ui/notification-provider";

type DeleteApplicationButtonProps = {
  applicationId: string;
  redirectToList?: boolean;
  size?: "sm" | "default";
  variant?: "ghost" | "outline" | "destructive";
  className?: string;
};

export function DeleteApplicationButton({
  applicationId,
  redirectToList = false,
  size = "sm",
  variant = "ghost",
  className,
}: DeleteApplicationButtonProps) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    if (isPending) return;

    startTransition(async () => {
      try {
        const response = await fetch(`/api/applications/${applicationId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Could not delete this application.");
        }

        notify({
          title: "Application deleted",
          message: "This job was removed from your applications.",
          tone: "success",
        });
        setOpen(false);

        if (redirectToList) {
          router.push("/applications");
          return;
        }

        router.refresh();
      } catch (error) {
        console.error(error);
        notify({
          title: "Could not delete application",
          message:
            error instanceof Error
              ? error.message
              : "Could not delete this application.",
          tone: "error",
        });
      }
    });
  }

  return (
    <>
      <Button
        className={className}
        onClick={() => setOpen(true)}
        size={size}
        type="button"
        variant={variant}
      >
        Delete
      </Button>
      <ConfirmActionDialog
        confirmLabel={isPending ? "Deleting..." : "Delete"}
        description="Delete this job from your applications?"
        destructive
        onConfirm={handleDelete}
        onOpenChange={setOpen}
        open={open}
        pending={isPending}
        title="Delete application?"
      />
    </>
  );
}
