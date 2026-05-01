import { prisma } from "@/lib/db";
import {
  isCompanySourceManagedConnector,
  routeLegacyScheduledConnectorToCompanySource,
} from "@/lib/ingestion/legacy-source-routing";
import {
  bulkSyncCanonicalStatuses,
  ingestConnector,
  recoverStaleRunningIngestionRuns,
} from "@/lib/ingestion/pipeline";
import { getScheduledConnectors } from "@/lib/ingestion/registry";
import type { IngestionSummary } from "@/lib/ingestion/types";

export type ScheduledIngestionResult = {
  startedAt: string;
  executedRuns: IngestionSummary[];
  skippedConnectors: Array<{
    connectorKey: string;
    sourceName: string;
    reason: "not_due" | "managed_by_company_source" | "cycle_budget_exhausted";
    nextEligibleAt: string | null;
    lastRunStartedAt: string | null;
    origin: "legacy_registry";
    companySourceId?: string;
    taskKind?: "SOURCE_VALIDATION" | "CONNECTOR_POLL";
  }>;
  lifecycle: {
    liveCount: number;
    agingCount?: number;
    staleCount: number;
    expiredCount: number;
    removedCount: number;
    updatedCount: number;
    deferred?: boolean;
  };
};

const DEFAULT_LEGACY_CONNECTOR_RUNTIME_BUDGET_MS = 60_000;
const DEFAULT_ADZUNA_RUNTIME_BUDGET_MS = 45_000;
// Hard wall-clock cap per connector: even if the internal AbortController is
// ignored (e.g. Playwright IPC hangs), this Promise.race fires and lets the
// scheduler move on. Set to 2× the soft budget plus a generous buffer.
const LEGACY_CONNECTOR_HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes absolute max

function getLegacyConnectorRuntimeBudgetMs(sourceName: string) {
  const connectorFamily = sourceName.split(":")[0]?.toLowerCase();
  const adzunaBudgetOverride = Number.parseInt(
    process.env.ADZUNA_RUNTIME_BUDGET_MS ?? "",
    10
  );
  const adzunaRuntimeBudgetMs =
    Number.isFinite(adzunaBudgetOverride) && adzunaBudgetOverride > 0
      ? adzunaBudgetOverride
      : DEFAULT_ADZUNA_RUNTIME_BUDGET_MS;

  if (connectorFamily === "adzuna") {
    return adzunaRuntimeBudgetMs;
  }

  return DEFAULT_LEGACY_CONNECTOR_RUNTIME_BUDGET_MS;
}

async function countCanonicalStatusSnapshot() {
  const [liveCount, agingCount, staleCount, expiredCount, removedCount] = await Promise.all([
    prisma.jobCanonical.count({ where: { status: "LIVE" } }),
    prisma.jobCanonical.count({ where: { status: "AGING" } }),
    prisma.jobCanonical.count({ where: { status: "STALE" } }),
    prisma.jobCanonical.count({ where: { status: "EXPIRED" } }),
    prisma.jobCanonical.count({ where: { status: "REMOVED" } }),
  ]);

  return {
    liveCount,
    agingCount,
    staleCount,
    expiredCount,
    removedCount,
    updatedCount: 0,
    deferred: true,
  };
}

/**
 * Race a connector invocation against a hard wall-clock deadline.
 * Returns the summary on success; throws on error or timeout.
 */
