/**
 * Per-company crawl scheduler.
 *
 * Determines when each company is next due for a sync based on its source
 * type, crawl history, and reliability.  The schedule metadata lives in
 * memory (a Map) — the authoritative "last crawl time" comes from the
 * database (`source_crawl_runs`), so nothing important is lost on restart.
 *
 * Schedule intervals by source profile:
 *
 *   | Profile                         | Interval |
 *   |---------------------------------|----------|
 *   | Active ATS (Greenhouse, etc.)   |  6 hours |
 *   | Recently updated company sites  | 12 hours |
 *   | Stale / failing custom sites    | 48 hours |
 *   | Newly discovered companies      | immediate first crawl, then 24h |
 */

import type { ATSType, CrawlStatus, SourceType } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { crawlQueue, JobType, Priority } from "./queue";
import { retryManager } from "./retry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hours between crawls for different company profiles. */
export const SCHEDULE_INTERVALS = {
  /** Greenhouse, Lever, Ashby, SmartRecruiters — structured APIs. */
  ACTIVE_ATS: 6,
  /** Career pages that returned results recently. */
  RECENTLY_UPDATED: 12,
  /** Newly discovered companies get an immediate first crawl, then 24h. */
  NEW_COMPANY: 24,
  /** Sites that are stale or have a history of failures. */
  STALE_OR_FAILING: 48,
} as const;

/** ATS types that count as "active ATS" for scheduling purposes. */
const ACTIVE_ATS_TYPES: Set<string> = new Set([
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "SMARTRECRUITERS",
  "WORKABLE",
  "WORKDAY",
  "TEAMTAILOR",
  "RECRUITEE",
]);

