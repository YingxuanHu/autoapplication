import { getFeedStats } from "@/lib/queries/jobs";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function GET() {
  try {
    const stats = await getFeedStats();
    return successResponse(stats);
  } catch (error) {
    console.error("GET /api/stats error:", error);
    return errorResponse("Failed to fetch stats", 500);
  }
}
