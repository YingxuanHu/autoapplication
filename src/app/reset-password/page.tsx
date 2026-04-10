import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

type ResetPasswordPageProps = {
  searchParams: Promise<{ token?: string; error?: string }>;
};

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const params = await searchParams;

  return (
    <AuthShell
      contextTitle="Finish password recovery and return to the workspace."
      contextDescription="Once your password is updated, you can continue with the feed, tracker, profile, and connected application tools."
      highlights={[
        "Use a password you can reuse for ongoing job-search sessions.",
        "Your account-specific documents and reminders are preserved.",
        "If the link has expired, request a fresh reset email and try again.",
      ]}
    >
      <ResetPasswordForm errorCode={params.error} token={params.token} />
    </AuthShell>
  );
}
