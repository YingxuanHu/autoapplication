/**
 * In-memory priority queue for company discovery/sync crawl jobs.
 *
 * Designed to be swapped out for Redis + BullMQ later without changing
 * the public API surface.  For now everything lives in process memory,
 * so a restart loses queued (but not completed) work.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of work a queue job represents. */
export enum JobType {
  /** Discover career pages / ATS for a brand-new company. */
  DISCOVER = "DISCOVER",
  /** Crawl known sources and upsert jobs for an existing company. */
  CRAWL = "CRAWL",
  /** Full re-sync: discovery + crawl in one pass. */
  SYNC = "SYNC",
}

/** Priority bucket — lower numeric value = higher priority. */
export enum Priority {
  HIGH = 0,
  NORMAL = 1,
  LOW = 2,
}

/** Lifecycle states a job passes through. */
export enum JobStatus {
  QUEUED = "QUEUED",
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

/** A single unit of work in the queue. */
export interface QueueJob {
  /** Unique queue-level id (auto-generated). */
  id: string;
  /** Which company this job targets. */
  companyId: string;
  /** Optional domain — handy for logging / dedup of DISCOVER jobs. */
  domain?: string;
  /** What kind of work to do. */
  type: JobType;
  /** Scheduling priority. */
  priority: Priority;
  /** Current lifecycle state. */
  status: JobStatus;
  /** How many times this job has been attempted. */
  attempts: number;
  /** ISO-8601 timestamp when the job was enqueued. */
  createdAt: string;
  /** ISO-8601 timestamp when the job started running (if applicable). */
  startedAt?: string;
  /** ISO-8601 timestamp when the job finished (success or failure). */
  completedAt?: string;
  /** Error message from the last failed attempt. */
  lastError?: string;
  /** Arbitrary metadata the caller can attach. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Queue implementation
// ---------------------------------------------------------------------------

let jobCounter = 0;

function nextId(): string {
  jobCounter++;
  return `job_${Date.now()}_${jobCounter}`;
}

function getQueueConcurrency(defaultConcurrency = 3): number {
  const raw = Number.parseInt(process.env.DISCOVERY_QUEUE_CONCURRENCY ?? "", 10);
  if (Number.isNaN(raw) || raw <= 0) return defaultConcurrency;
  return Math.min(raw, 32);
}

/**
 * In-memory priority queue with:
 *  - Job deduplication (one active job per companyId)
 *  - Concurrency control (max N concurrent jobs)
 *  - Priority ordering (HIGH before NORMAL before LOW)
 */
export class CrawlQueue {
  /** All jobs ever enqueued in this process lifetime. */
  private jobs: Map<string, QueueJob> = new Map();

  /**
   * Set of companyIds that currently have an active (QUEUED | RUNNING) job.
   * Used for deduplication — we never queue two jobs for the same company.
   */
  private activeCompanies: Set<string> = new Set();

  /** Maximum number of jobs that can be RUNNING at the same time. */
  private maxConcurrency: number;

  /** Callback invoked whenever a slot opens up and work is available. */
  private onReady?: () => void;

