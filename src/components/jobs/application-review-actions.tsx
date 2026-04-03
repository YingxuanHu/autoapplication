"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApplicationReviewState, ApplicationSubmissionSummary } from "@/types";

type ApplicationReviewActionsProps = {
  jobId: string;
  reviewState: ApplicationReviewState;
  latestPackageId: string | null;
  latestSubmission: ApplicationSubmissionSummary | null;
  canCreatePackage: boolean;
  /** Whether a registered ATS filler can handle this job's apply URL */
  atsSupported?: boolean;
  /** Name of the ATS filler (e.g. "Greenhouse") */
  atsName?: string | null;
};

/** Parse a JSON error body or truncate raw text to a user-friendly message. */
function extractErrorMessage(body: string, fallback: string): string {
  try {
    const json = JSON.parse(body);
    if (typeof json.error === "string") return json.error;
  } catch {
    // not JSON — likely HTML error page
  }
  // Truncate to avoid rendering full HTML pages
  if (body.length > 200) return fallback;
  return body || fallback;
}

// ─── Workflow step ────────────────────────────────────────────────────────────

type WorkflowStep =
  | "ineligible"   // NOT_ELIGIBLE review state
  | "no_resume"    // eligible but no resume variant exists
  | "prepare"      // no package yet, DRAFT, or FAILED submission — start/retry
  | "ready"        // package exists + submission READY — awaiting actual submit
  | "submitted"    // submission SUBMITTED — needs outcome recording
  | "confirmed"    // CONFIRMED — terminal happy path
  | "withdrawn";   // WITHDRAWN — user stopped this application

