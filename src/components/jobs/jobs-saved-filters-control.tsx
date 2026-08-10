"use client";

import { BookmarkCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { showJobsLoadingPopup } from "@/components/jobs/jobs-navigation-pending-boundary";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  clearInAppSearchParamMemory,
  SEARCH_PARAM_MEMORY_UPDATED_EVENT,
} from "@/components/navigation/search-param-memory";
import { normalizeJobsStateQuery } from "@/lib/jobs/search-state";

export function JobsSavedFiltersControl({ storageKey }: { storageKey: string }) {
  const router = useRouter();
  const [hasSavedFilters, setHasSavedFilters] = useState(false);

  useEffect(() => {
    const updateSavedState = () => {
      try {
        const savedState = normalizeJobsStateQuery(
          window.localStorage.getItem(storageKey) ?? "",
          { includePage: false }
        );
        if (!savedState) {
          window.localStorage.removeItem(storageKey);
          setHasSavedFilters(false);
          return;
        }
        setHasSavedFilters(true);
      } catch {
        setHasSavedFilters(false);
      }
    };
    const handleMemoryUpdate = (event: Event) => {
      const updatedStorageKey = (event as CustomEvent<{ storageKey?: string }>).detail
        ?.storageKey;
      if (updatedStorageKey === storageKey) updateSavedState();
    };

    updateSavedState();
    window.addEventListener(SEARCH_PARAM_MEMORY_UPDATED_EVENT, handleMemoryUpdate);
    window.addEventListener("storage", updateSavedState);
    return () => {
      window.removeEventListener(SEARCH_PARAM_MEMORY_UPDATED_EVENT, handleMemoryUpdate);
      window.removeEventListener("storage", updateSavedState);
    };
  }, [storageKey]);

  if (!hasSavedFilters) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/70 bg-muted/35 px-2 text-[11px] font-medium text-foreground">
        <BookmarkCheck className="h-3.5 w-3.5 text-primary" />
        Saved
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Clear saved filters"
              onClick={() => {
                clearInAppSearchParamMemory(storageKey);
                setHasSavedFilters(false);
                const href = "/jobs?reset=1";
                showJobsLoadingPopup(href);
                router.push(href);
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <TooltipContent>Clear saved filters</TooltipContent>
      </Tooltip>
    </div>
  );
}
