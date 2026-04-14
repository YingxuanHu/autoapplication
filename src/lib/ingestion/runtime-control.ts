export const TIME_BUDGET_EXCEEDED_CODE = "TIME_BUDGET_EXCEEDED";
export const ABORTED_BY_RUNNER_CODE = "ABORTED_BY_RUNNER";

export class RuntimeBudgetExceededError extends Error {
  code = TIME_BUDGET_EXCEEDED_CODE;
  timeoutMs: number;

  constructor(timeoutMs: number, label?: string) {
    super(
      `${TIME_BUDGET_EXCEEDED_CODE}: ${
        label ? `${label} ` : ""
      }runtime budget exceeded after ${timeoutMs}ms`
    );
    this.name = "RuntimeBudgetExceededError";
    this.timeoutMs = timeoutMs;
  }
}

export class RunnerAbortedError extends Error {
  code = ABORTED_BY_RUNNER_CODE;

  constructor(reason?: string) {
    super(
      `${ABORTED_BY_RUNNER_CODE}: ${
        reason?.trim() ? reason : "connector execution aborted by runner"
      }`
    );
    this.name = "RunnerAbortedError";
  }
}

export function createRuntimeBudgetExceededError(
  timeoutMs: number,
  label?: string
) {
  return new RuntimeBudgetExceededError(timeoutMs, label);
}

export function createRunnerAbortedError(reason?: string) {
  return new RunnerAbortedError(reason);
}

export function toRuntimeAbortError(reason: unknown) {
  if (reason instanceof Error) {
    return reason;
  }

  if (typeof reason === "string" && reason.includes(TIME_BUDGET_EXCEEDED_CODE)) {
    return new RuntimeBudgetExceededError(0, reason);
  }

  return new Error(
    typeof reason === "string" && reason.trim()
      ? reason
      : "Runtime budget exceeded"
  );
}

export function buildTimeoutSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs: number
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;

  const abortSignalAny = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;

  return abortSignalAny ? abortSignalAny([signal, timeoutSignal]) : timeoutSignal;
}

export function throwIfAborted(signal?: AbortSignal | null) {
  if (signal?.aborted) {
    throw toRuntimeAbortError(signal.reason);
  }
}

export async function sleepWithAbort(
  durationMs: number,
  signal?: AbortSignal | null
) {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(toRuntimeAbortError(signal?.reason));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
