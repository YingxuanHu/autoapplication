import { redirect } from "next/navigation";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { getOptionalSessionUser } from "@/lib/current-user";

export default async function SignUpPage() {
  const sessionUser = await getOptionalSessionUser();

  if (sessionUser) {
    redirect("/jobs");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-10">
      <SignUpForm />
    </main>
  );
}
