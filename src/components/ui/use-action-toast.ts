"use client";

import { useEffect, useRef } from "react";

import { useNotifications } from "@/components/ui/notification-provider";

type ActionToastState = {
  error: string | null;
  success: string | null;
};

type ActionToastOptions = {
  errorTitle?: string;
  successTitle?: string;
};

export function useActionToast(
  state: ActionToastState,
  options?: ActionToastOptions
) {
  const { notify } = useNotifications();
  const lastMessageRef = useRef<string | null>(null);

  useEffect(() => {
    const key = state.error
      ? `error:${state.error}`
      : state.success
        ? `success:${state.success}`
        : null;

    if (!key || key === lastMessageRef.current) {
      return;
    }

    lastMessageRef.current = key;
    notify({
      title: state.error
        ? options?.errorTitle ?? "Request failed"
        : options?.successTitle ?? "Saved",
      message: state.error ?? state.success ?? "",
      tone: state.error ? "error" : "success",
    });
  }, [notify, options?.errorTitle, options?.successTitle, state.error, state.success]);
}
