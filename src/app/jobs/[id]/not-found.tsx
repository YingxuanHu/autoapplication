import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function JobNotFound() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <h2 className="text-lg font-semibold text-foreground">Job not found</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This job may have been removed, expired, or the link is invalid.
      </p>
      <Button variant="outline" size="sm" className="mt-6" render={<Link href="/jobs" />}>
        Back to jobs
      </Button>
    </div>
  );
}
