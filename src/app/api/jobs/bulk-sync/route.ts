import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  runBulkSync,
  getBulkSyncProgress,
  getDefaultQueries,
  estimateJobVolume,
} from "@/lib/job-sources/bulk-sync";
import type { BulkSyncOptions } from "@/lib/job-sources/bulk-sync";
import { markExpiredJobs } from "@/lib/job-sources/freshness";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const progress = getBulkSyncProgress();
    const defaults = getDefaultQueries();
    const estimates = estimateJobVolume();

    return NextResponse.json({
      progress,
      defaultQueryCount: defaults.length,
      estimates,
    });
  } catch (error) {
    console.error("Failed to get bulk sync status:", error);
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

    // Check if a sync is already running
    const current = getBulkSyncProgress();
    if (current.status === "running") {
      return NextResponse.json(
        {
          error: "A bulk sync is already in progress",
          progress: current,
        },
        { status: 409 },
      );
    }

    // Parse optional body
    let options: BulkSyncOptions = {};
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await request.json();
        options = {
          queries: Array.isArray(body.queries) ? body.queries : undefined,
          locations: Array.isArray(body.locations) ? body.locations : undefined,
          sources: Array.isArray(body.sources) ? body.sources : undefined,
          batchSize:
            typeof body.batchSize === "number" ? body.batchSize : undefined,
          batchDelayMs:
            typeof body.batchDelayMs === "number"
              ? body.batchDelayMs
              : undefined,
        };
      } catch {
        // Proceed with defaults
      }
    }

    // Start the bulk sync in the background so we can respond immediately
    const syncPromise = runBulkSync(options);

    // Run cleanup after sync completes (fire and forget)
    syncPromise
      .then(async () => {
        try {
          const expired = await markExpiredJobs();
          console.log(
            `[bulk-sync] Post-sync cleanup: ${expired} expired jobs marked inactive`,
          );
        } catch (err) {
          console.error("[bulk-sync] Post-sync cleanup failed:", err);
        }
      })
      .catch(() => {
        // Error already handled inside runBulkSync
      });

    return NextResponse.json({
      message: "Bulk sync started",
      progress: getBulkSyncProgress(),
    });
  } catch (error) {
    console.error("Failed to start bulk sync:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
