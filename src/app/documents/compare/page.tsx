import Link from "next/link";
import { redirect } from "next/navigation";

import { DocumentComparison } from "@/components/documents/document-comparison";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getComparableDocuments } from "@/lib/queries/tracker";

export default async function DocumentComparePage() {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const { documents } = await getComparableDocuments();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compare Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the exact differences between stored resumes, cover letters, and templates.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link href="/profile" className="hover:text-foreground">
            Profile
          </Link>
          <Link href="/applications" className="hover:text-foreground">
            Applications
          </Link>
        </div>
      </div>

      {documents.length < 2 ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Upload at least two documents from your profile to compare them here.
        </div>
      ) : (
        <DocumentComparison documents={documents} />
      )}
    </div>
  );
}
