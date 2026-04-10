"use client";

import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "@/components/auth/sign-in-form";

type SignInScreenProps = {
  callbackUrl?: string;
  justVerified?: boolean;
};

export function SignInScreen({
  callbackUrl = "/jobs",
  justVerified = false,
}: SignInScreenProps) {
  return (
    <AuthShell
      contextTitle="Search, apply, and track from one quiet workspace."
      contextDescription="Keep your job feed, application tracker, profile data, resumes, and AI-assisted materials connected without adding friction to the workflow."
      highlights={[
        "Review the live job pool before acting.",
        "Keep application history and deadlines in sync automatically.",
        "Store resumes and cover letters alongside structured profile data.",
      ]}
      footer={
        <>
          Need an account?{" "}
          <Link className="text-foreground underline-offset-4 hover:underline" href="/sign-up">
            Create one
          </Link>
        </>
      }
    >
      <SignInForm callbackUrl={callbackUrl} justVerified={justVerified} />
    </AuthShell>
  );
}
