import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { getOptionalSessionUser } from "@/lib/current-user";

type ForgotPasswordPageProps = {
  searchParams: Promise<{ email?: string }>;
};

export default async function ForgotPasswordPage({
  searchParams,
}: ForgotPasswordPageProps) {
  const sessionUser = await getOptionalSessionUser();

  if (sessionUser) {
    redirect("/jobs");
  }

  const params = await searchParams;

  return (
    <AuthShell
      contextTitle="Recover account access without losing your workspace."
      contextDescription="Reset access to your feed, tracker, documents, reminders, and profile settings from one place."
      highlights={[
        "Your tracked applications and deadlines stay attached to your account.",
        "Uploaded resumes and cover letters remain available after sign-in.",
        "Use the same email address tied to your existing workspace.",
      ]}
    >
      <ForgotPasswordForm defaultEmail={params.email ?? ""} />
    </AuthShell>
  );
}
