import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getJobFreshnessStats,
  cleanupJobs,
  markStaleJobs,
  detectNewJobs,
} from "@/lib/job-sources/freshness";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const stats = await getJobFreshnessStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Failed to get freshness stats:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let action = "stats";
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await request.json();
        if (typeof body.action === "string") {
          action = body.action;
        }
      } catch {
        // Default to stats
      }
    }

    switch (action) {
      case "cleanup": {
        const result = await cleanupJobs();
        return NextResponse.json({
          action: "cleanup",
          ...result,
        });
      }

      case "mark-stale": {
        const count = await markStaleJobs();
        return NextResponse.json({
          action: "mark-stale",
          markedStale: count,
        });
      }

      case "detect-new": {
        const sinceMs = 24 * 60 * 60 * 1000; // Default: last 24 hours
        const result = await detectNewJobs(new Date(Date.now() - sinceMs));
        return NextResponse.json({
          action: "detect-new",
          since: new Date(Date.now() - sinceMs).toISOString(),
          ...result,
        });
      }

      case "stats":
      default: {
        const stats = await getJobFreshnessStats();
        return NextResponse.json({
          action: "stats",
          ...stats,
        });
      }
    }
  } catch (error) {
    console.error("Failed to process freshness action:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
