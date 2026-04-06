import type { TrackedApplicationStatus } from "@/generated/prisma/client";

export const TRACKED_ACTIVE_STATUSES: TrackedApplicationStatus[] = [
  "WISHLIST",
  "PREPARING",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
];
