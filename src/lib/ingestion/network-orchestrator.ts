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
  const [discovery, rediscovery] = await Promise.all([
    runCompanyDiscoveryQueue({ limit: options.discoveryLimit, now }),
    runRediscoveryQueue({ limit: options.rediscoveryLimit, now }),
  ]);
  const validation = await runSourceValidationQueue({
    limit: options.validationLimit,
    now,
  });
  const sourcePoll = await runCompanySourcePollQueue({
    limit: options.sourcePollLimit,
    now,
  });
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
  };
}
