import "dotenv/config";
import { prisma } from "../src/lib/db";
import { enqueueUniqueSourceTask } from "../src/lib/ingestion/task-queue";

const HARD_DISABLE_HTTP_STATUSES = new Set([404, 410]);
const HARD_DISABLE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const SOFT_BACKOFF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type PruneDecision =
  | {
      action: "hard_disable";
      reason: string;
      cooldownUntil: Date;
    }
  | {
      action: "soft_backoff";
      reason: string;
      cooldownUntil: Date;
    };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  const sources = await prisma.companySource.findMany({
    where: {
      status: {
        not: "DISABLED",
      },
      pollState: {
        not: "DISABLED",
      },
      ...(args.csvImportOnly
        ? {
            parserVersion: "csv-import:v1",
          }
        : {}),
      ...(args.connector
        ? {
            connectorName: args.connector,
          }
        : {}),
    },
    orderBy: [{ yieldScore: "asc" }, { failureStreak: "desc" }, { updatedAt: "asc" }],
    select: {
      id: true,
      companyId: true,
      sourceName: true,
      connectorName: true,
      status: true,
      validationState: true,
      pollState: true,
      priorityScore: true,
      sourceQualityScore: true,
      yieldScore: true,
      pollAttemptCount: true,
      pollSuccessCount: true,
      jobsFetchedCount: true,
      jobsAcceptedCount: true,
      jobsDedupedCount: true,
      jobsCreatedCount: true,
      retainedLiveJobCount: true,
      failureStreak: true,
      consecutiveFailures: true,
      lastHttpStatus: true,
      cooldownUntil: true,
    },
  });

  const candidates = sources
    .map((source) => ({
      source,
      decision: decidePruneAction(source, now),
    }))
    .filter(
      (
        entry
      ): entry is {
        source: (typeof sources)[number];
        decision: PruneDecision;
      } => entry.decision !== null
    );

  const summary = {
    inspected: sources.length,
    candidates: candidates.length,
    hardDisable: candidates.filter((entry) => entry.decision.action === "hard_disable").length,
    softBackoff: candidates.filter((entry) => entry.decision.action === "soft_backoff").length,
  };

  if (!args.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          summary,
          candidates: candidates.map(({ source, decision }) => ({
            sourceName: source.sourceName,
            connectorName: source.connectorName,
            status: source.status,
            validationState: source.validationState,
            pollState: source.pollState,
            yieldScore: source.yieldScore,
            pollAttempts: source.pollAttemptCount,
            pollSuccesses: source.pollSuccessCount,
            jobsFetched: source.jobsFetchedCount,
            jobsAccepted: source.jobsAcceptedCount,
            jobsCreated: source.jobsCreatedCount,
            retainedLive: source.retainedLiveJobCount,
            failureStreak: source.failureStreak,
            lastHttpStatus: source.lastHttpStatus,
            decision,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const applied = [];
  for (const { source, decision } of candidates) {
    if (decision.action === "hard_disable") {
      await prisma.companySource.update({
        where: { id: source.id },
        data: {
          status: "REDISCOVER_REQUIRED",
          validationState:
            source.validationState === "BLOCKED" ? "BLOCKED" : "NEEDS_REDISCOVERY",
          pollState: "DISABLED",
          cooldownUntil: decision.cooldownUntil,
          priorityScore: Math.min(source.priorityScore, 0.15),
          yieldScore: Math.min(source.yieldScore, 0.1),
          validationMessage: `[prune-pass] ${decision.reason}`,
        },
      });

      await enqueueUniqueSourceTask({
        kind: "REDISCOVERY",
        companyId: source.companyId,
        companySourceId: source.id,
        priorityScore: 88,
        notBeforeAt: now,
        payloadJson: {
          origin: "prune_pass",
          reason: decision.reason,
          sourceName: source.sourceName,
        },
      });
    } else {
      const nextCooldown =
        source.cooldownUntil && source.cooldownUntil > decision.cooldownUntil
          ? source.cooldownUntil
          : decision.cooldownUntil;

      await prisma.companySource.update({
        where: { id: source.id },
        data: {
          status: "DEGRADED",
          pollState: "BACKOFF",
          cooldownUntil: nextCooldown,
          priorityScore: Math.min(source.priorityScore, 0.35),
          yieldScore: Math.min(source.yieldScore, 0.35),
          validationMessage: `[prune-pass] ${decision.reason}`,
        },
      });
    }

    applied.push({
      sourceName: source.sourceName,
      connectorName: source.connectorName,
      action: decision.action,
      reason: decision.reason,
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        summary,
        applied,
      },
      null,
      2
    )
  );
}

function decidePruneAction(
  source: {
    sourceName: string;
    connectorName: string;
    validationState: string;
    pollAttemptCount: number;
    pollSuccessCount: number;
    jobsFetchedCount: number;
    jobsAcceptedCount: number;
    jobsDedupedCount: number;
    jobsCreatedCount: number;
    retainedLiveJobCount: number;
    failureStreak: number;
    consecutiveFailures: number;
    lastHttpStatus: number | null;
  },
  now: Date
): PruneDecision | null {
  const hasNoRetainedValue = source.retainedLiveJobCount === 0;
  const hardStatus = HARD_DISABLE_HTTP_STATUSES.has(source.lastHttpStatus ?? 0);

  if (
    hasNoRetainedValue &&
    source.pollSuccessCount === 0 &&
    (hardStatus || source.failureStreak >= 2 || source.consecutiveFailures >= 2)
  ) {
    return {
      action: "hard_disable",
      reason: hardStatus
        ? `Hard failure HTTP ${source.lastHttpStatus} with no retained value.`
        : "Repeated failures with no retained value.",
      cooldownUntil: new Date(now.getTime() + HARD_DISABLE_COOLDOWN_MS),
    };
  }

  if (source.pollSuccessCount >= 2 && source.jobsAcceptedCount === 0) {
    return {
      action: "soft_backoff",
      reason: "Multiple successful polls yielded zero accepted jobs.",
      cooldownUntil: new Date(now.getTime() + SOFT_BACKOFF_COOLDOWN_MS),
    };
  }

  if (
    source.pollSuccessCount >= 3 &&
    hasNoRetainedValue &&
    source.jobsCreatedCount === 0 &&
    source.jobsAcceptedCount <= 5
  ) {
    return {
      action: "soft_backoff",
      reason: "Repeated successful polls produced no durable retained output.",
      cooldownUntil: new Date(now.getTime() + SOFT_BACKOFF_COOLDOWN_MS),
    };
  }

  if (
    source.pollSuccessCount >= 3 &&
    source.jobsAcceptedCount > 0 &&
    source.jobsDedupedCount >= source.jobsAcceptedCount &&
    hasNoRetainedValue &&
    source.jobsCreatedCount === 0
  ) {
    return {
      action: "soft_backoff",
      reason: "High dedupe waste with no created or retained value.",
      cooldownUntil: new Date(now.getTime() + SOFT_BACKOFF_COOLDOWN_MS),
    };
  }

  return null;
}

function parseArgs(rawArgs: string[]) {
  const connectorArg = rawArgs.find((arg) => arg.startsWith("--connector="));
  return {
    apply: rawArgs.includes("--apply"),
    csvImportOnly: rawArgs.includes("--csv-import-only"),
    connector: connectorArg ? connectorArg.split("=", 2)[1] : undefined,
  };
}

main()
  .catch((error) => {
    console.error("Source prune pass failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
