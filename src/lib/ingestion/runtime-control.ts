export function toRuntimeAbortError(reason: unknown) {
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(
    typeof reason === "string" && reason.trim()
      ? reason
      : "Runtime budget exceeded"
  );
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
