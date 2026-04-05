"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, MoreHorizontal } from "lucide-react";

import {
  deleteProfileResume,
  deleteTemplate,
  renameDocument,
  setPrimaryProfileResume,
  setPrimaryTemplate,
  uploadTemplate,
} from "@/app/profile/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { useNotifications } from "@/components/ui/notification-provider";
import { useActionToast } from "@/components/ui/use-action-toast";
import { supportedResumeAcceptValue, type ResumeImportSummary } from "@/lib/resume-shared";

const SUPPORTED_TEMPLATE_ACCEPT =
  ".tex,.cls,.sty,.typ,.txt,.md,.html,.css,.json,.yaml,.yml,.xml,.rtf";

type ResumeRecord = {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: string;
  sizeLabel: string;
  createdAtLabel: string;
  isPrimary: boolean;
  downloadHref: string;
  importSummary: ResumeImportSummary | null;
  isImported: boolean;
};

type TemplateRecord = {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: string;
  isPrimary: boolean;
  downloadHref: string;
};

type ResumeManagerProps = {
  resumes: ResumeRecord[];
  templates: TemplateRecord[];
  storageConfigured: boolean;
};

async function readRoutePayload(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: unknown; message?: unknown }
    | null;

  return {
    error: typeof payload?.error === "string" ? payload.error : null,
    message: typeof payload?.message === "string" ? payload.message : null,
  };
}

