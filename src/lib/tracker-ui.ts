import type { TrackedApplicationStatus } from "@/generated/prisma/client";

export const TRACKED_STATUS_LABEL: Record<TrackedApplicationStatus, string> = {
  WISHLIST: "Wishlist",
  PREPARING: "Preparing",
  APPLIED: "Applied",
  SCREEN: "Screen",
  INTERVIEW: "Interview",
  OFFER: "Offer",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

export function trackedStatusClass(status: TrackedApplicationStatus) {
  switch (status) {
    case "PREPARING":
      return "bg-violet-500/10 text-violet-700 dark:text-violet-300";
    case "OFFER":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "INTERVIEW":
      return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "SCREEN":
      return "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
    case "APPLIED":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "REJECTED":
      return "bg-destructive/10 text-destructive";
    case "WITHDRAWN":
      return "bg-muted text-muted-foreground";
    case "WISHLIST":
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

export function formatTrackerDate(value: Date | null) {
  if (!value) return "No deadline";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
  }).format(value);
}
