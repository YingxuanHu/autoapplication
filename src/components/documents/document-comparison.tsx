"use client";

import { useCallback, useState, useTransition } from "react";

import { getDocumentText } from "@/app/documents/compare/actions";
import {
  computeDiff,
  getDiffStats,
  toSplitRows,
  type DiffLine,
  type SplitRow,
} from "@/lib/diff";

type DocumentOption = {
  id: string;
  filename: string;
  type: "RESUME" | "COVER_LETTER" | "RESUME_TEMPLATE";
};

type LoadedDocument = {
  id: string;
  text: string;
};

type ViewMode = "unified" | "split";

function DocumentSelector({
  label,
  options,
  selectedId,
  disabledId,
  onChange,
}: {
  label: string;
  options: DocumentOption[];
  selectedId: string | null;
  disabledId: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex-1 min-w-0 space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <select
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        onChange={(event) => onChange(event.target.value)}
        value={selectedId ?? ""}
      >
        <option value="">Select a document</option>
        {options.map((document) => (
          <option
            key={document.id}
            disabled={document.id === disabledId}
            value={document.id}
          >
            {document.filename} ({document.type.replaceAll("_", " ").toLowerCase()})
          </option>
        ))}
      </select>
    </label>
  );
}

function StatsBar({
  added,
  removed,
  equal,
  viewMode,
  onViewModeChange,
}: {
  added: number;
  removed: number;
  equal: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="flex items-center gap-4 font-mono text-xs sm:text-sm">
        <span className="font-semibold text-emerald-600">+{added} added</span>
        <span className="font-semibold text-destructive">-{removed} removed</span>
        <span className="text-muted-foreground">{equal} unchanged</span>
      </div>

      <div className="inline-flex rounded-lg border border-border bg-background p-1 text-xs">
        <button
          type="button"
          onClick={() => onViewModeChange("unified")}
          className={`rounded-md px-3 py-1.5 ${
            viewMode === "unified"
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Unified
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("split")}
          className={`rounded-md px-3 py-1.5 ${
            viewMode === "split"
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Split
        </button>
      </div>
    </div>
  );
}

function lineClass(type: DiffLine["type"]) {
  if (type === "added") return "bg-emerald-500/5 border-l-2 border-emerald-500";
  if (type === "removed") return "bg-destructive/5 border-l-2 border-destructive";
  return "border-l-2 border-transparent";
}

function linePrefix(type: DiffLine["type"]) {
  if (type === "added") return "+";
  if (type === "removed") return "-";
  return " ";
}

function linePrefixClass(type: DiffLine["type"]) {
  if (type === "added") return "text-emerald-600";
  if (type === "removed") return "text-destructive";
  return "text-muted-foreground";
}

function UnifiedDiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card font-mono text-xs">
      {diff.map((line, index) => (
        <div key={index} className={`flex gap-2 px-3 py-1 ${lineClass(line.type)}`}>
          <span className={`w-4 shrink-0 font-semibold ${linePrefixClass(line.type)}`}>
            {linePrefix(line.type)}
          </span>
          <span className="whitespace-pre-wrap break-all text-foreground">
            {line.value || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function SplitCell({
  line,
  borderLeft,
}: {
  line: DiffLine | null;
  borderLeft?: boolean;
}) {
  const border = borderLeft ? "border-l border-border" : "";

  if (!line) {
    return <td className={`w-1/2 bg-muted/20 px-3 py-1 ${border}`} />;
  }

  const background =
    line.type === "removed"
      ? "bg-destructive/5"
      : line.type === "added"
        ? "bg-emerald-500/5"
        : "";

  return (
    <td className={`w-1/2 px-3 py-1 ${background} ${border}`}>
      <span className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
        {line.value || " "}
      </span>
    </td>
  );
}

function SplitDiffView({
  rows,
  leftTitle,
  rightTitle,
}: {
  rows: SplitRow[];
  leftTitle: string;
  rightTitle: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="w-1/2 px-3 py-2 text-left text-xs font-semibold text-muted-foreground">
              {leftTitle}
            </th>
            <th className="w-1/2 border-l border-border px-3 py-2 text-left text-xs font-semibold text-muted-foreground">
              {rightTitle}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-border/60 last:border-b-0">
              <SplitCell line={row.left} />
              <SplitCell line={row.right} borderLeft />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function DocumentComparison({ documents }: { documents: DocumentOption[] }) {
  const [docA, setDocA] = useState<LoadedDocument | null>(null);
  const [docB, setDocB] = useState<LoadedDocument | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadDocument = useCallback(
    (side: "A" | "B") => async (id: string) => {
      if (!id) {
        if (side === "A") setDocA(null);
        else setDocB(null);
        return;
      }

      setError(null);
      startTransition(async () => {
        const result = await getDocumentText(id);

        if (result.error || result.text === null) {
          setError(result.error ?? "Document text could not be loaded.");
          return;
        }

        const loaded: LoadedDocument = { id, text: result.text };
        if (side === "A") setDocA(loaded);
        else setDocB(loaded);
      });
    },
    []
  );

  const diff = docA && docB ? computeDiff(docA.text, docB.text) : null;
  const stats = diff ? getDiffStats(diff) : null;
  const splitRows = diff && viewMode === "split" ? toSplitRows(diff) : null;

  const titleFor = (loaded: LoadedDocument | null) =>
    documents.find((document) => document.id === loaded?.id)?.filename ?? "";

  return (
    <div className="grid gap-5">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <DocumentSelector
            label="Document A"
            options={documents}
            selectedId={docA?.id ?? null}
            disabledId={docB?.id ?? null}
            onChange={loadDocument("A")}
          />
          <DocumentSelector
            label="Document B"
            options={documents}
            selectedId={docB?.id ?? null}
            disabledId={docA?.id ?? null}
            onChange={loadDocument("B")}
          />
        </div>

        {error ? (
          <p className="mt-4 text-sm text-destructive">{error}</p>
        ) : null}

        {isPending ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Loading extracted document text...
          </p>
        ) : null}
      </div>

      {!diff ? (
        <EmptyState message="Select two documents to compare." />
      ) : (
        <>
          <StatsBar
            added={stats!.added}
            removed={stats!.removed}
            equal={stats!.equal}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />

          {stats!.added === 0 && stats!.removed === 0 ? (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
              The two documents are identical.
            </div>
          ) : viewMode === "unified" ? (
            <UnifiedDiffView diff={diff} />
          ) : (
            <SplitDiffView
              rows={splitRows!}
              leftTitle={titleFor(docA)}
              rightTitle={titleFor(docB)}
            />
          )}
        </>
      )}
    </div>
  );
}
