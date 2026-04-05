"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type VerifyEmailCardProps = {
  defaultEmail?: string;
};

const RESEND_COOLDOWN_SECONDS = 30;

export function VerifyEmailCard({ defaultEmail = "" }: VerifyEmailCardProps) {
  const [email, setEmail] = useState(defaultEmail);
  const [pending, setPending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldownSeconds <= 0) {
      return;
    }

    const timer = setInterval(() => {
      setCooldownSeconds((value) => Math.max(0, value - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  const resend = async () => {
    if (cooldownSeconds > 0) {
      setError(`Please wait ${cooldownSeconds}s before resending.`);
      return;
    }

    if (!email) {
      setError("Enter your email to resend verification.");
      return;
    }

    setPending(true);
    setMessage(null);
    setError(null);

    const result = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/?verified=true",
    });

    if (result.error) {
      setError(result.error.message ?? "Unable to send verification email.");
      setPending(false);
      return;
    }

    setMessage("Verification email sent.");
    setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
    setPending(false);
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="section-label">AutoApplication</p>
        <CardTitle className="mt-2 text-2xl">Verify your email</CardTitle>
        <CardDescription>
          Confirm your address before accessing your feed, tracker, and saved documents.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <label className="text-sm font-medium" htmlFor="verify-email">
            Email
          </label>
          <Input
            id="verify-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            type="email"
            value={email}
          />
        </div>
        {error ? (
          <p className="mt-4 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {message}
          </p>
        ) : null}
        <Button
          className="mt-5 w-full"
          disabled={pending || cooldownSeconds > 0}
          onClick={resend}
          type="button"
        >
          {pending
            ? "Sending..."
            : cooldownSeconds > 0
              ? `Resend available in ${cooldownSeconds}s`
              : "Resend verification email"}
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">
          Already verified?{" "}
          <Link className="text-foreground underline-offset-4 hover:underline" href="/">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
