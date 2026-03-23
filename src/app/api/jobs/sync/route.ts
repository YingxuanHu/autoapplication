import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncJobsToDb } from "@/lib/job-sources/aggregator";
import { markExpiredJobs } from "@/lib/job-sources/freshness";
import {
  getNorthAmericaPoolLocations,
  getNorthAmericaStemQueryPack,
} from "@/lib/jobs/stem-taxonomy";
import { jobSyncSchema } from "@/lib/validators/job";
import type { JobSource } from "@/types/index";

/**
 * Fast sources that respond in <5s — used for user-facing refresh.
 */
const FAST_SOURCES: JobSource[] = [
  "JSEARCH",
  "ADZUNA",
  "REMOTEOK",
  "ARBEITNOW",
  "HIMALAYAS",
  "REMOTIVE",
  "JOBICY",
  "LINKEDIN",
  "INDEED",
  "GLASSDOOR",
];

// Track background sync state
let backgroundSyncRunning = false;
let lastBackgroundSync: Date | null = null;

async function parseSyncBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/**
 * Run sync in background — does not block the response.
 * The user gets an immediate response with current DB job count.
 */
async function runBackgroundSync(
  userId: string,
  query: string,
  locations: string[],
  workMode: "REMOTE" | "HYBRID" | "ONSITE" | undefined,
  sources: JobSource[],
): Promise<void> {
  if (backgroundSyncRunning) return;
  backgroundSyncRunning = true;

  try {
    for (const location of locations) {
      await syncJobsToDb(userId, { query, location, locations, workMode }, sources);
    }
    await markExpiredJobs();
    lastBackgroundSync = new Date();
  } catch (err) {
    console.error("[sync] Background sync error:", err);
  } finally {
    backgroundSyncRunning = false;
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await parseSyncBody(request);
    const result = jobSyncSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten() },
        { status: 400 },
      );
    }

    let query = result.data.query;
    let location = result.data.location;
    let workMode = result.data.workMode;
    let profile = null;
    let locations: string[] | undefined;

    if (!query) {
      profile = await prisma.userProfile.findUnique({
        where: { userId: session.user.id },
      });
      query = profile?.jobTitles?.join(", ") || "";
      if (!query) {
        query = profile?.jobAreas?.join(", ") || "";
      }
    }

    if (!profile && (!location || !workMode)) {
      profile = await prisma.userProfile.findUnique({
        where: { userId: session.user.id },
      });
    }

    if (!workMode) {
      workMode = profile?.workModes[0];
    }

    if (location) {
      locations = [location];
    } else {
      locations = getNorthAmericaPoolLocations();
      location = locations[0];
    }

    if (!query) {
      query = getNorthAmericaStemQueryPack().join(", ");
    }

    const sourcesToUse = result.data.sources ?? FAST_SOURCES;

    // Get current job count for immediate response
    const totalJobs = await prisma.job.count({ where: { isActive: true } });

    // Start background sync — don't wait for it
    void runBackgroundSync(session.user.id, query, locations ?? [location], workMode, sourcesToUse);

    // Return immediately with current state
    return NextResponse.json({
      status: backgroundSyncRunning ? "syncing" : "started",
      message: "Sync started in background. Jobs will appear as they're fetched.",
      totalJobsAvailable: totalJobs,
      lastSync: lastBackgroundSync?.toISOString() ?? null,
      queryUsed: query,
      locationsUsed: locations ?? (location ? [location] : []),
    });
  } catch (error) {
    console.error("Failed to sync jobs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * GET: Check sync status and job count.
 * This is what the UI should poll to know when new jobs are available.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const totalJobs = await prisma.job.count({ where: { isActive: true } });

    return NextResponse.json({
      syncing: backgroundSyncRunning,
      totalJobsAvailable: totalJobs,
      lastSync: lastBackgroundSync?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Failed to get sync status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
