"use client";

import {
  Briefcase,
  MapPin,
  DollarSign,
  Code,
  TrendingUp,
  Zap,
} from "lucide-react";

interface MatchReasonChipsProps {
  matchReasons: string[];
  compact?: boolean;
}

function getReasonIcon(reason: string) {
  const lower = reason.toLowerCase();
  if (lower.includes("title") || lower.includes("role")) return Briefcase;
  if (lower.includes("location") || lower.includes("remote") || lower.includes("work mode"))
    return MapPin;
  if (lower.includes("salary") || lower.includes("compensation")) return DollarSign;
  if (lower.includes("skill")) return Code;
  if (lower.includes("experience")) return TrendingUp;
  return Zap;
}

export function MatchReasonChips({ matchReasons, compact = false }: MatchReasonChipsProps) {
  if (matchReasons.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {matchReasons.map((reason) => {
        const Icon = getReasonIcon(reason);
        return (
          <span
            key={reason}
            className={`inline-flex items-center gap-1 rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 ${
              compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
            }`}
          >
            <Icon className={compact ? "size-2.5" : "size-3"} />
            {reason}
          </span>
        );
      })}
    </div>
  );
}

interface MatchScoreBreakdownProps {
  scores: {
    titleMatch: number;
    skillsOverlap: number;
    locationMatch: number;
    salaryFit: number;
    experienceMatch: number;
  };
  overallScore: number;
}

function scoreBarColor(score: number): string {
  if (score >= 0.7) return "bg-emerald-500";
  if (score >= 0.4) return "bg-amber-500";
  return "bg-gray-400";
}

export function MatchScoreBreakdown({ scores, overallScore }: MatchScoreBreakdownProps) {
  const categories = [
    { label: "Title Match", value: scores.titleMatch, weight: 30 },
    { label: "Skills Overlap", value: scores.skillsOverlap, weight: 25 },
    { label: "Location Match", value: scores.locationMatch, weight: 20 },
    { label: "Salary Fit", value: scores.salaryFit, weight: 15 },
    { label: "Experience Level", value: scores.experienceMatch, weight: 10 },
  ];

  return (
    <div className="space-y-4">
      {/* Overall */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Overall Match</span>
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${scoreBarColor(overallScore / 100)}`}
            style={{ width: `${overallScore}%` }}
          />
        </div>
        <span className="text-sm font-bold">{overallScore}%</span>
      </div>

      {/* Category breakdown */}
      <div className="space-y-2.5">
        {categories.map((cat) => (
          <div key={cat.label} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">
              {cat.label}
              <span className="ml-1 text-[10px] opacity-60">({cat.weight}%)</span>
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${scoreBarColor(cat.value)}`}
                style={{ width: `${Math.round(cat.value * 100)}%` }}
              />
            </div>
            <span className="w-8 text-right text-xs font-medium text-muted-foreground">
              {Math.round(cat.value * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