function withHardTimeout<T>(
  promise: Promise<T>,
  connectorKey: string,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `[scheduler] Connector ${connectorKey} exceeded hard timeout of ${timeoutMs}ms — forcibly abandoned`
        )
      );
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function runScheduledIngestion(options: {
  now?: Date;
  force?: boolean;
  connectorKeys?: string[];
  triggerLabel?: string;
  maxCycleDurationMs?: number;
  maxConnectorRuns?: number;
  skipLifecycle?: boolean;
  lifecyclePerJobLimit?: number;
} = {}): Promise<ScheduledIngestionResult> {
  const now = options.now ?? new Date();
  const staleRunRecovery = await recoverStaleRunningIngestionRuns({
    now,
    connectorKeys: options.connectorKeys,
  });
  if (staleRunRecovery.recoveredCount > 0) {
    console.log(
      `[scheduler] Recovered ${staleRunRecovery.recoveredCount} stale RUNNING ingestion run(s): ${staleRunRecovery.connectorKeys.join(", ")}`
    );
  }
  const allDefinitions = getScheduledConnectors().filter((definition) => {
    if (!options.connectorKeys || options.connectorKeys.length === 0) return true;
    return options.connectorKeys.includes(definition.connector.key);
  });

  // Run legacy-only connectors (aggregator feeds, job boards) FIRST.
  // There are only ~14 of these but they contribute 80k+ jobs. Without this
  // priority ordering, they never run because the 1,300+ managed ATS connectors
  // exhaust the cycle budget before the aggregator feeds get a turn.
  const scheduledDefinitions = [
    ...allDefinitions.filter(
      (d) => !isCompanySourceManagedConnector(d.connector.sourceName)
    ),
    ...allDefinitions.filter((d) =>
      isCompanySourceManagedConnector(d.connector.sourceName)
    ),
  ];

  const executedRuns: IngestionSummary[] = [];
  const skippedConnectors: ScheduledIngestionResult["skippedConnectors"] = [];

  for (const definition of scheduledDefinitions) {
    if (
      typeof options.maxConnectorRuns === "number" &&
      executedRuns.length >= options.maxConnectorRuns
    ) {
      skippedConnectors.push({
        connectorKey: definition.connector.key,
        sourceName: definition.connector.sourceName,
        reason: "cycle_budget_exhausted",
        nextEligibleAt: null,
        lastRunStartedAt: null,
        origin: "legacy_registry",
      });
      continue;
    }

    if (
      typeof options.maxCycleDurationMs === "number" &&
      options.maxCycleDurationMs > 0 &&
      Date.now() - now.getTime() >= options.maxCycleDurationMs
    ) {
      skippedConnectors.push({
        connectorKey: definition.connector.key,
        sourceName: definition.connector.sourceName,
        reason: "cycle_budget_exhausted",
        nextEligibleAt: null,
        lastRunStartedAt: null,
        origin: "legacy_registry",
      });
      continue;
    }

    if (isCompanySourceManagedConnector(definition.connector.sourceName)) {
      const promotion = await routeLegacyScheduledConnectorToCompanySource(definition, {
        now,
        origin: "legacy_registry",
      });

      if (promotion.managed) {
        skippedConnectors.push({
          connectorKey: definition.connector.key,
          sourceName: definition.connector.sourceName,
          reason: "managed_by_company_source",
          nextEligibleAt: null,
          lastRunStartedAt: null,
          origin: "legacy_registry",
          companySourceId: promotion.companySourceId,
          taskKind: promotion.taskKind,
        });
        continue;
      }
    }

    const lastTrackedRun = await prisma.ingestionRun.findFirst({
      where: {
        connectorKey: definition.connector.key,
        status: {
          in: ["RUNNING", "SUCCESS", "FAILED"],
        },
      },
      orderBy: { startedAt: "desc" },
    });

    if (!options.force && lastTrackedRun) {
      const nextEligibleAt = new Date(
        lastTrackedRun.startedAt.getTime() +
          definition.cadenceMinutes * 60 * 1000
      );

      if (now.getTime() < nextEligibleAt.getTime()) {
        skippedConnectors.push({
          connectorKey: definition.connector.key,
          sourceName: definition.connector.sourceName,
          reason: "not_due",
          nextEligibleAt: nextEligibleAt.toISOString(),
          lastRunStartedAt: lastTrackedRun.startedAt.toISOString(),
          origin: "legacy_registry",
        });
        continue;
      }
    }

    try {
      const summary = await withHardTimeout(
        ingestConnector(definition.connector, {
          now,
          runMode: "SCHEDULED",
          allowOverlappingRuns: false,
          maxRuntimeMs: getLegacyConnectorRuntimeBudgetMs(
            definition.connector.sourceName
          ),
          triggerLabel: options.triggerLabel ?? "schedule.route",
          scheduleCadenceMinutes: definition.cadenceMinutes,
          runMetadata: {
            origin: "legacy_registry",
            registryKey: definition.connector.key,
            sourceName: definition.connector.sourceName,
            validationState: null,
            companySourceId: null,
          },
        }),
        definition.connector.key,
        LEGACY_CONNECTOR_HARD_TIMEOUT_MS
      );

      executedRuns.push(summary);
    } catch (error) {
      console.error(
        `[scheduler] Connector ${definition.connector.key} failed:`,
        error instanceof Error ? error.message : error
      );
      // Continue to next connector — one failure should not stop the cycle
    }
  }

  // Use the fast bulk-sync path instead of the full per-job reconcile.
  // The full reconcile processes all 300k+ jobs with N+1 queries — far too slow
  // for a daemon cycle.  bulkSyncCanonicalStatuses does a single SQL UPDATE for
  // status and then runs the full per-job logic for only the at-risk cohort.
  const lifecycle = options.skipLifecycle
    ? await countCanonicalStatusSnapshot()
    : await bulkSyncCanonicalStatuses({
        now,
        perJobLimit: options.lifecyclePerJobLimit ?? 3_000,
      });

  return {
    startedAt: now.toISOString(),
    executedRuns,
    skippedConnectors,
    lifecycle,
  };
}
