export type BulkRecoveryCycleResult = {
  skipped?: string;
  nextDueInMs?: number;
};

export type BulkRecoveryAttempt = {
  startedAt: Date;
  status: "SUCCESS" | "FAILED";
};

const MIN_IDLE_SLEEP_MS = 1_000;
const MAX_FAILURE_BACKOFF_MULTIPLIER = 16;

export function getBulkRecoveryNextEligibleAt(input: {
  now: Date;
  cadenceMinutes: number;
  recentAttempts: BulkRecoveryAttempt[];
}): Date | null {
  const latest = input.recentAttempts[0];
  if (!latest) return null;

  const cadenceMs = Math.max(1, input.cadenceMinutes) * 60_000;
  let failureStreak = 0;
  for (const attempt of input.recentAttempts) {
    if (attempt.status !== "FAILED") break;
    failureStreak += 1;
  }

  const failureMultiplier =
    failureStreak === 0
      ? 1
      : Math.min(MAX_FAILURE_BACKOFF_MULTIPLIER, 2 ** (failureStreak - 1));
  const waitMs = cadenceMs * failureMultiplier;
  return new Date(latest.startedAt.getTime() + waitMs);
}

export function getBulkRecoverySleepMs({
  results,
  catchupSeconds,
  fallbackIntervalMinutes,
}: {
  results: BulkRecoveryCycleResult[] | undefined;
  catchupSeconds: number;
  fallbackIntervalMinutes: number;
}) {
  const catchupMs = catchupSeconds * 1_000;
  const fallbackMs = fallbackIntervalMinutes * 60_000;

  if (!results || results.some((result) => !result.skipped)) {
    return catchupMs;
  }

  const nextDueInMs = results.reduce<number | null>((soonest, result) => {
    if (
      typeof result.nextDueInMs !== "number" ||
      !Number.isFinite(result.nextDueInMs)
    ) {
      return soonest;
    }

    return soonest === null
      ? result.nextDueInMs
      : Math.min(soonest, result.nextDueInMs);
  }, null);

  return Math.max(
    MIN_IDLE_SLEEP_MS,
    Math.min(nextDueInMs ?? fallbackMs, fallbackMs)
  );
}
