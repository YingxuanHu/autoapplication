"use client";

import { Shield } from "lucide-react";

export type SourceType = "CAREER_PAGE" | "ATS_BOARD" | "STRUCTURED_DATA" | "AGGREGATOR";

interface SourceBadgeProps {
  sourceType?: SourceType | null;
  sourceName?: string | null;
  sourceLabel?: string | null;
  isDirectApply?: boolean | null;
  trustScore?: number | null;
  compact?: boolean;
}

function getSourceDisplay(
  sourceType: SourceType | null | undefined,
  sourceName: string | null | undefined,
  sourceLabel: string | null | undefined,
  isDirectApply: boolean | null | undefined,
): { label: string; colorClass: string } {
  if (isDirectApply) {
    return {
      label: "Direct Apply",
      colorClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
    };
  }

  if (sourceType === "CAREER_PAGE") {
    return {
      label: "Company Site",
      colorClass: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
    };
  }

  if (sourceType === "ATS_BOARD") {
    const atsNames: Record<string, string> = {
      GREENHOUSE: "Greenhouse",
      LEVER: "Lever",
      ASHBY: "Ashby",
      SMARTRECRUITERS: "SmartRecruiters",
      WORKABLE: "Workable",
      WORKDAY: "Workday",
      TEAMTAILOR: "Teamtailor",
      RECRUITEE: "Recruitee",
    };
    const name = sourceName ? (atsNames[sourceName] ?? sourceName) : "ATS";
    return {
      label: name,
      colorClass: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400",
    };
  }

  if (sourceType === "STRUCTURED_DATA") {
    return {
      label: "Structured Data",
      colorClass: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400",
    };
  }

  if (sourceType === "AGGREGATOR") {
    return {
      label: sourceLabel || "Aggregator",
      colorClass: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    };
  }

  // Fallback: use sourceLabel if available
  if (sourceLabel) {
    return {
      label: sourceLabel,
      colorClass: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    };
  }

  return {
    label: "Unknown",
    colorClass: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  };
}

function getTrustColor(score: number): string {
  if (score > 0.8) return "text-emerald-500";
  if (score >= 0.5) return "text-amber-500";
  return "text-gray-400";
}

export function SourceBadge({
  sourceType,
  sourceName,
  sourceLabel,
  isDirectApply,
  trustScore,
  compact = false,
}: SourceBadgeProps) {
  const { label, colorClass } = getSourceDisplay(sourceType, sourceName, sourceLabel, isDirectApply);
  const trustPct = trustScore != null ? Math.round(trustScore * 100) : null;

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${colorClass} ${
          compact ? "text-[10px]" : "text-xs"
        }`}
      >
        {label}
      </span>
      {trustPct != null && (
        <span
          className={`inline-flex items-center gap-0.5 ${compact ? "text-[10px]" : "text-xs"}`}
          title={`Trust score: ${trustPct}%`}
        >
          <Shield className={`${compact ? "size-2.5" : "size-3"} ${getTrustColor(trustScore!)}`} />
          <span className="text-muted-foreground">{trustPct}%</span>
        </span>
      )}
    </span>
  );
}

interface TrustBarProps {
  trustScore: number;
  showLabel?: boolean;
}

export function TrustBar({ trustScore, showLabel = true }: TrustBarProps) {
  const pct = Math.round(trustScore * 100);
  const barColor =
    trustScore > 0.8
      ? "bg-emerald-500"
      : trustScore >= 0.5
        ? "bg-amber-500"
        : "bg-gray-400";

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs font-medium text-muted-foreground">{pct}%</span>
      )}
    </div>
  );
}
