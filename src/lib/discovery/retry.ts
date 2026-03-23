/**
 * Exponential backoff with jitter for failed crawl jobs.
 *
 * Tracks per-company retry state in memory and integrates with the
 * queue to decide whether a failed job should be re-enqueued or
 * permanently marked as FAILED.
 */

import { crawlQueue, Priority, type QueueJob } from "./queue";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of attempts before giving up. */
  maxRetries: number;
  /** Base delay in milliseconds for the first retry. */
  baseDelayMs: number;
  /** Hard cap on any single delay. */
  maxDelayMs: number;
  /** Jitter factor: 0 = no jitter, 1 = full jitter (0-100% of delay). */
  jitterFactor: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 30_000, // 30 seconds
  maxDelayMs: 30 * 60_000, // 30 minutes
  jitterFactor: 0.5,
};

// ---------------------------------------------------------------------------
// Per-company retry state
// ---------------------------------------------------------------------------

export interface RetryState {
  companyId: string;
  /** How many consecutive failures we have seen. */
  consecutiveFailures: number;
  /** Timestamp (ms) of the last failure. */
  lastFailureAt: number;
  /** Timestamp (ms) at which the next retry is allowed. */
  nextRetryAt: number;
  /** The last error message. */
  lastError?: string;
  /** True when max retries exhausted — caller should reduce crawl frequency. */
  exhausted: boolean;
}

// ---------------------------------------------------------------------------
// RetryManager
// ---------------------------------------------------------------------------

export class RetryManager {
  private state: Map<string, RetryState> = new Map();
  private config: RetryConfig;

  /** Pending retry timers so they can be cancelled on reset/shutdown. */
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Calculate the delay for a given attempt number using exponential
   * backoff with jitter.
   *
   * delay = min(baseDelay * 2^attempt, maxDelay) * (1 - jitter + rand*jitter)
   */
  calculateDelay(attempt: number): number {
    const exponential = this.config.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.config.maxDelayMs);

    // Add jitter: value in [capped * (1 - jitter), capped]
    const jitter = this.config.jitterFactor * Math.random();
    return Math.round(capped * (1 - jitter));
  }

  /**
   * Handle a failed job.  Decides whether to schedule a retry or give up.
   *
   * @returns The retry state for the company, including whether retries
   *          are exhausted.
   */
  handleFailure(job: QueueJob, error: string): RetryState {
    const existing = this.state.get(job.companyId);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;

    const now = Date.now();

    // Have we exhausted retries?
    if (failures >= this.config.maxRetries) {
      const retryState: RetryState = {
        companyId: job.companyId,
        consecutiveFailures: failures,
        lastFailureAt: now,
        nextRetryAt: 0, // won't retry
        lastError: error,
        exhausted: true,
      };
      this.state.set(job.companyId, retryState);

      console.warn(
        `[retry] Company ${job.companyId} exhausted ${this.config.maxRetries} retries. ` +
        `Last error: ${error}`,
      );

      return retryState;
    }

    // Schedule a retry with backoff
    const delayMs = this.calculateDelay(failures - 1);
    const nextRetryAt = now + delayMs;

    const retryState: RetryState = {
      companyId: job.companyId,
      consecutiveFailures: failures,
      lastFailureAt: now,
      nextRetryAt,
      lastError: error,
      exhausted: false,
    };
    this.state.set(job.companyId, retryState);

    console.log(
      `[retry] Scheduling retry ${failures}/${this.config.maxRetries} for ` +
      `company ${job.companyId} in ${Math.round(delayMs / 1000)}s`,
    );

    // Set a timer to re-enqueue the job after the delay
    this.clearTimer(job.companyId);
    const timer = setTimeout(() => {
      this.timers.delete(job.companyId);

      crawlQueue.enqueue({
        companyId: job.companyId,
        domain: job.domain,
        type: job.type,
        // Demote priority after repeated failures
        priority: failures >= 3 ? Priority.LOW : Priority.NORMAL,
        metadata: {
          ...job.metadata,
          retryAttempt: failures,
        },
      });
    }, delayMs);

    this.timers.set(job.companyId, timer);

    return retryState;
  }

  /**
   * Call after a successful crawl to reset the failure counter for a company.
   */
  handleSuccess(companyId: string): void {
    this.state.delete(companyId);
    this.clearTimer(companyId);
  }

  /**
   * Check whether a company's retries are exhausted.
   */
  isExhausted(companyId: string): boolean {
    return this.state.get(companyId)?.exhausted ?? false;
  }

  /**
   * Get the current retry state for a company (if any).
   */
  getState(companyId: string): RetryState | undefined {
    return this.state.get(companyId);
  }

  /**
   * Get all retry states — useful for monitoring.
   */
  getAllStates(): RetryState[] {
    return Array.from(this.state.values());
  }

  /**
   * Clear all state and cancel pending timers.
   */
  reset(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.state.clear();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private clearTimer(companyId: string): void {
    const existing = this.timers.get(companyId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(companyId);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared singleton
// ---------------------------------------------------------------------------

export const retryManager = new RetryManager();