  constructor(maxConcurrency = 3) {
    this.maxConcurrency = maxConcurrency;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Register a callback that fires whenever the queue might have work
   * available (i.e. a job was enqueued or a running job finished).
   */
  setOnReady(cb: () => void): void {
    this.onReady = cb;
  }

  /**
   * Add a job to the queue.  Returns the job if enqueued, or `null` if the
   * company already has an active (QUEUED/RUNNING) job (dedup).
   */
  enqueue(params: {
    companyId: string;
    domain?: string;
    type: JobType;
    priority?: Priority;
    metadata?: Record<string, unknown>;
  }): QueueJob | null {
    // Dedup: skip if this company already has an active job
    if (this.activeCompanies.has(params.companyId)) {
      return null;
    }

    const job: QueueJob = {
      id: nextId(),
      companyId: params.companyId,
      domain: params.domain,
      type: params.type,
      priority: params.priority ?? Priority.NORMAL,
      status: JobStatus.QUEUED,
      attempts: 0,
      createdAt: new Date().toISOString(),
      metadata: params.metadata,
    };

    this.jobs.set(job.id, job);
    this.activeCompanies.add(params.companyId);

    // Notify the worker that there may be work to do
    this.onReady?.();

    return job;
  }

  /**
   * Dequeue the highest-priority QUEUED job and mark it RUNNING.
   * Returns `null` when no work is available or concurrency limit is hit.
   */
  dequeue(): QueueJob | null {
    // Check concurrency
    const runningCount = this.getRunningCount();
    if (runningCount >= this.maxConcurrency) {
      return null;
    }

    // Find the highest-priority queued job
    const queued = this.getQueuedJobs();
    if (queued.length === 0) {
      return null;
    }

    // Sort: lower priority number = higher priority, then by createdAt (FIFO)
    queued.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });

    const job = queued[0];
    job.status = JobStatus.RUNNING;
    job.startedAt = new Date().toISOString();
    job.attempts++;

    return job;
  }

  /**
   * Mark a job as completed successfully.
   * Frees the company slot so it can be re-queued later.
   */
  complete(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = JobStatus.COMPLETED;
    job.completedAt = new Date().toISOString();
    this.activeCompanies.delete(job.companyId);

    // Notify — a slot opened up
    this.onReady?.();
  }

  /**
   * Mark a job as failed.
   * Frees the company slot so the retry system can re-enqueue it.
   */
  fail(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = JobStatus.FAILED;
    job.completedAt = new Date().toISOString();
    job.lastError = error;
    this.activeCompanies.delete(job.companyId);

    // Notify — a slot opened up
    this.onReady?.();
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Number of jobs currently in RUNNING state. */
  getRunningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === JobStatus.RUNNING) count++;
    }
    return count;
  }

  /** All QUEUED jobs (not yet started). */
  getQueuedJobs(): QueueJob[] {
    const result: QueueJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === JobStatus.QUEUED) result.push(job);
    }
    return result;
  }

  /** All RUNNING jobs. */
  getRunningJobs(): QueueJob[] {
    const result: QueueJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === JobStatus.RUNNING) result.push(job);
    }
    return result;
  }

  /** Number of jobs sitting in the queue waiting to run. */
  getQueueDepth(): number {
    return this.getQueuedJobs().length;
  }

  /** True if this company already has a QUEUED or RUNNING job. */
  hasActiveJob(companyId: string): boolean {
    return this.activeCompanies.has(companyId);
  }

  /** Get a specific job by id. */
  getJob(jobId: string): QueueJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Return recently completed / failed jobs (most recent first).
   * Useful for the status API.
   */
  getRecentJobs(limit = 50): QueueJob[] {
    const finished: QueueJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) {
        finished.push(job);
      }
    }
    finished.sort(
      (a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
    );
    return finished.slice(0, limit);
  }

  /** Total counts by status — handy for dashboards. */
  getCounts(): Record<JobStatus, number> {
    const counts: Record<JobStatus, number> = {
      [JobStatus.QUEUED]: 0,
      [JobStatus.RUNNING]: 0,
      [JobStatus.COMPLETED]: 0,
      [JobStatus.FAILED]: 0,
    };
    for (const job of this.jobs.values()) {
      counts[job.status]++;
    }
    return counts;
  }

  /** Clear completed / failed jobs older than `maxAgeMs`. */
  prune(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, job] of this.jobs) {
      if (
        (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) &&
        job.completedAt &&
        new Date(job.completedAt).getTime() < cutoff
      ) {
        this.jobs.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /** Hard reset — mainly useful in tests. */
  clear(): void {
    this.jobs.clear();
    this.activeCompanies.clear();
    jobCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// Shared singleton
// ---------------------------------------------------------------------------

export const crawlQueue = new CrawlQueue(getQueueConcurrency());
