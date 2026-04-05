"use client";

import { useState, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  Trash2,
  LoaderCircle,
  Sparkles,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type DocumentInfo = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string | null;
  createdAt: string;
  resumeVariant: { id: string; label: string } | null;
};

type Props = {
  documents: DocumentInfo[];
  aiAvailable: boolean;
};

type ParseResult = {
  merge: {
    fieldsUpdated: string[];
    experiencesAdded: number;
    educationsAdded: number;
    projectsAdded: number;
    skillsAdded: number;
  };
} | null;

export function ResumeUpload({ documents: initialDocs, aiAvailable }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult>(null);

  function handleUpload() {
    fileInputRef.current?.click();
  }

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setParseResult(null);

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("type", "RESUME");

        const res = await fetch("/api/profile/documents", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "Upload failed");
        }

        router.refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    });
  }

  function handleDelete(docId: string) {
    setDeletingId(docId);
    setParseResult(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/profile/documents/${docId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "Delete failed");
        }
        router.refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    });
  }

  function handleParse(docId: string) {
    setParsingId(docId);
    setUploadError(null);
    setParseResult(null);

    startTransition(async () => {
      try {
        const res = await fetch(`/api/profile/documents/${docId}/parse`, {
          method: "POST",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "Parse failed");
        }
        const data = await res.json();
        setParseResult(data);
        router.refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Parse failed");
      } finally {
        setParsingId(null);
      }
    });
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div>
      {/* Upload button */}
      <div className="mb-3 flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={handleUpload} disabled={isPending}>
          {isPending && !parsingId ? (
            <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="mr-1.5 h-3.5 w-3.5" />
          )}
          Upload resume
        </Button>
        <span className="text-xs text-muted-foreground">PDF or DOCX, max 10 MB</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onFileSelected}
          className="hidden"
        />
      </div>

      {uploadError && (
        <p className="mb-3 text-xs text-destructive">{uploadError}</p>
      )}

      {/* Parse result banner */}
      {parseResult && (
        <div className="mb-3 rounded-md border border-green-500/30 bg-green-500/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
            <Check className="h-4 w-4" />
            Resume parsed and merged into profile
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">
            {parseResult.merge.fieldsUpdated.length > 0 && (
              <p>Fields updated: {parseResult.merge.fieldsUpdated.join(", ")}</p>
            )}
            {parseResult.merge.skillsAdded > 0 && (
              <p>{parseResult.merge.skillsAdded} skills added</p>
            )}
            {parseResult.merge.experiencesAdded > 0 && (
              <p>{parseResult.merge.experiencesAdded} experiences added</p>
            )}
            {parseResult.merge.educationsAdded > 0 && (
              <p>{parseResult.merge.educationsAdded} educations added</p>
            )}
            {parseResult.merge.projectsAdded > 0 && (
              <p>{parseResult.merge.projectsAdded} projects added</p>
            )}
            {parseResult.merge.fieldsUpdated.length === 0 &&
              parseResult.merge.skillsAdded === 0 &&
              parseResult.merge.experiencesAdded === 0 &&
              parseResult.merge.educationsAdded === 0 &&
              parseResult.merge.projectsAdded === 0 && (
                <p>Profile already up to date — no new data to merge.</p>
              )}
          </div>
        </div>
      )}

      {/* Document list */}
      {initialDocs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
      ) : (
        <div className="space-y-3">
          {initialDocs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-start gap-3 rounded-md border border-border/60 p-3"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{doc.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {formatSize(doc.sizeBytes)}
                  {doc.resumeVariant && (
                    <> · Linked to variant: {doc.resumeVariant.label}</>
                  )}
                </p>
                {doc.extractedText && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {doc.extractedText.slice(0, 300)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Parse with AI button */}
                {aiAvailable && doc.extractedText && (
                  <button
                    type="button"
                    onClick={() => handleParse(doc.id)}
                    disabled={parsingId === doc.id || isPending}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-50"
                    title="Parse with AI and merge into profile"
                  >
                    {parsingId === doc.id ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => handleDelete(doc.id)}
                  disabled={deletingId === doc.id || isPending}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                  title="Delete document"
                >
                  {deletingId === doc.id ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!aiAvailable && initialDocs.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Set ANTHROPIC_API_KEY in .env to enable AI-powered resume parsing.
        </p>
      )}
    </div>
  );
}
