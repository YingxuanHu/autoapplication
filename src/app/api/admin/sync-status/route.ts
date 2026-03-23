import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { crawlQueue, JobStatus } from "@/lib/discovery/queue";
import { retryManager } from "@/lib/discovery/retry";
import { scheduler } from "@/lib/discovery/scheduler";
import { syncWorker } from "@/lib/discovery/worker";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/sync-status
 *
 * Comprehensive monitoring endpoint that returns:
 *  - Worker health & lifetime stats
 *  - Current queue state (depth, running, recent)
 *  - Scheduler state (company schedules, due counts)
 *  - Retry states for companies with failures
 *  - Recent crawl history from the database
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Worker stats ───────────────────────────────────────────────
    const workerStats = syncWorker.getStats();
    const recentEvents = syncWorker.getRecentEvents(30);

    // ── Queue state ────────────────────────────────────────────────
    const queueCounts = crawlQueue.getCounts();
    const runningJobs = crawlQueue.getRunningJobs().map((j) => ({
      id: j.id,
      companyId: j.companyId,
      domain: j.domain,
      type: j.type,
      startedAt: j.startedAt,
      attempts: j.attempts,
    }));
    const recentCompleted = crawlQueue.getRecentJobs(20);

    // ── Scheduler state ────────────────────────────────────────────
    const allSchedules = scheduler.getAllSchedules();
    const dueCompanies = scheduler.getDueCompanies();

    // Group schedules by interval tier for a summary
    const intervalSummary: Record<string, number> = {};
    for (const entry of allSchedules) {
      const key = `${entry.syncIntervalHours}h`;
      intervalSummary[key] = (intervalSummary[key] ?? 0) + 1;
    }

    // ── Retry states ───────────────────────────────────────────────
    const retryStates = retryManager.getAllStates().map((s) => ({
      companyId: s.companyId,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
      nextRetryAt: s.nextRetryAt ? new Date(s.nextRetryAt).toISOString() : null,
      exhausted: s.exhausted,
    }));

    // ── Recent crawl history from the database ─────────────────────
    const recentCrawls = await prisma.sourceCrawlRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
      include: {
        company: { select: { domain: true, name: true } },
      },
    });

    const crawlHistory = recentCrawls.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      domain: r.company.domain,
      companyName: r.company.name,
      status: r.status,
      jobsFound: r.jobsFound,
      jobsNew: r.jobsNew,
      jobsUpdated: r.jobsUpdated,
      jobsRemoved: r.jobsRemoved,
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }));

    return NextResponse.json({
      worker: {
        isRunning: workerStats.isRunning,
        startedAt: workerStats.startedAt,
        totalProcessed: workerStats.totalProcessed,
        totalSucceeded: workerStats.totalSucceeded,
        totalFailed: workerStats.totalFailed,
        avgDurationMs: workerStats.avgDurationMs,
        successRate: syncWorker.getSuccessRate(),
      },
      queue: {
        depth: queueCounts[JobStatus.QUEUED],
        running: queueCounts[JobStatus.RUNNING],
        completed: queueCounts[JobStatus.COMPLETED],
        failed: queueCounts[JobStatus.FAILED],
        runningJobs,
        recentCompleted: recentCompleted.map((j) => ({
          id: j.id,
          companyId: j.companyId,
          domain: j.domain,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          completedAt: j.completedAt,
          lastError: j.lastError,
        })),
      },
      scheduler: {
        totalScheduled: allSchedules.length,
        dueNow: dueCompanies.length,
        intervalSummary,
        dueCompanies: dueCompanies.slice(0, 20).map((e) => ({
          companyId: e.companyId,
          domain: e.domain,
          nextSyncAt: e.nextSyncAt.toISOString(),
          syncIntervalHours: e.syncIntervalHours,
          reason: e.reason,
        })),
      },
      retries: {
        activeRetries: retryStates.filter((s) => !s.exhausted).length,
        exhausted: retryStates.filter((s) => s.exhausted).length,
        states: retryStates,
      },
      recentCrawlHistory: crawlHistory,
      events: recentEvents.slice(0, 20),
    });
  } catch (error) {
    console.error("Failed to get sync status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
