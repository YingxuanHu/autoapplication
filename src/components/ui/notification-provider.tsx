"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NotificationTone = "success" | "error" | "info";

type NotificationInput = {
  title?: string;
  message: string;
  tone?: NotificationTone;
  durationMs?: number;
};

type NotificationItem = NotificationInput & {
  id: string;
  tone: NotificationTone;
};

type NotificationContextValue = {
  notify: (input: NotificationInput) => string;
  dismiss: (id: string) => void;
};

const FLASH_STORAGE_KEY = "autoapplication.flash-notification";

const NotificationContext = createContext<NotificationContextValue | null>(null);

function createNotificationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readFlashNotification(): NotificationInput | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(FLASH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  window.sessionStorage.removeItem(FLASH_STORAGE_KEY);

  try {
    const parsed = JSON.parse(raw) as NotificationInput;
    if (!parsed || typeof parsed.message !== "string" || !parsed.message.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function queueFlashNotification(input: NotificationInput) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(FLASH_STORAGE_KEY, JSON.stringify(input));
}

function NotificationToast({
  item,
  onDismiss,
}: {
  item: NotificationItem;
  onDismiss: (id: string) => void;
}) {
  const Icon = item.tone === "success" ? CheckCircle2 : item.tone === "error" ? AlertCircle : Info;

  return (
    <div
      aria-live={item.tone === "error" ? "assertive" : "polite"}
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur",
        item.tone === "success" &&
          "border-emerald-500/20 bg-emerald-500/8 text-foreground dark:bg-emerald-500/12",
        item.tone === "error" &&
          "border-destructive/20 bg-destructive/8 text-foreground dark:bg-destructive/14",
        item.tone === "info" && "border-border/70 bg-background/92 text-foreground"
      )}
      role={item.tone === "error" ? "alert" : "status"}
    >
      <div
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          item.tone === "success" && "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
          item.tone === "error" && "bg-destructive/12 text-destructive",
          item.tone === "info" && "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        {item.title ? <p className="text-sm font-medium">{item.title}</p> : null}
        <p className={cn("text-sm", item.title ? "mt-1 text-muted-foreground" : "text-foreground")}>
          {item.message}
        </p>
      </div>
      <Button
        aria-label="Dismiss notification"
        className="-mr-1 -mt-1"
        onClick={() => onDismiss(item.id)}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timerId = timersRef.current.get(id);
    if (timerId) {
      window.clearTimeout(timerId);
      timersRef.current.delete(id);
    }

    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const id = createNotificationId();
    const tone = input.tone ?? "info";
    const notification: NotificationItem = {
      id,
      title: input.title,
      message: input.message,
      tone,
      durationMs: input.durationMs,
    };

    setNotifications((current) => [...current, notification]);

    const timeoutMs =
      typeof input.durationMs === "number" ? input.durationMs : tone === "error" ? 5200 : 3200;
    const timerId = window.setTimeout(() => {
      dismiss(id);
    }, timeoutMs);
    timersRef.current.set(id, timerId);

    return id;
  }, [dismiss]);

  useEffect(() => {
    const flash = readFlashNotification();
    if (!flash) {
      return;
    }

    const timerId = window.setTimeout(() => {
      notify(flash);
    }, 0);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [notify, pathname]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timerId of timers.values()) {
        window.clearTimeout(timerId);
      }
      timers.clear();
    };
  }, []);

  return (
    <NotificationContext.Provider value={{ notify, dismiss }}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[80] flex w-[min(100%-2rem,24rem)] flex-col gap-3">
        {notifications.map((item) => (
          <NotificationToast key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}
