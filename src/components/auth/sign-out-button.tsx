"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  queueFlashNotification,
  useNotifications,
} from "@/components/ui/notification-provider";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const { notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const onSignOut = async () => {
    setPending(true);
    const result = await authClient.signOut();

    if (result.error) {
      setPending(false);
      notify({
        tone: "error",
        title: "Sign-out failed",
        message: "Your session could not be ended right now. Try again.",
      });
      return;
    }

    setOpen(false);
    queueFlashNotification({
      tone: "success",
      title: "Signed out",
      message: "Your session has ended.",
    });
    router.push("/");
    router.refresh();
  };

  return (
    <>
      <Button disabled={pending} onClick={() => setOpen(true)} type="button" variant="secondary">
        {pending ? (
          <>
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Signing out...
          </>
        ) : (
          "Sign out"
        )}
      </Button>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              You will be returned to the sign-in screen and need to authenticate again to access your workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={pending} onClick={onSignOut} type="button">
              {pending ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Signing out...
                </>
              ) : (
                "Sign out"
              )}
            </Button>
            <Button disabled={pending} onClick={() => setOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
