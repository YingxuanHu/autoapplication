import { redirect } from "next/navigation";

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
    <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-10">
      <ForgotPasswordForm defaultEmail={params.email ?? ""} />
    </main>
  );
}
