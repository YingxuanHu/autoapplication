import { type NextRequest } from "next/server";
import { UnauthorizedError } from "@/lib/current-user";
import { getSavedJobs } from "@/lib/queries/saved-jobs";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get("status") ?? undefined;
    const savedJobs = await getSavedJobs(status);
    return successResponse(savedJobs);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("GET /api/saved-jobs error:", error);
    return errorResponse("Failed to fetch saved jobs", 500);
  }
}