// ---------------------------------------------------------------------------
// In-memory schedule metadata
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  companyId: string;
  domain: string;
  hasActiveSources: boolean;
  /** When the next sync should happen. */
  nextSyncAt: Date;
  /** The computed interval for this company (hours). */
  syncIntervalHours: number;
  /** Why this interval was chosen. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  /** In-memory schedule state, keyed by companyId. */
  private schedules: Map<string, ScheduleEntry> = new Map();

  // -----------------------------------------------------------------------
  // Interval calculation
  // -----------------------------------------------------------------------

  /**
   * Determine the appropriate crawl interval (in hours) for a company
   * based on its source types and crawl history.
   */
  classifyCompany(params: {
    detectedATS: ATSType | null;
    sources: Array<{ sourceType: SourceType; atsType: ATSType | null; isActive: boolean }>;
    lastSuccessAt: Date | null;
    crawlStatus: CrawlStatus;
    failCount: number;
  }): { intervalHours: number; reason: string } {
    if (params.sources.length === 0) {
      return {
        intervalHours: SCHEDULE_INTERVALS.NEW_COMPANY,
        reason: "No active sources discovered yet",
      };
    }

    // If the company has been failing repeatedly, slow down
    if (params.failCount >= 3 || params.crawlStatus === "FAILED") {
      return {
        intervalHours: SCHEDULE_INTERVALS.STALE_OR_FAILING,
        reason: "High failure rate — reduced crawl frequency",
      };
    }

    // Check if any active source uses a known ATS API
    const hasActiveATS = params.sources.some(
      (s) => s.isActive && s.atsType && ACTIVE_ATS_TYPES.has(s.atsType),
    );
    if (hasActiveATS) {
      return {
        intervalHours: SCHEDULE_INTERVALS.ACTIVE_ATS,
        reason: "Active ATS source (structured API)",
      };
    }

    // Never been successfully crawled — treat as new
    if (!params.lastSuccessAt) {
      return {
        intervalHours: SCHEDULE_INTERVALS.NEW_COMPANY,
        reason: "Newly discovered — needs first successful crawl",
      };
    }

    // Check staleness: if last success was more than 7 days ago, slow down
    const daysSinceSuccess =
      (Date.now() - params.lastSuccessAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSuccess > 7) {
      return {
        intervalHours: SCHEDULE_INTERVALS.STALE_OR_FAILING,
        reason: `Stale — last success ${Math.round(daysSinceSuccess)} days ago`,
      };
    }

    // Default: recently updated company site
    return {
      intervalHours: SCHEDULE_INTERVALS.RECENTLY_UPDATED,
      reason: "Recently updated company site",
    };
  }

  // -----------------------------------------------------------------------
  // Schedule management
  // -----------------------------------------------------------------------

  /**
   * Load all active companies from the database, compute their next sync
   * time, and populate the in-memory schedule map.
   */
  async refreshSchedules(): Promise<number> {
    const companies = await prisma.company.findMany({
      where: {
        isActive: true,
      },
      include: {
        sources: {
          where: { isActive: true },
          select: {
            sourceType: true,
            atsType: true,
            isActive: true,
            failCount: true,
          },
        },
      },
    });

    let scheduled = 0;

    for (const company of companies) {
      // Skip companies whose retries are exhausted
      if (retryManager.isExhausted(company.id)) continue;

      const totalFailCount = company.sources.reduce(
        (sum, s) => sum + s.failCount,
        0,
      );

      const { intervalHours, reason } = this.classifyCompany({
        detectedATS: company.detectedATS,
        sources: company.sources,
        lastSuccessAt: company.lastSuccessAt,
        crawlStatus: company.crawlStatus,
        failCount: totalFailCount,
      });

      // Calculate next sync time based on last sync + interval
      let nextSyncAt: Date;
      if (!company.lastSyncAt) {
        // Never synced — schedule immediately
        nextSyncAt = new Date();
      } else {
        nextSyncAt = new Date(
          company.lastSyncAt.getTime() + intervalHours * 60 * 60 * 1000,
        );
      }

      const entry: ScheduleEntry = {
        companyId: company.id,
        domain: company.domain,
        hasActiveSources: company.sources.length > 0,
        nextSyncAt,
        syncIntervalHours: intervalHours,
        reason,
      };

      this.schedules.set(company.id, entry);
      scheduled++;
    }

    return scheduled;
  }

  /**
   * Get all companies whose nextSyncAt is in the past (i.e. they are due
   * for a crawl), sorted by how overdue they are (most overdue first).
   */
  getDueCompanies(): ScheduleEntry[] {
    const now = new Date();
    const due: ScheduleEntry[] = [];

    for (const entry of this.schedules.values()) {
      if (entry.nextSyncAt <= now) {
        due.push(entry);
      }
    }

    // Most overdue first
    due.sort(
      (a, b) => a.nextSyncAt.getTime() - b.nextSyncAt.getTime(),
    );

    return due;
  }

  /**
   * Enqueue all due companies into the crawl queue.
   * Respects deduplication — companies already in the queue are skipped.
   *
   * @returns Number of jobs actually enqueued.
   */
  async enqueueDueCompanies(): Promise<number> {
    await this.refreshSchedules();
    const due = this.getDueCompanies();
    let enqueued = 0;

    for (const entry of due) {
      // Companies without active sources need discovery before crawl.
      const requiresDiscovery =
        !entry.hasActiveSources ||
        entry.reason.includes("Newly discovered") ||
        entry.reason.includes("No active sources");
      const jobType = requiresDiscovery ? JobType.SYNC : JobType.CRAWL;

      // Determine priority based on interval
      let priority = Priority.NORMAL;
      if (entry.syncIntervalHours <= SCHEDULE_INTERVALS.ACTIVE_ATS) {
        priority = Priority.HIGH;
      } else if (entry.syncIntervalHours >= SCHEDULE_INTERVALS.STALE_OR_FAILING) {
        priority = Priority.LOW;
      }

      const job = crawlQueue.enqueue({
        companyId: entry.companyId,
        domain: entry.domain,
        type: jobType,
        priority,
        metadata: {
          scheduledInterval: entry.syncIntervalHours,
          reason: entry.reason,
          hasActiveSources: entry.hasActiveSources,
        },
      });

      if (job) enqueued++;
    }

    return enqueued;
  }

  // -----------------------------------------------------------------------
  // Post-crawl updates
  // -----------------------------------------------------------------------

  /**
   * Update the schedule after a crawl completes (success or failure).
   * On success: reset interval and push nextSyncAt forward.
   * On failure: the retry manager handles re-queuing; we just bump the
   * interval if failures are accumulating.
   */
  updateAfterCrawl(
    companyId: string,
    success: boolean,
  ): void {
    const existing = this.schedules.get(companyId);
    if (!existing) return;

    if (success) {
      // Recompute on next refreshSchedules(); for now just push forward
      existing.nextSyncAt = new Date(
        Date.now() + existing.syncIntervalHours * 60 * 60 * 1000,
      );
    } else {
      // After failure, the retry manager handles re-queuing with backoff.
      // We increase the interval so the scheduler doesn't pile on.
      const retryState = retryManager.getState(companyId);
      if (retryState?.exhausted) {
        // Max retries hit — move to the slowest tier
        existing.syncIntervalHours = SCHEDULE_INTERVALS.STALE_OR_FAILING;
        existing.reason = "Retries exhausted — reduced to minimum frequency";
      }

      existing.nextSyncAt = new Date(
        Date.now() + existing.syncIntervalHours * 60 * 60 * 1000,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Get the schedule entry for a single company. */
  getSchedule(companyId: string): ScheduleEntry | undefined {
    return this.schedules.get(companyId);
  }

  /** Get all schedule entries. */
  getAllSchedules(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /** How many companies are currently tracked. */
  get size(): number {
    return this.schedules.size;
  }

  /** Clear all schedules (useful in tests). */
  clear(): void {
    this.schedules.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared singleton
// ---------------------------------------------------------------------------

export const scheduler = new Scheduler();
