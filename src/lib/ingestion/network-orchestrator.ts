import { prisma } from "@/lib/db";
import {
  enqueueCompanyDiscoveryTasks,
  enqueueSourceValidationTasks,
  enqueueCompanySourcePollTasks,
  enqueueRediscoveryTasks,
  runCompanyDiscoveryQueue,
  runSourceValidationQueue,
  runCompanySourcePollQueue,
  runRediscoveryQueue,
} from "@/lib/ingestion/company-discovery";
import {
  enqueuePriorityUrlHealthTasks,
  runUrlHealthTaskQueue,
} from "@/lib/ingestion/health-checker";

const POLL_BACKLOG_THROTTLE_THRESHOLD = 1_000;
const VALIDATION_BACKLOG_THROTTLE_THRESHOLD = 400;
const DISCOVERY_THROTTLE_RATIO = 0.25;
const REDISCOVERY_THROTTLE_RATIO = 0.5;

async function getExecutionLimits(options: {
  discoveryLimit?: number;
  validationLimit?: number;
  sourcePollLimit?: number;
  rediscoveryLimit?: number;
}) {
  const [
    pendingPollCount,
    pendingValidationCount,
  ] = await Promise.all([
    prisma.sourceTask.count({
      where: {
        kind: "CONNECTOR_POLL",
        status: "PENDING",
      },
    }),
    prisma.sourceTask.count({
      where: {
        kind: "SOURCE_VALIDATION",
        status: "PENDING",
      },
    }),
  ]);

  const shouldThrottleDiscovery =
    pendingPollCount >= POLL_BACKLOG_THROTTLE_THRESHOLD ||
    pendingValidationCount >= VALIDATION_BACKLOG_THROTTLE_THRESHOLD;

  const discoveryLimit = options.discoveryLimit
    ? shouldThrottleDiscovery
      ? Math.max(25, Math.floor(options.discoveryLimit * DISCOVERY_THROTTLE_RATIO))
      : options.discoveryLimit
    : options.discoveryLimit;

  const rediscoveryLimit = options.rediscoveryLimit
    ? shouldThrottleDiscovery
      ? Math.max(20, Math.floor(options.rediscoveryLimit * REDISCOVERY_THROTTLE_RATIO))
      : options.rediscoveryLimit
    : options.rediscoveryLimit;

  return {
    discoveryLimit,
    validationLimit: options.validationLimit,
    sourcePollLimit: options.sourcePollLimit,
    rediscoveryLimit,
    pendingPollCount,
    pendingValidationCount,
    shouldThrottleDiscovery,
  };
}

export async function scheduleOperationalQueues(options: {
  now?: Date;
  discoveryLimit?: number;
  validationLimit?: number;
  sourcePollLimit?: number;
  rediscoveryLimit?: number;
  urlHealthLimit?: number;
} = {}) {
  const now = options.now ?? new Date();
  const [discovery, validation, sourcePoll, rediscovery, urlHealth] = await Promise.all([
    enqueueCompanyDiscoveryTasks({ limit: options.discoveryLimit, now }),
    enqueueSourceValidationTasks({ limit: options.validationLimit, now }),
    enqueueCompanySourcePollTasks({ limit: options.sourcePollLimit, now }),
    enqueueRediscoveryTasks({ limit: options.rediscoveryLimit, now }),
    enqueuePriorityUrlHealthTasks({ limit: options.urlHealthLimit, now }),
  ]);

  return {
    now: now.toISOString(),
    discovery,
    validation,
    sourcePoll,
    rediscovery,
    urlHealth,
  };
}

export async function runOperationalQueues(options: {
  now?: Date;
  discoveryLimit?: number;
  validationLimit?: number;
  sourcePollLimit?: number;
  rediscoveryLimit?: number;
  urlHealthLimit?: number;
} = {}) {
  const now = options.now ?? new Date();
  const limits = await getExecutionLimits(options);

  const validation = await runSourceValidationQueue({
    limit: limits.validationLimit,
    now,
  });
  const sourcePoll = await runCompanySourcePollQueue({
    limit: limits.sourcePollLimit,
    now,
  });
  const [rediscovery, discovery] = await Promise.all([
    runRediscoveryQueue({ limit: limits.rediscoveryLimit, now }),
    runCompanyDiscoveryQueue({ limit: limits.discoveryLimit, now }),
  ]);
  const urlHealth = await runUrlHealthTaskQueue({
    limit: options.urlHealthLimit,
    now,
  });

  return {
    now: now.toISOString(),
    discovery,
    validation,
    sourcePoll,
    rediscovery,
    urlHealth,
    executionPolicy: {
      pendingPollCount: limits.pendingPollCount,
      pendingValidationCount: limits.pendingValidationCount,
      throttledDiscovery: limits.shouldThrottleDiscovery,
      discoveryLimit: limits.discoveryLimit ?? null,
      rediscoveryLimit: limits.rediscoveryLimit ?? null,
    },
  };
}
