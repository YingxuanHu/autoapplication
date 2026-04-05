import { type NextRequest } from "next/server";

import type { TrackedApplicationStatus } from "@/generated/prisma/client";
import {
  requireCurrentProfileId,
  UnauthorizedError,
} from "@/lib/current-user";
import { errorResponse, successResponse } from "@/lib/api-utils";
import { recordAction } from "@/lib/queries/behavior";
import { upsertTrackedApplicationFromJob } from "@/lib/queries/tracker";
import { prisma } from "@/lib/db";

const STATUS_OPTIONS = new Set<TrackedApplicationStatus>([
  "WISHLIST",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const statusRaw = String(body?.status ?? "WISHLIST").trim().toUpperCase();

    if (!STATUS_OPTIONS.has(statusRaw as TrackedApplicationStatus)) {
      return errorResponse("Invalid tracked application status", 400);
    }

    const status = statusRaw as TrackedApplicationStatus;
    const profileId = await requireCurrentProfileId();

    const tracked = await upsertTrackedApplicationFromJob({
      canonicalJobId: id,
      status,
    });

    await prisma.savedJob.upsert({
      where: {
        userId_canonicalJobId: {
          userId: profileId,
          canonicalJobId: id,
        },
      },
      create: {
        userId: profileId,
        canonicalJobId: id,
        status: status === "WISHLIST" ? "ACTIVE" : "APPLIED",
      },
      update: {
        status: status === "WISHLIST" ? "ACTIVE" : "APPLIED",
      },
    });

    await recordAction(id, status === "WISHLIST" ? "SAVE" : "APPLY");

    return successResponse(tracked, tracked.created ? 201 : 200);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("POST /api/jobs/[id]/track error:", error);
    return errorResponse("Failed to add job to applications", 500);
  }
}
