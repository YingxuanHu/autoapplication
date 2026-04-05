"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type SignUpStatusResponse = {
  exists: boolean;
  emailVerified: boolean;
};

export function SignUpForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function getEmailStatus(email: string): Promise<SignUpStatusResponse | null> {
    const response = await fetch(`/api/auth/sign-up-status?email=${encodeURIComponent(email)}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as SignUpStatusResponse;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim().toLowerCase();

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setPending(false);
      return;
    }

    const existingUser = await getEmailStatus(email);
    if (existingUser?.exists) {
      setPending(false);
      if (!existingUser.emailVerified) {
        router.push(`/verify-email-required?email=${encodeURIComponent(email)}`);
        router.refresh();
        return;
      }

      router.push(`/forgot-password?email=${encodeURIComponent(email)}`);
      router.refresh();
      return;
    }

    const result = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: "/?verified=true",
      emailNotificationsEnabled,
    } as Parameters<typeof authClient.signUp.email>[0]);

    if (result.error) {
      setError(result.error.message ?? "Unable to create account.");
      setPending(false);
      return;
    }

    router.push(`/verify-email-required?email=${encodeURIComponent(email)}`);
    router.refresh();
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          AutoApplication
        </p>
        <CardTitle className="mt-2 text-2xl">Create account</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="name">
              Name
            </label>
            <Input id="name" name="name" required />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <Input id="email" name="email" required type="email" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password">
              Password
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
            <p className={password.length >= 8 ? "text-xs text-green-700 dark:text-green-400" : "text-xs text-destructive"}>
              Must contain at least 8 characters
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="confirmPassword">
              Confirm password
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
          <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm">
            <input
              checked={emailNotificationsEnabled}
              className="mt-1"
              onChange={(event) => setEmailNotificationsEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>Email me deadline reminders</span>
          </label>
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button className="w-full" disabled={pending} type="submit">
            {pending ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              "Create account"
            )}
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link className="text-foreground underline-offset-4 hover:underline" href="/">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
