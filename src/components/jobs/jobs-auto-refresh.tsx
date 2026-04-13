"use client";

import { startTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type JobsAutoRefreshProps = {
  initialLastUpdatedAt: string | null;
  statusPollIntervalMs?: number;
  minStatusCheckGapMs?: number;
};

export function JobsAutoRefresh({
  initialLastUpdatedAt,
  statusPollIntervalMs = 120_000,
  minStatusCheckGapMs = 15_000,
}: JobsAutoRefreshProps) {
  const router = useRouter();
  const lastSeenUpdatedAtRef = useRef(initialLastUpdatedAt);
  const refreshInFlightRef = useRef(false);
  const lastStatusCheckAtRef = useRef(0);

  useEffect(() => {
    lastSeenUpdatedAtRef.current = initialLastUpdatedAt;
  }, [initialLastUpdatedAt]);

  useEffect(() => {
    let cancelled = false;

    const pollHeartbeat = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        return;
      }

      if (refreshInFlightRef.current) {
        return;
      }

      const now = Date.now();
      if (now - lastStatusCheckAtRef.current < minStatusCheckGapMs) {
        return;
      }
      lastStatusCheckAtRef.current = now;

      try {
        const response = await fetch("/api/ingestion/status?mode=heartbeat", {
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const status = (await response.json()) as { lastUpdatedAt?: string | null };
        const nextLastUpdatedAt = status.lastUpdatedAt ?? null;
        if (
          nextLastUpdatedAt &&
          nextLastUpdatedAt !== lastSeenUpdatedAtRef.current &&
          !cancelled
        ) {
          lastSeenUpdatedAtRef.current = nextLastUpdatedAt;
          refreshInFlightRef.current = true;
          startTransition(() => {
            router.refresh();
          });
          window.setTimeout(() => {
            refreshInFlightRef.current = false;
          }, 1500);
          return;
        }

        if (nextLastUpdatedAt) {
          lastSeenUpdatedAtRef.current = nextLastUpdatedAt;
        }
      } catch {
        // Ignore transient status fetch errors.
      }
    };

    const timer = window.setInterval(pollHeartbeat, statusPollIntervalMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void pollHeartbeat();
      }
    };

    window.addEventListener("focus", pollHeartbeat);
    window.addEventListener("online", pollHeartbeat);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", pollHeartbeat);
      window.removeEventListener("online", pollHeartbeat);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [minStatusCheckGapMs, router, statusPollIntervalMs]);

  return null;
}
