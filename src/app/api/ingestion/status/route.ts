import { getIngestionStatus } from "@/lib/queries/ingestion";
import { errorResponse, successResponse } from "@/lib/api-utils";

/**
 * GET /api/ingestion/status
 *
 * Lightweight, unauthenticated status endpoint for the user-facing feed.
 * Returns last successful ingestion timestamp, live job count, and active
 * source platform count. Intentionally minimal — does not expose operational
 * detail from /api/ingestion/schedule.
 */
export async function GET() {
  try {
    const status = await getIngestionStatus();
    return successResponse(status);
  } catch (error) {
    console.error("GET /api/ingestion/status error:", error);
    return errorResponse("Failed to fetch ingestion status", 500);
  }
}
