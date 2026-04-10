"use client";

import { useMemo, useState } from "react";
import {
  Sparkles,
  LoaderCircle,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseStoredFitAnalysis } from "@/lib/ai/fit-analysis-format";
import type { CoverLetterResult, FitAnalysis } from "@/lib/ai/types";

// ─── Types ──────────────────────────────────────────────────────────────────

type Props = {
  jobId?: string;
  jobTitle: string;
  company: string;
  fitAnalysisEndpoint?: string;
  coverLetterEndpoint?: string;
  initialFitAnalysisText?: string | null;
  canAnalyzeFit?: boolean;
  fitUnavailableMessage?: string;
  onFitAnalysisGenerated?: (analysis: FitAnalysis) => void;
  sectionTitleClassName?: string;
};

// ─── Component ──────────────────────────────────────────────────────────────

export function AIWorkspace({
  jobId,
  jobTitle,
  company,
  fitAnalysisEndpoint,
  coverLetterEndpoint,
  initialFitAnalysisText = null,
  canAnalyzeFit = true,
  fitUnavailableMessage = "Add a job description first.",
  onFitAnalysisGenerated,
  sectionTitleClassName,
}: Props) {
  const initialFitData = useMemo(
    () => parseStoredFitAnalysis(initialFitAnalysisText),
    [initialFitAnalysisText]
  );
  const [fitData, setFitData] = useState<FitAnalysis | null>(initialFitData);
  const [legacyFitText, setLegacyFitText] = useState<string | null>(
    initialFitData ? null : initialFitAnalysisText
  );
  const [fitLoading, setFitLoading] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);

  const [clData, setClData] = useState<CoverLetterResult | null>(null);
  const [clLoading, setClLoading] = useState(false);
  const [clError, setClError] = useState<string | null>(null);
  const [clCopied, setClCopied] = useState(false);

  const resolvedFitEndpoint = fitAnalysisEndpoint ?? (jobId ? `/api/jobs/${jobId}/ai/analyze` : null);
  const resolvedCoverLetterEndpoint =
    coverLetterEndpoint ?? (jobId ? `/api/jobs/${jobId}/ai/cover-letter` : null);

  async function runFitAnalysis() {
    if (!resolvedFitEndpoint) {
      setFitError("Fit analysis is unavailable for this job.");
      return;
    }

    setFitLoading(true);
    setFitError(null);
    try {
      const res = await fetch(resolvedFitEndpoint, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "Analysis failed");
      }
      const data = (await res.json()) as FitAnalysis;
      setFitData(data);
      setLegacyFitText(null);
      onFitAnalysisGenerated?.(data);
    } catch (e) {
      setFitError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setFitLoading(false);
    }
  }

  async function runCoverLetter() {
    if (!resolvedCoverLetterEndpoint) {
      setClError("Cover letter generation is unavailable for this job.");
      return;
    }

    setClLoading(true);
    setClError(null);
    try {
      const res = await fetch(resolvedCoverLetterEndpoint, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "Generation failed");
      }
      setClData(await res.json());
    } catch (e) {
      setClError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setClLoading(false);
    }
  }

  function copyToClipboard() {
    if (!clData) return;
    navigator.clipboard.writeText(clData.text).then(() => {
      setClCopied(true);
      setTimeout(() => setClCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      {/* ── Fit analysis ── */}
      <Collapsible
        label="Fit analysis"
        icon={<Sparkles className="h-3.5 w-3.5" />}
        defaultOpen
        titleClassName={sectionTitleClassName}
      >
        {!fitData && !legacyFitText ? (
          canAnalyzeFit ? (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={runFitAnalysis}
                disabled={fitLoading}
              >
                {fitLoading ? (
                  <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                )}
                {fitLoading ? "Analyzing…" : "Analyze fit"}
              </Button>
              {fitError && (
                <span className="text-xs text-destructive">{fitError}</span>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{fitUnavailableMessage}</p>
          )
        ) : fitData ? (
          <FitResult
            data={fitData}
            onRerun={() => { setFitData(null); runFitAnalysis(); }}
          />
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-full space-y-3">
              <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {legacyFitText}
                </p>
              </div>
              {canAnalyzeFit ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runFitAnalysis}
                  disabled={fitLoading}
                >
                  {fitLoading ? (
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {fitLoading ? "Analyzing…" : "Re-analyze"}
                </Button>
              ) : null}
              {fitError ? (
                <span className="text-xs text-destructive">{fitError}</span>
              ) : null}
            </div>
          </div>
        )}
      </Collapsible>

      {/* ── Cover letter ── */}
      <Collapsible
        label="Cover letter"
        icon={<Sparkles className="h-3.5 w-3.5" />}
        titleClassName={sectionTitleClassName}
      >
        {!clData ? (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={runCoverLetter}
              disabled={clLoading}
            >
              {clLoading ? (
                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              {clLoading ? "Writing…" : "Generate cover letter"}
            </Button>
            {clError && (
              <span className="text-xs text-destructive">{clError}</span>
            )}
          </div>
        ) : (
          <CoverLetterResult
            data={clData}
            jobTitle={jobTitle}
            company={company}
            copied={clCopied}
            onCopy={copyToClipboard}
            onRerun={() => { setClData(null); runCoverLetter(); }}
          />
        )}
      </Collapsible>
    </div>
  );
}

// ─── Fit result ──────────────────────────────────────────────────────────────

function FitResult({
  data,
  onRerun,
}: {
  data: FitAnalysis;
  onRerun: () => void;
}) {
  const tierColor = {
    strong: "text-green-600 dark:text-green-400",
    good: "text-blue-600 dark:text-blue-400",
    moderate: "text-yellow-600 dark:text-yellow-400",
    weak: "text-red-600 dark:text-red-400",
  }[data.tier];

  const tierBg = {
    strong: "bg-green-500/10",
    good: "bg-blue-500/10",
    moderate: "bg-yellow-500/10",
    weak: "bg-red-500/10",
  }[data.tier];

  return (
    <div className="space-y-3">
      {/* Score */}
      <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ${tierBg}`}>
        <span className={`text-lg font-bold ${tierColor}`}>{data.score}/10</span>
        <span className={`text-sm font-medium capitalize ${tierColor}`}>{data.tier} fit</span>
      </div>

      {/* Summary */}
      <p className="text-sm leading-relaxed text-foreground/80">{data.summary}</p>

      {/* Two-column: strengths + gaps */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data.strengths.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-green-600 dark:text-green-400">
              Strengths
            </p>
            <ul className="space-y-1">
              {data.strengths.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5 text-sm leading-relaxed text-foreground/80">
                  <span className="mt-0.5 shrink-0 text-green-500">✓</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.gaps.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-yellow-600 dark:text-yellow-400">
              Gaps
            </p>
            <ul className="space-y-1">
              {data.gaps.map((g, i) => (
                <li key={i} className="flex items-start gap-1.5 text-sm leading-relaxed text-foreground/80">
                  <span className="mt-0.5 shrink-0 text-yellow-500">△</span>
                  {g}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Keywords */}
      {data.keywords.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm text-muted-foreground">Keywords to include</p>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-foreground/80 marker:text-muted-foreground">
            {data.keywords.map((kw, i) => (
              <li key={i}>{renderInlineBold(emphasizeKeywordText(kw))}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={onRerun}
        className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Re-analyze
      </button>
    </div>
  );
}

function emphasizeKeywordText(text: string) {
  let emphasized = text.trim();

  const phrasePatterns = [
    "machine learning projects",
    "streaming pipelines",
    "real-time ML systems",
    "multi-language capabilities",
    "full-stack ML deployment experience",
    "AI-driven pipeline project",
    "Master's degree in ECE",
    "impact metrics",
    "latency reduction",
    "false-positive alert decreases",
    "recommendation systems",
    "cloud-based data pipelines",
    "data engineering practices",
    "applied ML",
    "production ML systems",
  ];

  for (const pattern of phrasePatterns) {
    const regex = new RegExp(`\\b${escapeRegExp(pattern)}\\b`, "gi");
    emphasized = applyBoldPattern(emphasized, regex);
  }

  emphasized = applyBoldPattern(emphasized, /\(([^)]+)\)/g, (_, inner: string) => {
    const formatted = inner
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => `**${part}**`)
      .join(", ");

    return formatted ? `(${formatted})` : "";
  });

  emphasized = applyBoldPattern(
    emphasized,
    /\b(LLMs?|AI|ML|ECE|Kafka|Python|Rust|Kotlin|FastAPI|React|Kubernetes|TensorFlow|PyTorch|Spark|dbt|Airflow|Snowflake|Databricks|SQL|AWS|GCP|Azure)\b/g,
    (match) => `**${match}**`
  );

  return emphasized;
}

function renderInlineBold(text: string): React.ReactNode[] {
  return text.split(/(\*\*.*?\*\*)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }

    return <span key={index}>{part}</span>;
  });
}

function applyBoldPattern(
  text: string,
  regex: RegExp,
  replacer: ((substring: string, ...args: string[]) => string) | string = (match) => `**${match}**`
) {
  return text
    .split(/(\*\*.*?\*\*)/g)
    .map((segment) => {
      if (segment.startsWith("**") && segment.endsWith("**")) {
        return segment;
      }

      return segment.replace(regex, replacer as never);
    })
    .join("");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Cover letter result ──────────────────────────────────────────────────────

function CoverLetterResult({
  data,
  jobTitle,
  company,
  copied,
  onCopy,
  onRerun,
}: {
  data: CoverLetterResult;
  jobTitle: string;
  company: string;
  copied: boolean;
  onCopy: () => void;
  onRerun: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {jobTitle} · {company} · {data.wordCount} words
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onRerun}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Regenerate
          </button>
        </div>
      </div>

      <div className="rounded-md border border-border/60 bg-muted/30 p-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {data.text}
        </p>
      </div>
    </div>
  );
}

// ─── Collapsible ──────────────────────────────────────────────────────────────

function Collapsible({
  label,
  icon,
  defaultOpen = false,
  children,
  titleClassName,
}: {
  label: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  titleClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left"
      >
        <span className={titleClassName ?? "flex items-center gap-2 text-xs font-medium text-muted-foreground"}>
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          {label}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {open && <div className="border-t border-border/60 p-3">{children}</div>}
    </div>
  );
}
