"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { CreateTrackedApplicationForm } from "@/components/dashboard/create-tracked-application-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ApplicationsOverviewBarProps = {
  shownCount: number;
  totalCount: number;
  activeCount: number;
  expiredCount: number;
};

export function ApplicationsOverviewBar({
  shownCount,
  totalCount,
  activeCount,
  expiredCount,
}: ApplicationsOverviewBarProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="surface-panel overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2 pr-2">
          <p className="text-sm font-medium text-foreground">Add application</p>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-expanded={isOpen}
            aria-controls="manual-application-form"
            aria-label={isOpen ? "Hide add application form" : "Show add application form"}
            onClick={() => setIsOpen((value) => !value)}
            className="rounded-full border border-border/70 bg-background/70"
          >
            <Plus className={cn("size-4 transition-transform", isOpen && "rotate-45")} />
          </Button>
        </div>

        <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-x-5 gap-y-2 text-right sm:w-auto sm:gap-x-6">
          <StatsPill count={shownCount} label="shown" />
          <StatsPill count={totalCount} label="total" />
          <StatsPill count={activeCount} label="active" />
          <StatsPill count={expiredCount} label="expired" />
        </div>
      </div>

      {isOpen ? (
        <div
          id="manual-application-form"
          className="border-t border-border/70 px-4 py-4 sm:px-5"
        >
          <CreateTrackedApplicationForm />
        </div>
      ) : null}
    </section>
  );
}

function StatsPill({ count, label }: { count: number; label: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      <span className="text-xl font-semibold text-foreground">{count}</span>
      <span className="ml-1">{label}</span>
    </p>
  );
}
