"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type ResetPasswordFormProps = {
  token?: string;
  errorCode?: string;
};

export function ResetPasswordForm({ token, errorCode }: ResetPasswordFormProps) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const initialError = useMemo(() => {
    if (!token) {
      return "Missing reset token. Request a new password reset link.";
    }
    if (errorCode === "INVALID_TOKEN") {
      return "This reset link is invalid or expired. Request a new one.";
    }
    if (errorCode) {
      return "Unable to use this reset link. Request a new one.";
    }
    return null;
  }, [errorCode, token]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);

    if (!token) {
      setError("Missing reset token. Request a new password reset link.");
      setPending(false);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setPending(false);
      return;
    }

    const result = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    if (result.error) {
      const responseError = result.error.message ?? "Unable to reset password.";
      if (responseError.toLowerCase().includes("token")) {
        setError("This reset link is invalid or expired. Request a new one.");
      } else {
        setError(responseError);
      }
      setPending(false);
      return;
    }

    setMessage("Password reset successful. You can now sign in with your new password.");
    setPending(false);
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="section-label">AutoApplication</p>
        <CardTitle className="mt-2 text-2xl">Reset password</CardTitle>
        <CardDescription>
          Choose a new password for your account and return to your workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password">
              New password
            </label>
            <Input
              id="password"
              minLength={8}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="confirmPassword">
              Confirm new password
            </label>
            <Input
              id="confirmPassword"
              minLength={8}
              name="confirmPassword"
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              type="password"
              value={confirmPassword}
            />
          </div>
          {initialError ? (
            <p className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {initialError}
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              {message}
            </p>
          ) : null}
          <Button className="w-full" disabled={pending || !token} type="submit">
            {pending ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Updating...
              </>
            ) : (
              "Reset password"
            )}
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          Need another link?{" "}
          <Link className="text-foreground underline-offset-4 hover:underline" href="/forgot-password">
            Request reset email
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
