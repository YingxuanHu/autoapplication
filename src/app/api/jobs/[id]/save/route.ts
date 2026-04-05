import { type NextRequest } from "next/server";
import { UnauthorizedError } from "@/lib/current-user";
import { saveJob, unsaveJob } from "@/lib/queries/saved-jobs";
import { recordAction } from "@/lib/queries/behavior";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const [saved] = await Promise.all([
      saveJob(id),
      recordAction(id, "SAVE"),
    ]);
    return successResponse(saved, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("POST /api/jobs/[id]/save error:", error);
    return errorResponse("Failed to save job", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await unsaveJob(id);
    return successResponse({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("DELETE /api/jobs/[id]/save error:", error);
    return errorResponse("Failed to unsave job", 500);
  }
}
