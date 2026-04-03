import { prisma } from "@/lib/db";
import { reconcileCanonicalLifecycle, ingestConnector } from "@/lib/ingestion/pipeline";
import { getScheduledConnectors } from "@/lib/ingestion/registry";
import type { IngestionSummary } from "@/lib/ingestion/types";

export type ScheduledIngestionResult = {
  startedAt: string;
  executedRuns: IngestionSummary[];
  skippedConnectors: Array<{
    connectorKey: string;
    sourceName: string;
    reason: "not_due";
    nextEligibleAt: string;
    lastRunStartedAt: string;
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
  const scheduledDefinitions = getScheduledConnectors().filter((definition) => {
    if (!options.connectorKeys || options.connectorKeys.length === 0) return true;
    return options.connectorKeys.includes(definition.connector.key);
  });

  const executedRuns: IngestionSummary[] = [];
  const skippedConnectors: ScheduledIngestionResult["skippedConnectors"] = [];

  for (const definition of scheduledDefinitions) {
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
