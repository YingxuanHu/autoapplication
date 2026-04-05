"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { createTrackedApplicationAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Add application"}
    </Button>
  );
}

export function CreateTrackedApplicationForm() {
  const [state, action] = useActionState(createTrackedApplicationAction, {
    error: null,
    success: null,
  });

  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Company
          </span>
          <Input name="company" required />
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Role
          </span>
          <Input name="roleTitle" required />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1.5 sm:col-span-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Posting URL
          </span>
          <Input name="roleUrl" type="url" placeholder="https://..." />
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Status
          </span>
          <select
            name="status"
            defaultValue="WISHLIST"
            className="h-9 rounded-lg border border-input/80 bg-background/70 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="WISHLIST">Wishlist</option>
            <option value="APPLIED">Applied</option>
            <option value="SCREEN">Screen</option>
            <option value="INTERVIEW">Interview</option>
            <option value="OFFER">Offer</option>
            <option value="REJECTED">Rejected</option>
            <option value="WITHDRAWN">Withdrawn</option>
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Deadline
          </span>
          <Input name="deadline" type="date" />
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Notes
          </span>
          <Textarea
            name="notes"
            rows={1}
            className="h-9 min-h-9 resize-y py-2"
            placeholder="Why this role matters, next step, recruiter contact..."
          />
        </label>
      </div>

      {state.error ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}

      {state.success ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-300">
          {state.success}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Jobs submitted from the feed will also appear here automatically.
        </p>
        <SubmitButton />
      </div>
    </form>
  );
}
