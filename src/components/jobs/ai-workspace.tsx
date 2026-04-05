"use client";

import { useState } from "react";
import {
  Sparkles,
  LoaderCircle,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Types ──────────────────────────────────────────────────────────────────

type FitAnalysis = {
  score: number;
  tier: "strong" | "good" | "moderate" | "weak";
  summary: string;
  strengths: string[];
  gaps: string[];
  keywords: string[];
};

type CoverLetterResult = {
  text: string;
  wordCount: number;
};

type Props = {
  jobId: string;
  jobTitle: string;
  company: string;
};

// ─── Component ──────────────────────────────────────────────────────────────

export function AIWorkspace({ jobId, jobTitle, company }: Props) {
  const [fitData, setFitData] = useState<FitAnalysis | null>(null);
  const [fitLoading, setFitLoading] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);

  const [clData, setClData] = useState<CoverLetterResult | null>(null);
  const [clLoading, setClLoading] = useState(false);
  const [clError, setClError] = useState<string | null>(null);
  const [clCopied, setClCopied] = useState(false);

  async function runFitAnalysis() {
    setFitLoading(true);
    setFitError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/ai/analyze`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "Analysis failed");
      }
      setFitData(await res.json());
    } catch (e) {
      setFitError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setFitLoading(false);
    }
  }

  async function runCoverLetter() {
    setClLoading(true);
    setClError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/ai/cover-letter`, { method: "POST" });
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
      >
        {!fitData ? (
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
          <FitResult
            data={fitData}
            onRerun={() => { setFitData(null); runFitAnalysis(); }}
          />
        )}
      </Collapsible>

      {/* ── Cover letter ── */}
      <Collapsible
        label="Cover letter"
        icon={<Sparkles className="h-3.5 w-3.5" />}
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
        <span className={`text-xs font-medium capitalize ${tierColor}`}>{data.tier} fit</span>
      </div>

      {/* Summary */}
      <p className="text-sm text-muted-foreground">{data.summary}</p>

      {/* Two-column: strengths + gaps */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data.strengths.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-green-600 dark:text-green-400">
              Strengths
            </p>
            <ul className="space-y-1">
              {data.strengths.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <span className="mt-0.5 shrink-0 text-green-500">✓</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.gaps.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-yellow-600 dark:text-yellow-400">
              Gaps
            </p>
            <ul className="space-y-1">
              {data.gaps.map((g, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
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
          <p className="mb-1.5 text-xs text-muted-foreground">Keywords to include</p>
          <div className="flex flex-wrap gap-1.5">
            {data.keywords.map((kw, i) => (
              <span
                key={i}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onRerun}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Re-analyze
      </button>
    </div>
  );
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
}: {
  label: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon}
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
