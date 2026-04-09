import { Banknote, Briefcase, Building2, ExternalLink, MapPin } from "lucide-react";
import {
  formatDisplayLabel,
  formatSalary,
  getSourceShortName,
} from "@/lib/job-display";
import type { JobResolvedLink } from "@/lib/job-links";
import { cn } from "@/lib/utils";

type JobMetaRowProps = {
  company: string;
  location: string;
  workMode: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  primaryExternalLink: JobResolvedLink | null;
  variant?: "detail" | "card";
  className?: string;
};

export function JobMetaRow({
  company,
  location,
  workMode,
  salaryMin,
  salaryMax,
  salaryCurrency,
  primaryExternalLink,
  variant = "detail",
  className,
}: JobMetaRowProps) {
  const salary = formatSalary(salaryMin, salaryMax, salaryCurrency);
  const sourceShortName = getSourceShortName(primaryExternalLink?.sourceName ?? null);
  const isDetail = variant === "detail";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-muted-foreground",
        isDetail ? "mt-2 text-sm" : "mt-2 text-[13px]",
        className
      )}
    >
      <MetaItem variant={variant} icon={<Building2 className="h-3.5 w-3.5 shrink-0" />}>
        <span className="truncate">{company}</span>
        {sourceShortName ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full border border-border/70 bg-background/90 font-semibold uppercase tracking-[0.18em] text-foreground/75",
              isDetail ? "px-1.5 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-[9px]"
            )}
          >
            {sourceShortName}
          </span>
        ) : null}
        {primaryExternalLink ? (
          <a
            href={primaryExternalLink.href}
            target="_blank"
            rel="noreferrer"
            title={`${primaryExternalLink.label} · ${primaryExternalLink.sourceName ?? "external source"}`}
            className="inline-flex items-center text-muted-foreground transition hover:text-foreground"
            aria-label={`Open ${company} posting source`}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </MetaItem>

      <MetaItem variant={variant} icon={<MapPin className="h-3.5 w-3.5 shrink-0" />}>
        <span className="truncate">{location}</span>
      </MetaItem>

      {workMode !== "UNKNOWN" ? (
        <MetaItem variant={variant} icon={<Briefcase className="h-3.5 w-3.5 shrink-0" />}>
          <span>{formatDisplayLabel(workMode)}</span>
        </MetaItem>
      ) : null}

      {salary ? (
        <MetaItem variant={variant} icon={<Banknote className="h-3.5 w-3.5 shrink-0" />}>
          <span>{salary}</span>
        </MetaItem>
      ) : null}
    </div>
  );
}

function MetaItem({
  icon,
  children,
  variant,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  variant: "detail" | "card";
}) {
  return (
    <div
      className={cn(
        "inline-flex min-w-0 items-center gap-2 rounded-full border border-border/70 text-muted-foreground",
        variant === "detail"
          ? "bg-muted/25 px-3 py-1.5"
          : "bg-background/75 px-2.5 py-1"
      )}
    >
      <span className="text-muted-foreground/75">{icon}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">{children}</span>
    </div>
  );
}
