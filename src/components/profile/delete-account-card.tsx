"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Input } from "@/components/ui/input";
import {
  queueFlashNotification,
  useNotifications,
} from "@/components/ui/notification-provider";

export function DeleteAccountCard({ email }: { email: string }) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const ready = password.length >= 8 && confirmation === "DELETE";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) {
      setError('Enter your current password and type "DELETE" to confirm.');
      return;
    }

    setConfirmOpen(true);
  }

  async function confirmDelete() {
    setPending(true);
    setError(null);

    const result = await authClient.deleteUser({
      password,
      callbackURL: "/",
    });

    if (result.error) {
      setError(result.error.message ?? "Unable to delete account.");
      setPending(false);
      notify({
        tone: "error",
        title: "Delete failed",
        message: result.error.message ?? "Unable to delete account.",
      });
      return;
    }

    setConfirmOpen(false);
    queueFlashNotification({
      tone: "success",
      title: "Account deleted",
      message: "Your account and workspace data have been removed.",
    });
    router.push("/");
    router.refresh();
  }

  return (
    <Card className="border border-destructive/20 bg-card">
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          This permanently removes your account and tracker data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Current password
              </span>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            <label className="grid gap-1.5 text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Type DELETE
              </span>
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="destructive" disabled={!ready || pending}>
              {pending ? "Deleting..." : "Delete account"}
            </Button>
            <p className="text-xs text-muted-foreground">This action cannot be undone.</p>
          </div>
        </form>
        <ConfirmActionDialog
          confirmLabel={pending ? "Deleting..." : "Delete account"}
          description={`Delete the account for ${email}? This permanently removes auth, profile data, tracker records, reminders, and documents.`}
          destructive
          onConfirm={() => void confirmDelete()}
          onOpenChange={setConfirmOpen}
          open={confirmOpen}
          pending={pending}
          title="Delete account?"
        />
      </CardContent>
    </Card>
  );
}
