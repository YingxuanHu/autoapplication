import { prisma } from "@/lib/db";
import {
  isCompanySourceManagedConnector,
  routeLegacyScheduledConnectorToCompanySource,
} from "@/lib/ingestion/legacy-source-routing";
import {
  reconcileCanonicalLifecycle,
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
    reason: "not_due" | "managed_by_company_source";
    nextEligibleAt: string | null;
    lastRunStartedAt: string | null;
    origin: "legacy_registry";
    companySourceId?: string;
    taskKind?: "SOURCE_VALIDATION" | "CONNECTOR_POLL";
  }>;
  lifecycle: {
    liveCount: number;
    staleCount: number;
    expiredCount: number;
    removedCount: number;
    updatedCount: number;
  };
};

export async function runScheduledIngestion(options: {
  now?: Date;
  force?: boolean;
  connectorKeys?: string[];
  triggerLabel?: string;
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
  const scheduledDefinitions = getScheduledConnectors().filter((definition) => {
    if (!options.connectorKeys || options.connectorKeys.length === 0) return true;
    return options.connectorKeys.includes(definition.connector.key);
  });

  const executedRuns: IngestionSummary[] = [];
  const skippedConnectors: ScheduledIngestionResult["skippedConnectors"] = [];

  for (const definition of scheduledDefinitions) {
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
      const summary = await ingestConnector(definition.connector, {
        now,
        runMode: "SCHEDULED",
        allowOverlappingRuns: false,
        triggerLabel: options.triggerLabel ?? "schedule.route",
        scheduleCadenceMinutes: definition.cadenceMinutes,
        runMetadata: {
          origin: "legacy_registry",
          registryKey: definition.connector.key,
          sourceName: definition.connector.sourceName,
          validationState: null,
          companySourceId: null,
        },
      });

      executedRuns.push(summary);
    } catch (error) {
      console.error(
        `[scheduler] Connector ${definition.connector.key} failed:`,
        error instanceof Error ? error.message : error
      );
      // Continue to next connector — one failure should not stop the cycle
    }
  }

  const lifecycle = await reconcileCanonicalLifecycle({ now });

  return {
    startedAt: now.toISOString(),
    executedRuns,
    skippedConnectors,
    lifecycle,
  };
}
