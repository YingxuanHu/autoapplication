import { type NextRequest } from "next/server";
import { getJobById } from "@/lib/queries/jobs";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getJobById(id);
    if (!job) return errorResponse("Job not found", 404);
    return successResponse(job);
  } catch (error) {
    console.error("GET /api/jobs/[id] error:", error);
    return errorResponse("Failed to fetch job", 500);
  }
}
