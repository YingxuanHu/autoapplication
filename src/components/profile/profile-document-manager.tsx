"use client";

import { useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Download,
  FileText,
  LoaderCircle,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type DocumentInfo = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string | null;
  createdAt: string;
  downloadHref: string;
  resumeVariant: { id: string; label: string } | null;
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

type ProfileDocumentManagerProps = {
  aiAvailable?: boolean;
  documents: DocumentInfo[];
  type: "RESUME" | "COVER_LETTER";
};

export function ProfileDocumentManager({
  aiAvailable = false,
  documents: initialDocs,
  type,
}: ProfileDocumentManagerProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult>(null);

  const isResumeLibrary = type === "RESUME";
  const uploadLabel = isResumeLibrary ? "Upload resume" : "Upload cover letter";
  const helperText = isResumeLibrary
    ? "PDF or DOCX, max 10 MB. Parse into your structured profile after upload."
    : "PDF or DOCX, max 10 MB. Store polished versions for manual submissions and tracker linking.";
  const emptyText = isResumeLibrary
    ? "No resumes uploaded yet."
    : "No cover letters stored yet.";

  function handleUpload() {
    fileInputRef.current?.click();
  }

  function onFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setParseResult(null);

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("type", type);

        const response = await fetch("/api/profile/documents", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error ?? "Upload failed");
        }

        router.refresh();
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
      } finally {
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    });
  }

  function handleDelete(documentId: string) {
    setDeletingId(documentId);
    setError(null);
    setParseResult(null);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/profile/documents/${documentId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error ?? "Delete failed");
        }

        router.refresh();
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    });
  }

  function handleParse(documentId: string) {
    if (!isResumeLibrary) return;

    setParsingId(documentId);
    setError(null);
    setParseResult(null);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/profile/documents/${documentId}/parse`, {
          method: "POST",
        });

        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error ?? "Parse failed");
        }

        const data = await response.json();
        setParseResult(data);
        router.refresh();
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : "Parse failed");
      } finally {
        setParsingId(null);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 bg-background/60 p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {isResumeLibrary ? "Resume library" : "Cover letter library"}
          </p>
          <p className="max-w-2xl text-sm text-muted-foreground">{helperText}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleUpload} disabled={isPending} size="sm" variant="outline">
            {isPending && !parsingId ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {uploadLabel}
          </Button>
          <input
            ref={fileInputRef}
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={onFileSelected}
            type="file"
          />
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {parseResult ? (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
            <Check className="h-4 w-4" />
            Resume parsed and merged into profile
          </div>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {parseResult.merge.fieldsUpdated.length > 0 ? (
              <p>Fields updated: {parseResult.merge.fieldsUpdated.join(", ")}</p>
            ) : null}
            {parseResult.merge.skillsAdded > 0 ? (
              <p>{parseResult.merge.skillsAdded} skills added</p>
            ) : null}
            {parseResult.merge.experiencesAdded > 0 ? (
              <p>{parseResult.merge.experiencesAdded} experiences added</p>
            ) : null}
            {parseResult.merge.educationsAdded > 0 ? (
              <p>{parseResult.merge.educationsAdded} education entries added</p>
            ) : null}
            {parseResult.merge.projectsAdded > 0 ? (
              <p>{parseResult.merge.projectsAdded} projects added</p>
            ) : null}
            {parseResult.merge.fieldsUpdated.length === 0 &&
            parseResult.merge.skillsAdded === 0 &&
            parseResult.merge.experiencesAdded === 0 &&
            parseResult.merge.educationsAdded === 0 &&
            parseResult.merge.projectsAdded === 0 ? (
              <p>Profile already matched the uploaded resume. No new data was merged.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {initialDocs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-background/40 p-6 text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-3">
          {initialDocs.map((doc) => {
            const canParse = isResumeLibrary && aiAvailable && !!doc.extractedText;

            return (
              <div
                key={doc.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 bg-background/40 p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-3">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {doc.filename}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{formatSize(doc.sizeBytes)}</span>
                        <span>{formatDateTime(doc.createdAt)}</span>
                        {doc.resumeVariant ? (
                          <span>Linked variant: {doc.resumeVariant.label}</span>
                        ) : null}
                      </div>
                      {doc.extractedText ? (
                        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {doc.extractedText.slice(0, 260)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    render={<a href={doc.downloadHref} />}
                    size="sm"
                    variant="secondary"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                  {canParse ? (
                    <Button
                      disabled={parsingId === doc.id || isPending}
                      onClick={() => handleParse(doc.id)}
                      size="sm"
                      variant="outline"
                    >
                      {parsingId === doc.id ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      Parse to profile
                    </Button>
                  ) : null}
                  <Button
                    aria-label="Delete document"
                    disabled={deletingId === doc.id || isPending}
                    onClick={() => handleDelete(doc.id)}
                    size="icon-sm"
                    title="Delete document"
                    variant="ghost"
                  >
                    {deletingId === doc.id ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isResumeLibrary && !aiAvailable && initialDocs.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Set `OPENAI_API_KEY` in `.env` to enable AI-powered resume parsing.
        </p>
      ) : null}
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
