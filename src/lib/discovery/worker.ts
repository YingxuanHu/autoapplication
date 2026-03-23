/**
 * Background worker that drains the crawl queue and runs discovery/sync
 * jobs for each company.
 *
 * The worker is event-driven: it wakes up when the queue signals that
 * work is available (via `queue.setOnReady`) and processes jobs up to
 * the concurrency limit.  Between ticks it idles with zero CPU usage.
 *
 * Stats are tracked in memory for the monitoring API.
 */

import { crawlQueue, JobType, type QueueJob } from "./queue";
import { retryManager } from "./retry";
import { scheduler } from "./scheduler";
import { syncCompanyJobs, type SyncStats } from "./sync-engine";
import { discoverCompany } from "./company-discovery";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerStats {
  /** Total jobs processed since the worker started. */
  totalProcessed: number;
  /** Total jobs that completed successfully. */
  totalSucceeded: number;
  /** Total jobs that failed (after exhausting retries, they count once). */
  totalFailed: number;
  /** Sum of all job durations in ms — divide by totalProcessed for avg. */
  totalDurationMs: number;
  /** Timestamp when the worker was started. */
  startedAt: string | null;
  /** Whether the worker loop is currently running. */
  isRunning: boolean;
}

export interface WorkerEvent {
  type: "job_start" | "job_complete" | "job_fail" | "worker_start" | "worker_stop";
  jobId?: string;
  companyId?: string;
  domain?: string;
  jobType?: JobType;
  durationMs?: number;
  error?: string;
  stats?: SyncStats;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class SyncWorker {
  private stats: WorkerStats = {
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalDurationMs: 0,
    startedAt: null,
    isRunning: false,
  };

  /** Recent events for the monitoring API (ring buffer, newest first). */
  private eventLog: WorkerEvent[] = [];
  private maxEventLogSize = 200;

  /** Whether the worker is currently processing a tick. */
  private processing = false;

  /** Optional listener for events (useful for tests or external monitoring). */
  private eventListener?: (event: WorkerEvent) => void;

  /** Interval handle for the periodic scheduler tick. */
  private schedulerInterval?: ReturnType<typeof setInterval>;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the worker.  Hooks into the queue's onReady signal and begins
   * a periodic scheduler tick that enqueues due companies.
   *
   * @param schedulerTickMs How often (ms) the scheduler checks for due
   *   companies.  Defaults to 5 minutes.
   */
  start(schedulerTickMs = 5 * 60 * 1000): void {
    if (this.stats.isRunning) return;

    this.stats.isRunning = true;
    this.stats.startedAt = new Date().toISOString();

    // Wire up the queue to wake us when work is available
    crawlQueue.setOnReady(() => this.tick());

    // Periodic scheduler: check for due companies and enqueue them
    this.schedulerInterval = setInterval(async () => {
      try {
        const enqueued = await scheduler.enqueueDueCompanies();
        if (enqueued > 0) {
          console.log(`[worker] Scheduler enqueued ${enqueued} due companies`);
        }
      } catch (err) {
        console.error(
          "[worker] Scheduler tick failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }, schedulerTickMs);

    this.emit({
      type: "worker_start",
      timestamp: new Date().toISOString(),
    });

    console.log("[worker] Sync worker started");

    // Run an initial tick in case there's already work in the queue
    void this.tick();
  }

  /**
   * Stop the worker.  Cancels the scheduler interval and disconnects
   * from the queue.  Running jobs are NOT cancelled — they will finish
   * but their completion won't trigger new work.
   */
  stop(): void {
    if (!this.stats.isRunning) return;

    this.stats.isRunning = false;

    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = undefined;
    }

    crawlQueue.setOnReady(() => {});

    this.emit({
      type: "worker_stop",
      timestamp: new Date().toISOString(),
    });

    console.log("[worker] Sync worker stopped");
  }

  // -----------------------------------------------------------------------
  // Core processing loop
  // -----------------------------------------------------------------------

  /**
   * Try to dequeue and process jobs until the queue is empty or the
   * concurrency limit is reached.  This is safe to call multiple times
   * concurrently — only one tick runs at a time, and each tick drains
   * as many jobs as the concurrency allows.
   */
  private async tick(): Promise<void> {
    if (!this.stats.isRunning) return;
    if (this.processing) return;

    this.processing = true;

    try {
      // Keep pulling jobs while slots are available
      let job = crawlQueue.dequeue();
      while (job) {
        // Fire-and-forget: run the job in the background so we can
        // dequeue more jobs up to the concurrency limit.
        void this.processJob(job);
        job = crawlQueue.dequeue();
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute a single queue job end-to-end.
   */
  private async processJob(job: QueueJob): Promise<void> {
    const startTime = Date.now();

    this.emit({
      type: "job_start",
      jobId: job.id,
      companyId: job.companyId,
      domain: job.domain,
      jobType: job.type,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[worker] Processing ${job.type} job ${job.id} for company ` +
      `${job.companyId}${job.domain ? ` (${job.domain})` : ""}`,
    );

    try {
      let syncStats: SyncStats | undefined;

      switch (job.type) {
        case JobType.DISCOVER: {
          // Run discovery only — creates sources but doesn't sync jobs
          if (!job.domain) {
            throw new Error("DISCOVER jobs require a domain");
          }
          await discoverCompany(job.domain);
          break;
        }

        case JobType.CRAWL: {
          // Crawl known sources and upsert jobs
          syncStats = await syncCompanyJobs(job.companyId);
          break;
        }

        case JobType.SYNC: {
          // Full pipeline: discover then crawl
          if (job.domain) {
            await discoverCompany(job.domain);
          }
          syncStats = await syncCompanyJobs(job.companyId);
          break;
        }
      }

      // Mark success
      const durationMs = Date.now() - startTime;
      crawlQueue.complete(job.id);
      retryManager.handleSuccess(job.companyId);
      scheduler.updateAfterCrawl(job.companyId, true);

      this.stats.totalProcessed++;
      this.stats.totalSucceeded++;
      this.stats.totalDurationMs += durationMs;

      this.emit({
        type: "job_complete",
        jobId: job.id,
        companyId: job.companyId,
        domain: job.domain,
        jobType: job.type,
        durationMs,
        stats: syncStats,
        timestamp: new Date().toISOString(),
      });

      console.log(
        `[worker] Completed ${job.type} job ${job.id} in ${durationMs}ms` +
        (syncStats ? ` — found=${syncStats.jobsFound} new=${syncStats.jobsNew}` : ""),
      );
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      crawlQueue.fail(job.id, errorMessage);

      // Let the retry manager decide whether to re-enqueue
      const retryState = retryManager.handleFailure(job, errorMessage);
      scheduler.updateAfterCrawl(job.companyId, false);

      this.stats.totalProcessed++;
      this.stats.totalFailed++;
      this.stats.totalDurationMs += durationMs;

      this.emit({
        type: "job_fail",
        jobId: job.id,
        companyId: job.companyId,
        domain: job.domain,
        jobType: job.type,
        durationMs,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });

      console.error(
        `[worker] Failed ${job.type} job ${job.id}: ${errorMessage}` +
        (retryState.exhausted ? " (retries exhausted)" : ` (retry ${retryState.consecutiveFailures})`),
      );
    }

    // After finishing a job, trigger another tick in case more work
    // is waiting (the onReady callback fires on enqueue/complete/fail,
    // but we call tick explicitly to avoid race conditions).
    void this.tick();
  }

  // -----------------------------------------------------------------------
  // Events & monitoring
  // -----------------------------------------------------------------------

  /** Register a listener for worker events. */
  onEvent(listener: (event: WorkerEvent) => void): void {
    this.eventListener = listener;
  }

  private emit(event: WorkerEvent): void {
    this.eventLog.unshift(event);
    if (this.eventLog.length > this.maxEventLogSize) {
      this.eventLog.length = this.maxEventLogSize;
    }
    this.eventListener?.(event);
  }

  /** Get a snapshot of worker stats. */
  getStats(): WorkerStats & { avgDurationMs: number } {
    return {
      ...this.stats,
      avgDurationMs:
        this.stats.totalProcessed > 0
          ? Math.round(this.stats.totalDurationMs / this.stats.totalProcessed)
          : 0,
    };
  }

  /** Get recent events (newest first). */
  getRecentEvents(limit = 50): WorkerEvent[] {
    return this.eventLog.slice(0, limit);
  }

  /** Success rate as a percentage (0-100). */
  getSuccessRate(): number {
    if (this.stats.totalProcessed === 0) return 100;
    return Math.round(
      (this.stats.totalSucceeded / this.stats.totalProcessed) * 100,
    );
  }

  /** Reset stats — mainly for tests. */
  resetStats(): void {
    this.stats = {
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      totalDurationMs: 0,
      startedAt: this.stats.startedAt,
      isRunning: this.stats.isRunning,
    };
    this.eventLog = [];
  }
}

// ---------------------------------------------------------------------------
// Shared singleton
// ---------------------------------------------------------------------------

export const syncWorker = new SyncWorker();
