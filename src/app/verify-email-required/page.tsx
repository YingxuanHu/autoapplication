import { VerifyEmailCard } from "@/components/auth/verify-email-card";

type VerifyEmailRequiredPageProps = {
  searchParams: Promise<{ email?: string }>;
};

export default async function VerifyEmailRequiredPage({
  searchParams,
}: VerifyEmailRequiredPageProps) {
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-10">
      <VerifyEmailCard defaultEmail={params.email ?? ""} />
    </main>
  );
}