function getWorkflowStep(
  reviewState: ApplicationReviewState,
  canCreatePackage: boolean,
  latestPackageId: string | null,
  latestSubmission: ApplicationSubmissionSummary | null
): WorkflowStep {
  if (reviewState === "NOT_ELIGIBLE") return "ineligible";
  if (!canCreatePackage) return "no_resume";

  const status = latestSubmission?.status;

  if (!status || status === "DRAFT" || status === "FAILED") return "prepare";
  if (status === "READY") return "ready";
  if (status === "SUBMITTED") return "submitted";
  if (status === "CONFIRMED") return "confirmed";
  if (status === "WITHDRAWN") return "withdrawn";

  return "prepare";
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ApplicationReviewActions({
  jobId,
  reviewState,
  latestPackageId,
  latestSubmission,
  canCreatePackage,
  atsSupported = false,
  atsName = null,
}: ApplicationReviewActionsProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [autoApplyStatus, setAutoApplyStatus] = useState<"idle" | "running" | "done">("idle");

  const step = getWorkflowStep(
    reviewState,
    canCreatePackage,
    latestPackageId,
    latestSubmission
  );
  const isManual = reviewState === "MANUAL_ONLY";

  function post(intent: "prepare" | "submit") {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(extractErrorMessage(body, "Something went wrong"));
        }
        router.refresh();
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      }
    });
  }

  function patch(intent: "confirm" | "fail" | "withdraw") {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/apply`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(extractErrorMessage(body, "Could not update submission status"));
        }
        router.refresh();
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : "Could not update submission status.");
      }
    });
  }

  function triggerAutoApply(mode: "dry_run" | "fill_only" | "fill_and_submit") {
    if (isPending || autoApplyStatus === "running") return;
    setError(null);
    setAutoApplyStatus("running");
    startTransition(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/auto-apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error ?? "Auto-apply failed");
        }
        setAutoApplyStatus("done");
        router.refresh();
      } catch (e) {
        setAutoApplyStatus("idle");
        setError(e instanceof Error ? e.message : "Auto-apply failed. Try again.");
      }
    });
  }

  const spinner = isPending && autoApplyStatus !== "running"
    ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
    : null;
  const autoSpinner = autoApplyStatus === "running"
    ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
    : <Bot className="h-3.5 w-3.5" />;

  // ── Render per step ──────────────────────────────────────────────────────

  if (step === "ineligible") {
    return (
      <p className="text-sm text-muted-foreground">
        This job is not eligible for the tracked apply flow.
      </p>
    );
  }

  if (step === "no_resume") {
    return (
      <p className="text-sm text-muted-foreground">
        Add a resume variant in{" "}
        <a href="/profile" className="underline underline-offset-2 hover:text-foreground">
          your profile
        </a>{" "}
        before preparing a package.
      </p>
    );
  }

  if (step === "prepare") {
    const hasFailed = latestSubmission?.status === "FAILED";
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => post("prepare")} disabled={isPending}>
            {spinner}
            {hasFailed
              ? "Prepare again"
              : isManual
                ? "Prepare application notes"
                : latestPackageId
                  ? "Update package"
                  : "Prepare package"}
          </Button>
          {atsSupported && !isManual ? (
            <Button
              variant="outline"
              onClick={() => triggerAutoApply("fill_only")}
              disabled={isPending || autoApplyStatus === "running"}
            >
              {autoSpinner}
              Auto-fill{atsName ? ` (${atsName})` : ""}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => post("submit")} disabled={isPending}>
            {spinner}
            {isManual ? "Mark submitted manually" : "Mark submitted"}
          </Button>
        </div>
        {hasFailed ? (
          <p className="text-xs text-muted-foreground">
            Previous submission was marked as failed. Prepare a fresh package or record a new attempt.
          </p>
        ) : null}
        {atsSupported && !isManual ? (
          <p className="text-xs text-muted-foreground">
            Auto-fill opens the application form and fills fields automatically. You can review before submitting.
          </p>
        ) : null}
        {error ? <p aria-live="polite" className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  if (step === "ready") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Package is ready.{" "}
          {isManual
            ? "Submit the application manually, then record it here."
            : "When you have actually submitted the application, record it below."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {atsSupported && !isManual ? (
            <Button
              onClick={() => triggerAutoApply("fill_only")}
              disabled={isPending || autoApplyStatus === "running"}
            >
              {autoSpinner}
              Auto-fill{atsName ? ` (${atsName})` : ""}
            </Button>
          ) : null}
          <Button variant={atsSupported && !isManual ? "outline" : "default"} onClick={() => post("submit")} disabled={isPending}>
            {spinner}
            {isManual ? "Mark submitted manually" : "Mark as submitted"}
          </Button>
          <Button variant="ghost" onClick={() => post("prepare")} disabled={isPending}>
            {spinner}
            Update package
          </Button>
          <Button variant="ghost" onClick={() => patch("withdraw")} disabled={isPending}>
            {spinner}
            Withdraw
          </Button>
        </div>
        {error ? <p aria-live="polite" className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  if (step === "submitted") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Submission recorded. Update the outcome when you hear back.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => patch("confirm")} disabled={isPending}>
            {spinner}
            Mark confirmed
          </Button>
          <Button variant="ghost" onClick={() => patch("fail")} disabled={isPending}>
            {spinner}
            Mark failed
          </Button>
          <Button variant="ghost" onClick={() => patch("withdraw")} disabled={isPending}>
            {spinner}
            Withdraw
          </Button>
        </div>
        {error ? <p aria-live="polite" className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  if (step === "confirmed") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Application confirmed. No further action needed.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => patch("fail")} disabled={isPending}>
            {spinner}
            Mark failed
          </Button>
          <Button variant="ghost" size="sm" onClick={() => patch("withdraw")} disabled={isPending}>
            {spinner}
            Withdraw
          </Button>
        </div>
        {error ? <p aria-live="polite" className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  // step === "withdrawn"
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Application withdrawn. You can start over if circumstances change.
      </p>
      <Button variant="outline" onClick={() => post("prepare")} disabled={isPending}>
        {spinner}
        Start over
      </Button>
      {error ? <p aria-live="polite" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
