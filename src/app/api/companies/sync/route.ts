import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { crawlQueue, JobType, Priority } from "@/lib/discovery/queue";
import { scheduler } from "@/lib/discovery/scheduler";
import { ensureDiscoveryWorkerStarted } from "@/lib/discovery/bootstrap";
import { syncWorker } from "@/lib/discovery/worker";
import { seedAllCategories } from "@/lib/discovery/company-lists";

async function parseSyncBody(request: Request): Promise<{ force?: boolean }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return (await request.json()) as { force?: boolean };
  } catch {
    return {};
  }
}

/**
 * Only enqueue companies with verified ATS board sources (Greenhouse, Lever, Ashby, etc.)
 * These are fast (~1-2s each). Skip custom site crawls (30s+ timeouts, low yield).
 */
async function enqueueATSCompanies(): Promise<number> {
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      sources: {
        some: {
          isActive: true,
          sourceType: "ATS_BOARD",
          boardToken: { not: null },
        },
      },
    },
    select: {
      id: true,
      domain: true,
      lastSyncAt: true,
    },
  });

  let enqueued = 0;

  for (const company of companies) {
    const job = crawlQueue.enqueue({
      companyId: company.id,
      domain: company.domain,
      type: JobType.CRAWL,
      priority: Priority.HIGH,
      metadata: {
        reason: "ATS board refresh",
        atsOnly: true,
      },
    });

    if (job) enqueued++;
  }

  return enqueued;
}

/**
 * POST /api/companies/sync
 *
 * Trigger a full sync cycle: refresh schedules, enqueue all companies
 * that are due for a crawl, and ensure the background worker is running.
 *
 * This is idempotent — calling it multiple times won't duplicate work
 * because the queue deduplicates by companyId.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await parseSyncBody(request);

    ensureDiscoveryWorkerStarted();

    let bootstrapSummary:
      | { created: number; skipped: number; sourcesCreated: number }
      | null = null;
    bootstrapSummary = await seedAllCategories();

    const enqueued = body.force
      ? await enqueueATSCompanies()
      : await scheduler.enqueueDueCompanies();

    const counts = crawlQueue.getCounts();

    return NextResponse.json({
      message: body.force
        ? `Manual refresh started — ${enqueued} companies enqueued`
        : `Sync cycle started — ${enqueued} companies enqueued`,
      bootstrap: bootstrapSummary,
      forced: Boolean(body.force),
      enqueued,
      queue: {
        queued: counts.QUEUED,
        running: counts.RUNNING,
        completed: counts.COMPLETED,
        failed: counts.FAILED,
      },
      worker: {
        isRunning: syncWorker.getStats().isRunning,
        successRate: syncWorker.getSuccessRate(),
      },
    });
  } catch (error) {
    console.error("Failed to trigger sync:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/companies/sync
 *
 * Return the current sync status: queue depth, running jobs, recent
 * results, and worker health.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    ensureDiscoveryWorkerStarted();

    const stats = syncWorker.getStats();
    const counts = crawlQueue.getCounts();
    const runningJobs = crawlQueue.getRunningJobs().map((j) => ({
      id: j.id,
      companyId: j.companyId,
      domain: j.domain,
      type: j.type,
      startedAt: j.startedAt,
    }));
    const recentJobs = crawlQueue.getRecentJobs(20).map((j) => ({
      id: j.id,
      companyId: j.companyId,
      domain: j.domain,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      completedAt: j.completedAt,
      lastError: j.lastError,
    }));

    return NextResponse.json({
      worker: {
        isRunning: stats.isRunning,
        startedAt: stats.startedAt,
        totalProcessed: stats.totalProcessed,
        totalSucceeded: stats.totalSucceeded,
        totalFailed: stats.totalFailed,
        avgDurationMs: stats.avgDurationMs,
        successRate: syncWorker.getSuccessRate(),
      },
      queue: {
        depth: counts.QUEUED,
        running: counts.RUNNING,
        completed: counts.COMPLETED,
        failed: counts.FAILED,
      },
      runningJobs,
      recentJobs,
      scheduledCompanies: scheduler.size,
    });
  } catch (error) {
    console.error("Failed to get sync status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
