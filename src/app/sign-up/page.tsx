import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { getOptionalSessionUser } from "@/lib/current-user";

export default async function SignUpPage() {
  const sessionUser = await getOptionalSessionUser();

  if (sessionUser) {
    redirect("/jobs");
  }

  return (
    <AuthShell
      contextTitle="Create a workspace that keeps every application connected."
      contextDescription="Your account ties together the live feed, tracker, profile, uploaded documents, reminders, and automation settings."
      highlights={[
        "Jobs you apply to from the feed can flow into the tracker automatically.",
        "Documents, resume variants, and profile data stay tied to your account.",
        "Reminder preferences and notifications follow the same workspace.",
      ]}
      footer={null}
    >
      <SignUpForm />
    </AuthShell>
  );
}
