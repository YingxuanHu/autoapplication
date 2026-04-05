"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { LoaderCircle, MoreHorizontal } from "lucide-react";

import {
  deleteProfileCoverLetter,
  uploadProfileCoverLetter,
} from "@/app/profile/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { useActionToast } from "@/components/ui/use-action-toast";

type CoverLetterRecord = {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: string;
  sizeLabel: string;
  createdAtLabel: string;
  downloadHref: string;
};

type CoverLetterManagerProps = {
  coverLetters: CoverLetterRecord[];
  storageConfigured: boolean;
};

function CoverLetterRow({ coverLetter }: { coverLetter: CoverLetterRecord }) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteState, deleteAction] = useActionState(deleteProfileCoverLetter, {
    error: null,
    success: null,
  });
  useActionToast(deleteState, {
    successTitle: "Cover letter updated",
    errorTitle: "Could not update cover letter",
  });

  useEffect(() => {
    if (deleteState.success) {
      router.refresh();
    }
  }, [deleteState.success, router]);

  function dispatchDelete() {
    const payload = new FormData();
    payload.set("documentId", coverLetter.id);
    startTransition(() => deleteAction(payload));
  }

  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="truncate text-sm font-medium text-foreground">{coverLetter.title}</span>
          <p className="mt-1 truncate text-xs text-muted-foreground">{coverLetter.originalFileName}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button render={<a href={coverLetter.downloadHref} />} className="h-8 px-3 text-xs" size="sm" variant="secondary">
            Download
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground">
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                className="cursor-pointer"
                variant="destructive"
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{coverLetter.mimeType}</span>
        <span>{coverLetter.sizeLabel}</span>
        <span>{coverLetter.createdAtLabel}</span>
      </div>
      {deleteState.error ? <p className="mt-2 text-xs text-destructive">{deleteState.error}</p> : null}
      <ConfirmActionDialog
        confirmLabel="Delete"
        description={`Delete "${coverLetter.title}" from your cover letter library.`}
        destructive
        onConfirm={dispatchDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Delete cover letter?"
      />
    </div>
  );
}

function AddCoverLetterForm({
  storageConfigured,
  onDone,
}: {
  storageConfigured: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(uploadProfileCoverLetter, {
    error: null,
    success: null,
  });
  useActionToast(state, {
    successTitle: "Cover letter uploaded",
    errorTitle: "Could not upload cover letter",
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
          <label className="text-xs font-medium text-muted-foreground" htmlFor="cl-title">
            Label
          </label>
          <Input
            className="h-8 text-sm"
            id="cl-title"
            name="title"
            placeholder="e.g. Software engineering — general"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="cl-file">
            File
          </label>
          <FileInput
            accept=".pdf,.doc,.docx,.txt,.rtf"
            className="h-8 text-sm"
            id="cl-file"
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
      {state.error ? <p className="mt-2 text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}

export function CoverLetterManager({ coverLetters, storageConfigured }: CoverLetterManagerProps) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Cover letters</h3>
        <span className="text-xs text-muted-foreground">{coverLetters.length}</span>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Upload cover letter versions to your library and attach them to applications from the workspace.
      </p>

      {coverLetters.length === 0 && !showAdd ? (
        <p className="py-2 text-sm italic text-muted-foreground">No cover letters yet.</p>
      ) : (
        <div className="grid gap-2">
          {coverLetters.map((cl) => (
            <CoverLetterRow coverLetter={cl} key={cl.id} />
          ))}
        </div>
      )}

      {showAdd ? (
        <div className="mt-2">
          <AddCoverLetterForm onDone={() => setShowAdd(false)} storageConfigured={storageConfigured} />
        </div>
      ) : (
        <button
          className="mt-2 rounded-md px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
          onClick={() => setShowAdd(true)}
          type="button"
        >
          + Add cover letter
        </button>
      )}
    </div>
  );
}
