import { type NextRequest } from "next/server";
import { saveJob, unsaveJob } from "@/lib/queries/saved-jobs";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const saved = await saveJob(id);
    return successResponse(saved, 201);
  } catch (error) {
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
    console.error("DELETE /api/jobs/[id]/save error:", error);
    return errorResponse("Failed to unsave job", 500);
  }
}
