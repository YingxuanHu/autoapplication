"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ChevronDown,
  LogOut,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";

import { Avatar } from "@/components/layout/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  queueFlashNotification,
  useNotifications,
} from "@/components/ui/notification-provider";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type SessionSnapshot = {
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
};

export function UserMenu({ user }: { user: SessionSnapshot }) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [confirmOpen, setConfirmOpen] = useState(false);
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

    setConfirmOpen(false);
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
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "group inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 py-1 pr-2 pl-1 text-sm font-medium text-foreground outline-none transition-colors",
            "hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40"
          )}
        >
          <Avatar
            email={user.email}
            image={user.image}
            name={user.name}
            size="sm"
          />
          <span className="hidden max-w-[110px] truncate text-left sm:inline">
            {user.name || user.email}
          </span>
          <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[popup-open]:rotate-180 sm:inline" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64" sideOffset={8}>
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar
              email={user.email}
              image={user.image}
              name={user.name}
              size="md"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {user.name || "Unnamed user"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
              <p
                className={cn(
                  "mt-0.5 inline-flex items-center gap-1 text-[11px]",
                  user.emailVerified ? "text-emerald-500" : "text-amber-500"
                )}
              >
                <ShieldCheck className="h-3 w-3" />
                {user.emailVerified ? "Verified" : "Email unverified"}
              </p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem render={<Link href="/settings" />}>
              <SettingsIcon className="text-muted-foreground" />
              Account settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setConfirmOpen(true)}
            variant="destructive"
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              You will be returned to the sign-in screen and need to
              authenticate again to access your workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={pending} onClick={onSignOut} type="button">
              {pending ? "Signing out..." : "Sign out"}
            </Button>
            <Button
              disabled={pending}
              onClick={() => setConfirmOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
