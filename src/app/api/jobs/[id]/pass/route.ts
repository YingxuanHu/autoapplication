import { type NextRequest } from "next/server";
import { recordAction } from "@/lib/queries/behavior";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await recordAction(id, "PASS");
    return successResponse({ success: true });
  } catch (error) {
    console.error("POST /api/jobs/[id]/pass error:", error);
    return errorResponse("Failed to record pass", 500);
  }
}
