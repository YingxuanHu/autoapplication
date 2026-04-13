import {
  getIngestionHeartbeat,
  getIngestionStatus,
} from "@/lib/queries/ingestion";
import { errorResponse, successResponse } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/ingestion/status
 *
 * Lightweight, unauthenticated status endpoint for the user-facing feed.
 * Returns last successful ingestion timestamp, live job count, and active
 * source platform count. Intentionally minimal — does not expose operational
 * detail from /api/ingestion/schedule.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    const payload =
      mode === "heartbeat"
        ? await getIngestionHeartbeat()
        : await getIngestionStatus();

    return successResponse(payload, 200, {
      "Cache-Control": "no-store, max-age=0",
    });
  } catch (error) {
    console.error("GET /api/ingestion/status error:", error);
    return errorResponse("Failed to fetch ingestion status", 500);
  }
}
