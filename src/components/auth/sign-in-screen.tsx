"use client";

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
    <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-10">
      <SignInForm callbackUrl={callbackUrl} justVerified={justVerified} />
    </main>
  );
}
