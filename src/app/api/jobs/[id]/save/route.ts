import { type NextRequest } from "next/server";
import { UnauthorizedError } from "@/lib/current-user";
import { saveJob, unsaveJob } from "@/lib/queries/saved-jobs";
import { recordAction } from "@/lib/queries/behavior";
import {
  removeTrackedWishlistFromJob,
  upsertTrackedApplicationFromJob,
} from "@/lib/queries/tracker";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const [tracked] = await Promise.all([
      upsertTrackedApplicationFromJob({
        canonicalJobId: id,
        status: "WISHLIST",
      }),
      recordAction(id, "SAVE"),
    ]);

    const saved = await saveJob(
      id,
      tracked.status === "WISHLIST" || tracked.status === "PREPARING"
        ? "ACTIVE"
        : "APPLIED"
    );

    return successResponse(
      {
        ...saved,
        trackedStatus: tracked.status,
      },
      tracked.created ? 201 : 200
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("POST /api/jobs/[id]/save error:", error);
    return errorResponse("Failed to add job to wishlist", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await Promise.all([
      unsaveJob(id),
      removeTrackedWishlistFromJob(id),
    ]);
    return successResponse({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("DELETE /api/jobs/[id]/save error:", error);
    return errorResponse("Failed to remove job from wishlist", 500);
  }
}