function ResumeRow({ resume }: { resume: ResumeRecord }) {
  const router = useRouter();
  const { notify } = useNotifications();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(resume.title);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncPending, setSyncPending] = useState(false);

  const [primaryState, primaryAction] = useActionState(setPrimaryProfileResume, {
    error: null,
    success: null,
  });
  const [deleteState, deleteAction] = useActionState(deleteProfileResume, {
    error: null,
    success: null,
  });
  const [renameState, renameAction] = useActionState(renameDocument, {
    error: null,
    success: null,
  });
  useActionToast(primaryState, {
    successTitle: "Resume updated",
    errorTitle: "Could not update resume",
  });
  useActionToast(deleteState, {
    successTitle: "Resume deleted",
    errorTitle: "Could not delete resume",
  });
  useActionToast(renameState, {
    successTitle: "Resume renamed",
    errorTitle: "Could not rename resume",
  });

  useEffect(() => {
    if (primaryState.success || deleteState.success || renameState.success) {
      router.refresh();
    }
  }, [deleteState.success, primaryState.success, renameState.success, router]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
    }
  }, [renaming]);

  function dispatch(action: (payload: FormData) => void) {
    const payload = new FormData();
    payload.set("documentId", resume.id);
    startTransition(() => action(payload));
  }

  async function syncResume() {
    if (syncPending) {
      return;
    }

    setSyncPending(true);
    setSyncError(null);

    try {
      const response = await fetch(`/api/profile/resumes/${resume.id}/sync`, {
        method: "POST",
      });
      const payload = await readRoutePayload(response);

      if (!response.ok) {
        throw new Error(payload.error ?? "Resume extraction failed.");
      }

      notify({
        title: "Resume synced",
        message: payload.message ?? "Your profile was updated from this resume.",
        tone: "success",
      });
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resume extraction failed.";
      setSyncError(message);
      notify({
        title: "Could not sync resume",
        message,
        tone: "error",
      });
    } finally {
      setSyncPending(false);
    }
  }

  function submitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === resume.title) {
      setRenaming(false);
      setRenameValue(resume.title);
      return;
    }

    const payload = new FormData();
    payload.set("documentId", resume.id);
    payload.set("title", trimmed);
    setRenaming(false);
    startTransition(() => renameAction(payload));
  }

  const error = primaryState.error ?? deleteState.error ?? renameState.error ?? syncError;

  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {renaming ? (
              <input
                ref={renameInputRef}
                className="h-8 min-w-0 rounded-lg border border-input/80 bg-background/70 px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                onBlur={submitRename}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitRename();
                  if (event.key === "Escape") {
                    setRenaming(false);
                    setRenameValue(resume.title);
                  }
                }}
                value={renameValue}
              />
            ) : (
              <span className="truncate text-sm font-medium text-foreground">{resume.title}</span>
            )}
            {resume.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{resume.originalFileName}</p>
        </div>
        {renaming ? null : (
          <div className="flex items-center gap-2">
            <Button render={<a href={resume.downloadHref} />} className="h-8 px-3 text-xs" size="sm" variant="secondary">
              Download
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground">
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!resume.isPrimary ? (
                  <DropdownMenuItem className="cursor-pointer" onClick={() => dispatch(primaryAction)}>
                    Make primary
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className="cursor-pointer" onClick={() => void syncResume()}>
                  {syncPending
                    ? "Syncing..."
                    : resume.isImported
                      ? "Re-sync to profile"
                      : "Import to profile"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => {
                    setRenaming(true);
                    setRenameValue(resume.title);
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{resume.mimeType}</span>
        <span>{resume.sizeLabel}</span>
        <span>{resume.createdAtLabel}</span>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      <ConfirmActionDialog
        confirmLabel="Delete"
        description={`Delete "${resume.title}"? If it is primary, another resume will be promoted.`}
        destructive
        onConfirm={() => dispatch(deleteAction)}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Delete resume?"
      />
    </div>
  );
}

function TemplateRow({ template }: { template: TemplateRecord }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(template.title);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [primaryState, primaryAction] = useActionState(setPrimaryTemplate, {
    error: null,
    success: null,
  });
  const [deleteState, deleteAction] = useActionState(deleteTemplate, {
    error: null,
    success: null,
  });
  const [renameState, renameAction] = useActionState(renameDocument, {
    error: null,
    success: null,
  });
  useActionToast(primaryState, {
    successTitle: "Template updated",
    errorTitle: "Could not update template",
  });
  useActionToast(deleteState, {
    successTitle: "Template deleted",
    errorTitle: "Could not delete template",
  });
  useActionToast(renameState, {
    successTitle: "Template renamed",
    errorTitle: "Could not rename template",
  });

  useEffect(() => {
    if (primaryState.success || deleteState.success || renameState.success) {
      router.refresh();
    }
  }, [deleteState.success, primaryState.success, renameState.success, router]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
    }
  }, [renaming]);

  function dispatch(action: (payload: FormData) => void) {
    const payload = new FormData();
    payload.set("documentId", template.id);
    startTransition(() => action(payload));
  }

  function submitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === template.title) {
      setRenaming(false);
      setRenameValue(template.title);
      return;
    }

    const payload = new FormData();
    payload.set("documentId", template.id);
    payload.set("title", trimmed);
    setRenaming(false);
    startTransition(() => renameAction(payload));
  }

  const error = primaryState.error ?? deleteState.error ?? renameState.error;

  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {renaming ? (
              <input
                ref={renameInputRef}
                className="h-8 min-w-0 rounded-lg border border-input/80 bg-background/70 px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                onBlur={submitRename}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitRename();
                  if (event.key === "Escape") {
                    setRenaming(false);
                    setRenameValue(template.title);
                  }
                }}
                value={renameValue}
              />
            ) : (
              <span className="truncate text-sm font-medium text-foreground">{template.title}</span>
            )}
            {template.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{template.originalFileName}</p>
        </div>
        {renaming ? null : (
          <div className="flex items-center gap-2">
            <Button render={<a href={template.downloadHref} />} className="h-8 px-3 text-xs" size="sm" variant="secondary">
              Download
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground">
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!template.isPrimary ? (
                  <DropdownMenuItem className="cursor-pointer" onClick={() => dispatch(primaryAction)}>
                    Make primary
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => {
                    setRenaming(true);
                    setRenameValue(template.title);
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{template.mimeType}</p>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      <ConfirmActionDialog
        confirmLabel="Delete"
        description={`Delete "${template.title}" from your template library.`}
        destructive
        onConfirm={() => dispatch(deleteAction)}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Delete template?"
      />
    </div>
  );
}

function AddResumeForm({
  storageConfigured,
  resumeCount,
  formIndex,
  onDone,
}: {
  storageConfigured: boolean;
  resumeCount: number;
  formIndex: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const { notify } = useNotifications();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!formRef.current || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/profile/resumes", {
        method: "POST",
        body: new FormData(formRef.current),
      });
      const payload = await readRoutePayload(response);

      if (!response.ok) {
        throw new Error(payload.error ?? "Resume upload failed.");
      }

      notify({
        title: "Resume uploaded",
        message: payload.message ?? "Your resume was added to your library.",
        tone: "success",
      });
      formRef.current.reset();
      router.refresh();
      onDone();
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Resume upload failed.";
      setError(message);
      notify({
        title: "Could not upload resume",
        message,
        tone: "error",
      });
    } finally {
      setPending(false);
    }
  }

  const titleId = `resume-title-${formIndex}`;
  const fileId = `resume-file-${formIndex}`;

  return (
    <form
      className="rounded-lg border border-border/70 bg-muted/20 p-3"
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={titleId}>
            Label
          </label>
          <Input
            className="h-8 text-sm"
            id={titleId}
            name="title"
            placeholder="e.g. Winter 2026 SWE resume"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={fileId}>
            File
          </label>
          <FileInput
            accept={supportedResumeAcceptValue}
            className="h-8 text-sm"
            id={fileId}
            name="file"
            required
          />
        </div>
        <div className="flex items-end gap-2">
          <Button className="h-8 px-3 text-xs" disabled={!storageConfigured || pending} size="sm" type="submit">
            {pending ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Uploading...
              </>
            ) : (
              "Upload"
            )}
          </Button>
          <Button className="h-8 px-3 text-xs" disabled={pending} onClick={onDone} size="sm" type="button" variant="secondary">
            Cancel
          </Button>
        </div>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <input
          className="h-3.5 w-3.5 rounded border-border"
          defaultChecked={resumeCount === 0 && formIndex === 0}
          name="makePrimary"
          type="checkbox"
        />
        Set as primary
      </label>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

function AddTemplateForm({
  storageConfigured,
  templateCount,
  onDone,
}: {
  storageConfigured: boolean;
  templateCount: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(uploadTemplate, {
    error: null,
    success: null,
  });
  useActionToast(state, {
    successTitle: "Template uploaded",
    errorTitle: "Could not upload template",
  });

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      router.refresh();
      onDone();
    }
  }, [onDone, router, state.success]);

  return (
    <form action={formAction} className="rounded-lg border border-border/70 bg-muted/20 p-3" ref={formRef}>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="template-title">
            Label
          </label>
          <Input
            className="h-8 text-sm"
            id="template-title"
            name="title"
            placeholder="e.g. moderncv banking"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="template-file">
            File
          </label>
          <FileInput
            accept={SUPPORTED_TEMPLATE_ACCEPT}
            className="h-8 text-sm"
            id="template-file"
            name="file"
            required
          />
        </div>
        <div className="flex items-end gap-2">
          <Button className="h-8 px-3 text-xs" disabled={!storageConfigured || pending} size="sm" type="submit">
            {pending ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Uploading...
              </>
            ) : (
              "Upload"
            )}
          </Button>
          <Button className="h-8 px-3 text-xs" onClick={onDone} size="sm" type="button" variant="secondary">
            Cancel
          </Button>
        </div>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <input
          className="h-3.5 w-3.5 rounded border-border"
          defaultChecked={templateCount === 0}
          name="makePrimary"
          type="checkbox"
        />
        Set as primary
      </label>
      {state.error ? <p className="mt-2 text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}

export function ResumeManager({
  resumes,
  templates,
  storageConfigured,
}: ResumeManagerProps) {
  const [resumeFormKeys, setResumeFormKeys] = useState<number[]>([]);
  const nextResumeKey = useRef(0);
  const [showAddTemplate, setShowAddTemplate] = useState(false);

  function addResumeForm() {
    setResumeFormKeys((keys) => [...keys, nextResumeKey.current++]);
  }

  function removeResumeForm(key: number) {
    setResumeFormKeys((keys) => keys.filter((k) => k !== key));
  }

  return (
    <div className="grid gap-6">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Resumes</h3>
          <span className="text-xs text-muted-foreground">{resumes.length}</span>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          Upload resume versions here, keep one primary, and sync any version back into the structured profile.
        </p>

        {resumes.length === 0 && resumeFormKeys.length === 0 ? (
          <p className="py-2 text-sm italic text-muted-foreground">No resumes yet.</p>
        ) : (
          <div className="grid gap-2">
            {resumes.map((resume) => (
              <ResumeRow key={resume.id} resume={resume} />
            ))}
          </div>
        )}

        {resumeFormKeys.length > 0 ? (
          <div className="mt-2 grid gap-2">
            {resumeFormKeys.map((key, index) => (
              <AddResumeForm
                key={key}
                formIndex={index}
                onDone={() => removeResumeForm(key)}
                resumeCount={resumes.length}
                storageConfigured={storageConfigured}
              />
            ))}
          </div>
        ) : null}

        <button
          className="mt-2 rounded-md px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
          onClick={addResumeForm}
          type="button"
        >
          + Add resume
        </button>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Resume templates</h3>
          <span className="text-xs text-muted-foreground">{templates.length}</span>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          Upload a text-readable format file. The primary template is used when generating tailored resumes.
        </p>

        {templates.length === 0 && !showAddTemplate ? (
          <p className="py-2 text-sm italic text-muted-foreground">No templates yet.</p>
        ) : (
          <div className="grid gap-2">
            {templates.map((template) => (
              <TemplateRow key={template.id} template={template} />
            ))}
          </div>
        )}

        {showAddTemplate ? (
          <div className="mt-2">
            <AddTemplateForm
              onDone={() => setShowAddTemplate(false)}
              storageConfigured={storageConfigured}
              templateCount={templates.length}
            />
          </div>
        ) : (
          <button
            className="mt-2 rounded-md px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
            onClick={() => setShowAddTemplate(true)}
            type="button"
          >
            + Add template
          </button>
        )}
      </div>
    </div>
  );
}
