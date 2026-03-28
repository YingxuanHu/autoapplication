import { type NextRequest } from "next/server";
import { recordAction } from "@/lib/queries/behavior";
import { dismissSavedJob } from "@/lib/queries/saved-jobs";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await Promise.all([
      recordAction(id, "PASS"),
      dismissSavedJob(id),
    ]);
    return successResponse({ success: true });
  } catch (error) {
    console.error("POST /api/jobs/[id]/pass error:", error);
    return errorResponse("Failed to record pass", 500);
  }
}
