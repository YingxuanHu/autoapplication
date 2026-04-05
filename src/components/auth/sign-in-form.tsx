"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type SignInFormProps = {
  callbackUrl?: string;
  justVerified?: boolean;
};

export function SignInForm({
  callbackUrl = "/jobs",
  justVerified,
}: SignInFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setVerificationEmail(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");

    const result = await authClient.signIn.email({
      email,
      password,
      callbackURL: callbackUrl,
    });

    if (result.error) {
      const message = result.error.message ?? "Unable to sign in.";
      if (message.toLowerCase().includes("verify")) {
        setError("Email not verified. Check your inbox for the verification link.");
        setVerificationEmail(email);
      } else {
        setError(message);
      }
      setPending(false);
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          AutoApplication
        </p>
        <CardTitle className="mt-2 text-2xl">Sign in</CardTitle>
      </CardHeader>
      <CardContent>
        {justVerified ? (
          <p className="mb-4 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            Email verified. You can now sign in.
          </p>
        ) : null}
        <form className="space-y-4" onSubmit={onSubmit}>
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
            <Input id="password" minLength={8} name="password" required type="password" />
          </div>
          <div className="flex justify-end">
            <Link className="text-sm text-muted-foreground hover:text-foreground" href="/forgot-password">
              Forgot password?
            </Link>
          </div>
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {verificationEmail ? (
            <Button className="w-full" variant="outline" render={<Link href={`/verify-email-required?email=${encodeURIComponent(verificationEmail)}`} />}>
              Verify email
            </Button>
          ) : null}
          <Button className="w-full" disabled={pending} type="submit">
            {pending ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          New here?{" "}
          <Link className="text-foreground underline-offset-4 hover:underline" href="/sign-up">
            Create account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
