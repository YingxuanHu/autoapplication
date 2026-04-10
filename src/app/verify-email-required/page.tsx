import { AuthShell } from "@/components/auth/auth-shell";
import { VerifyEmailCard } from "@/components/auth/verify-email-card";

type VerifyEmailRequiredPageProps = {
  searchParams: Promise<{ email?: string }>;
};

export default async function VerifyEmailRequiredPage({
  searchParams,
}: VerifyEmailRequiredPageProps) {
  const params = await searchParams;

  return (
    <AuthShell
      contextTitle="Verify your email before entering the workspace."
      contextDescription="Email verification protects your account-specific tracker, profile data, and uploaded application materials."
      highlights={[
        "Verification is required before using the jobs feed and tracker.",
        "Use the same address you signed up with to resend the message.",
        "After verification, sign-in takes you straight into the app.",
      ]}
    >
      <VerifyEmailCard defaultEmail={params.email ?? ""} />
    </AuthShell>
  );
}
