"use client";

import { startTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type JobsAutoRefreshProps = {
  initialLastUpdatedAt: string | null;
  statusPollIntervalMs?: number;
};

export function JobsAutoRefresh({
  initialLastUpdatedAt,
  statusPollIntervalMs = 30_000,
}: JobsAutoRefreshProps) {
  const router = useRouter();
  const lastSeenUpdatedAtRef = useRef(initialLastUpdatedAt);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    lastSeenUpdatedAtRef.current = initialLastUpdatedAt;
  }, [initialLastUpdatedAt]);

  useEffect(() => {
    let cancelled = false;

    const checkStatus = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        return;
      }

      if (refreshInFlightRef.current) {
        return;
      }

      try {
        const response = await fetch("/api/ingestion/status", {
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

    const timer = window.setInterval(checkStatus, statusPollIntervalMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkStatus();
      }
    };

    window.addEventListener("focus", checkStatus);
    window.addEventListener("online", checkStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkStatus);
      window.removeEventListener("online", checkStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router, statusPollIntervalMs]);

  return null;
}
