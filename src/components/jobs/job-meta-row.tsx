import { Banknote, Briefcase, Building2, ExternalLink, MapPin } from "lucide-react";
import {
  formatDisplayLabel,
  formatSalary,
} from "@/lib/job-display";
import type { JobResolvedLink } from "@/lib/job-links";
import { cn } from "@/lib/utils";
import { formatGeoScopeLabel } from "@/lib/geo-scope";
import type { GeoScope } from "@/lib/geo-scope";

type JobMetaRowProps = {
  company: string;
  location: string;
  geoScope?: GeoScope;
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
  geoScope,
  workMode,
  salaryMin,
  salaryMax,
  salaryCurrency,
  primaryExternalLink,
  variant = "detail",
  className,
}: JobMetaRowProps) {
  const salary = formatSalary(salaryMin, salaryMax, salaryCurrency);
  const isDetail = variant === "detail";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-2 text-muted-foreground",
        isDetail ? "mt-2 text-sm" : "mt-2 text-[13px]",
        className
      )}
    >
      <MetaItem variant={variant} icon={<Building2 className="h-3.5 w-3.5 shrink-0" />}>
        <span className="truncate">{company}</span>
      </MetaItem>

      <MetaItem variant={variant} icon={<MapPin className="h-3.5 w-3.5 shrink-0" />}>
        <span className="truncate">{location}</span>
        {geoScope && geoScope !== "US" && geoScope !== "CA" && geoScope !== "UNKNOWN" ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full border border-border/70 bg-background/90 font-semibold tracking-wide text-foreground/75",
              isDetail ? "px-1.5 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-[9px]"
            )}
          >
            {formatGeoScopeLabel(geoScope)}
          </span>
        ) : null}
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

      {primaryExternalLink ? (
        <a
          href={primaryExternalLink.href}
          target="_blank"
          rel="noreferrer"
          title={`${primaryExternalLink.label} · ${primaryExternalLink.sourceName ?? "external source"}`}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 text-muted-foreground transition hover:text-foreground",
            isDetail ? "px-0.5 py-1" : "px-0.5 py-1"
          )}
          aria-label={`Open original posting for ${company}`}
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" />
          <span className="truncate underline-offset-4 hover:underline">
            Open original posting
          </span>
        </a>
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
        "inline-flex min-w-0 items-center gap-2 border text-muted-foreground",
        variant === "detail"
          ? "rounded-xl border-border/65 bg-muted/25 px-3 py-1.5"
          : "rounded-xl border-border/55 bg-muted/[0.35] px-3 py-1.5"
      )}
    >
      <span className="text-muted-foreground/75">{icon}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">{children}</span>
    </div>
  );
}
