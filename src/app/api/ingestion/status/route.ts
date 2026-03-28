import { NextResponse } from "next/server";
import { getIngestionStatus } from "@/lib/queries/ingestion";

/**
 * GET /api/ingestion/status
 *
 * Lightweight, unauthenticated status endpoint for the user-facing feed.
 * Returns last successful ingestion timestamp, live job count, and active
 * source platform count. Intentionally minimal — does not expose operational
 * detail from /api/ingestion/schedule.
 */
export async function GET() {
  const status = await getIngestionStatus();
  return NextResponse.json(status);
}
