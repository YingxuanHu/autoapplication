"use client";

import { useRouter } from "next/navigation";
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFormStatus } from "react-dom";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileText,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";

import {
  addTimelineEvent,
  addTag,
  deleteTimelineEvent,
  importJobDescription,
  linkDocument,
  removeTag,
  unlinkDocument,
  updateTimelineEvent,
  updateApplicationField,
  updateApplicationHeader,
  updateApplicationStatus,
  uploadWorkspaceDocument,
} from "@/app/applications/[id]/actions";
import { AIWorkspace } from "@/components/jobs/ai-workspace";
import { JobAssistant } from "@/components/applications/job-assistant";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNotifications } from "@/components/ui/notification-provider";
import type { DocumentType, TrackedApplicationEventType, TrackedApplicationStatus } from "@/generated/prisma/client";
import { parseStoredFitAnalysis } from "@/lib/ai/fit-analysis-format";
import { getJobDescriptionSummaryBlocks } from "@/lib/job-description-format";
import { TRACKED_STATUS_LABEL, trackedStatusClass } from "@/lib/tracker-ui";

type ActionState = {
  error: string | null;
  success: string | null;
};

type Tag = {
  id: string;
  name: string;
};

type DocumentLink = {
  id: string;
  slot: "SENT_RESUME" | "SENT_COVER_LETTER";
  document: {
    id: string;
    title: string;
    type: DocumentType;
    isAiGenerated: boolean;
    analysis: { documentId: string } | null;
  };
};

type TimelineEvent = {
  id: string;
  type: TrackedApplicationEventType;
  timestamp: Date;
  note: string | null;
  reminderAt: Date | null;
  reminderNotifiedAt?: Date | null;
};

type UserDocument = {
  id: string;
  title: string;
  type: DocumentType;
  isAiGenerated: boolean;
  isPrimary: boolean;
  analysis: { documentId: string } | null;
};

type GeneratedApplicationDocument = {
  id: string;
  title: string;
  type: DocumentType;
  filename: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string | null;
  createdAt: Date;
};

type WorkspaceApplication = {
  id: string;
  canonicalJob: {
    id: string;
  } | null;
  company: string;
  roleTitle: string;
  roleUrl: string | null;
  status: TrackedApplicationStatus;
  deadline: Date | null;
  jobDescription: string | null;
  fitAnalysis: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  events: TimelineEvent[];
  documentLinks: DocumentLink[];
  tags: Array<{ tag: Tag }>;
};

type WorkspaceClientProps = {
  aiConfigured: boolean;
  application: WorkspaceApplication;
  generatedDocuments: GeneratedApplicationDocument[];
  // When the page was opened via `/applications/{id}?edit=1` (e.g. from the
  // Edit link on the applications list), pre-open the header editor so the
  // user can change company / title / link without an extra click.
  initialHeaderEditing?: boolean;
  userDocuments: UserDocument[];
  userTags: Tag[];
};

const statusOptions = [
  { value: "WISHLIST", label: "Wishlist" },
  { value: "APPLIED", label: "Applied" },
  { value: "SCREEN", label: "Screen" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OFFER", label: "Offer" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "REJECTED", label: "Rejected" },
  { value: "DECLINED", label: "Declined" },
  { value: "WITHDRAWN", label: "Closed" },
] as const satisfies ReadonlyArray<{
  value: TrackedApplicationStatus;
  label: string;
}>;

const statusBadgeClass: Record<string, string> = {
  REMINDER: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  NOTE: "border-border/70 bg-background text-muted-foreground",
};

const ACCEPT_RESUME = ".pdf,.doc,.docx,.txt,.rtf,.png,.jpg,.jpeg,.webp";
const ACCEPT_COVER_LETTER = ".pdf,.doc,.docx,.txt,.rtf";
const WORKSPACE_FIELD_TITLE_CLASS = "text-[0.95rem] font-semibold tracking-tight text-foreground";
const TIMELINE_STATUS_EVENT_TYPES = new Set<TrackedApplicationEventType>([
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
  "DECLINED",
]);
const INITIAL_ACTION_STATE: ActionState = {
  error: null,
  success: null,
};

function renderInlineBold(text: string, tone: "assistant" | "user" = "assistant"): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <strong
        className={tone === "user" ? "font-semibold text-background" : "font-semibold text-foreground"}
        key={match.index}
      >
        {match[1]}
      </strong>
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function renderDescriptionSummary(text: string) {
  return getJobDescriptionSummaryBlocks(text, 7).map((block, index) => {
    if (block.kind === "header") {
      return (
        <p className="mt-3 text-sm font-semibold text-foreground first:mt-0" key={index}>
          {block.text}
        </p>
      );
    }

    if (block.kind === "list") {
      return (
        <ul className="ml-4 space-y-1 text-sm text-foreground/80" key={index}>
          {block.items.map((item, itemIndex) => (
            <li className="list-disc leading-relaxed" key={`${item}-${itemIndex}`}>
              {item}
            </li>
          ))}
        </ul>
      );
    }

    return (
      <p className="text-sm leading-relaxed text-foreground/80" key={index}>
        {renderInlineBold(block.text)}
      </p>
    );
  });
}

function formatDate(date: Date | null) {
  if (!date) return "Not set";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(date: Date) {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isGeneratedStatusNote(event: TimelineEvent) {
  if (!event.note) return false;
  if (event.type === "NOTE") {
    return (
      event.note === "Status updated to Preparing." ||
      event.note === `Status updated to ${TRACKED_STATUS_LABEL.PREPARING}.`
    );
  }

  if (!["APPLIED", "SCREEN", "INTERVIEW", "OFFER", "ACCEPTED", "REJECTED", "DECLINED"].includes(event.type)) {
    return false;
  }

  const eventStatus = event.type as Extract<
    TrackedApplicationEventType,
    "APPLIED" | "SCREEN" | "INTERVIEW" | "OFFER" | "ACCEPTED" | "REJECTED" | "DECLINED"
  >;

  return event.note === `Status updated to ${TRACKED_STATUS_LABEL[eventStatus]}.`;
}

function isCreationEvent(event: TimelineEvent) {
  if (event.type !== "NOTE" || !event.note) return false;

  return (
    event.note === "Application added to tracker." ||
    event.note === "Application created." ||
    event.note === "Application added to tracker from the jobs feed." ||
    event.note === "Application created from the jobs feed." ||
    event.note.startsWith("Application added to tracker with status ") ||
    event.note.startsWith("Application created with status ") ||
    event.note.startsWith("Application added to tracker from the jobs feed as ") ||
    event.note.startsWith("Application created from the jobs feed as ")
  );
}

function timelineEventBadgeClass(eventType: TrackedApplicationEventType) {
  if (TIMELINE_STATUS_EVENT_TYPES.has(eventType)) {
    return `border-transparent ${trackedStatusClass(eventType as TrackedApplicationStatus)}`;
  }

  return statusBadgeClass[eventType] ?? statusBadgeClass.NOTE;
}

function useActionNotifications(state: ActionState) {
  const { notify } = useNotifications();
  const lastMessageRef = useRef<string | null>(null);

  useEffect(() => {
    const key = state.error
      ? `error:${state.error}`
      : state.success
        ? `success:${state.success}`
        : null;

    if (!key || key === lastMessageRef.current) {
      return;
    }

    lastMessageRef.current = key;
    notify({
      title: state.error ? "Request failed" : "Saved",
      message: state.error ?? state.success ?? "",
      tone: state.error ? "error" : "success",
    });
  }, [notify, state.error, state.success]);
}

function SubmitBtn({
  label,
  saving,
  variant,
}: {
  label: string;
  saving: string;
  // Optional — primarily so destructive submit buttons (Remove / Unlink)
  // render in red. Other callers can omit and get the default style.
  variant?: "default" | "destructive" | "ghost" | "outline" | "secondary";
}) {
  const { pending } = useFormStatus();

  return (
    <Button className="h-8 px-3 text-xs" disabled={pending} size="sm" type="submit" variant={variant}>
      {pending ? (
        <>
          <LoadingSpinner className="h-3 w-3" />
          {saving}
        </>
      ) : (
        label
      )}
    </Button>
  );
}

/**
 * Header editor for an application's identity fields (company, role title,
 * job link). Renders read-only by default with a single "Edit" button. When
 * Edit is clicked, all three fields turn into inputs and Save/Cancel buttons
 * appear. One submit writes all three atomically via updateApplicationHeader.
 */
function ApplicationHeaderEditor({
  application,
  editing,
  onClose,
}: {
  application: { id: string; company: string; roleTitle: string; roleUrl: string | null };
  editing: boolean;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(updateApplicationHeader, INITIAL_ACTION_STATE);
  useActionNotifications(state);

  function handleCancel() {
    onClose();
  }

  if (editing) {
    return (
      <form
        action={async (formData) => {
          await formAction(formData);
          onClose();
        }}
        className="space-y-3"
      >
        <input name="applicationId" type="hidden" value={application.id} />
        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Company
          </label>
          <Input
            autoFocus
            className="h-10 text-base font-semibold"
            defaultValue={application.company}
            name="company"
            placeholder="Company name"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Job title
          </label>
          <Input
            className="h-10"
            defaultValue={application.roleTitle}
            name="roleTitle"
            placeholder="Job title"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Job link
          </label>
          <Input
            className="h-10"
            defaultValue={application.roleUrl ?? ""}
            name="roleUrl"
            placeholder="https://..."
            type="url"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <SubmitBtn label="Save" saving="Saving..." />
          <Button
            className="h-9 px-3 text-xs"
            onClick={handleCancel}
            size="sm"
            type="button"
            variant="secondary"
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  // Read-only header layout — mirrors the applications list:
  //   Row 1: role title (the headline, large + bold)
  //   Row 2: company (bold, normal text size)
  //   Row 3: posting link
  return (
    <div className="space-y-2">
      <h2 className="text-ellipsis-2 text-xl font-semibold leading-snug text-foreground sm:text-2xl">
        {application.roleTitle}
      </h2>
      <p className="text-ellipsis-1 text-base font-semibold text-foreground">{application.company}</p>
      {application.roleUrl ? (
        <a
          className="inline-block max-w-full truncate text-sm font-medium text-foreground/80 underline underline-offset-2 hover:text-foreground"
          href={application.roleUrl}
          rel="noreferrer"
          target="_blank"
        >
          View job posting
        </a>
      ) : (
        <p className="text-sm italic text-muted-foreground">No job link</p>
      )}
    </div>
  );
}

function TagChip({ applicationId, tag }: { applicationId: string; tag: Tag }) {
  const [state, formAction] = useActionState(removeTag, INITIAL_ACTION_STATE);
  useActionNotifications(state);

  return (
    <form action={formAction}>
      <input name="applicationId" type="hidden" value={applicationId} />
      <input name="tagId" type="hidden" value={tag.id} />
      <button
        className="group/tag inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-xs font-medium text-foreground transition hover:border-destructive/30 hover:bg-destructive/5"
        title={`Remove "${tag.name}"`}
        type="submit"
      >
        {tag.name}
        {/* × is the explicit "remove" affordance — render in red so the
            destructive intent is unambiguous on hover. */}
        <span aria-hidden className="text-destructive/70 group-hover/tag:text-destructive">
          ×
        </span>
      </button>
    </form>
  );
}

function AttachDocumentControl({
  applicationId,
  slot,
  label,
  documents,
  currentLink,
}: {
  applicationId: string;
  slot: "SENT_RESUME" | "SENT_COVER_LETTER";
  label: string;
  documents: UserDocument[];
  currentLink: DocumentLink | undefined;
}) {
  const [showUpload, setShowUpload] = useState(false);
  const [linkState, linkAction] = useActionState(linkDocument, INITIAL_ACTION_STATE);
  const [unlinkState, unlinkAction] = useActionState(unlinkDocument, INITIAL_ACTION_STATE);
  const [uploadState, uploadAction] = useActionState(
    uploadWorkspaceDocument,
    INITIAL_ACTION_STATE
  );
  useActionNotifications(linkState);
  useActionNotifications(unlinkState);
  useActionNotifications(uploadState);

  const documentType = slot === "SENT_RESUME" ? "RESUME" : "COVER_LETTER";
  const accept = slot === "SENT_RESUME" ? ACCEPT_RESUME : ACCEPT_COVER_LETTER;
  const available = documents.filter((document) => document.type === documentType);
  const uploadedDocuments = available.filter((document) => !document.isAiGenerated);
  const aiGeneratedDocuments = available.filter((document) => document.isAiGenerated);

  function linkExistingDocument(documentId: string) {
    const payload = new FormData();
    payload.set("applicationId", applicationId);
    payload.set("slot", slot);
    payload.set("documentId", documentId);
    startTransition(() => linkAction(payload));
  }

  function removeLinkedDocument() {
    const payload = new FormData();
    payload.set("applicationId", applicationId);
    payload.set("slot", slot);
    startTransition(() => unlinkAction(payload));
  }

  const currentTitle = currentLink?.document.title ?? null;
  const emptyLabel = documentType === "RESUME" ? "Choose resume" : "Choose cover letter";

  return (
    <div className="min-w-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={label}
          className="flex min-h-12 w-full max-w-full min-w-0 items-center justify-between gap-3 rounded-[14px] border border-border/70 bg-card px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:min-h-14 sm:w-56"
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {label}
              </span>
              <span className="mt-0.5 block truncate text-sm leading-5 text-foreground">
                {currentTitle ?? emptyLabel}
              </span>
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {uploadedDocuments.length > 0 ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Uploaded by you</DropdownMenuLabel>
              {uploadedDocuments.map((document) => (
                <DropdownMenuItem
                  key={document.id}
                  onClick={() => linkExistingDocument(document.id)}
                >
                  <span className="truncate">{document.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ) : null}
          {aiGeneratedDocuments.length > 0 ? (
            <>
              {uploadedDocuments.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>AI generated</DropdownMenuLabel>
                {aiGeneratedDocuments.map((document) => (
                  <DropdownMenuItem
                    key={document.id}
                    onClick={() => linkExistingDocument(document.id)}
                  >
                    <span className="truncate">{document.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
          {available.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => setShowUpload(true)}>
            Upload new...
          </DropdownMenuItem>
          {currentLink ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={removeLinkedDocument} variant="destructive">
                Remove attachment
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {showUpload ? (
        <form
          action={async (formData) => {
            await uploadAction(formData);
            setShowUpload(false);
          }}
          className="grid gap-2 rounded-[14px] border border-border/70 bg-card p-3"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <input name="slot" type="hidden" value={slot} />
          <div className="space-y-1">
            <label
              className="block text-xs text-muted-foreground"
              htmlFor={`attach-title-${slot}`}
            >
              Title (optional)
            </label>
            <Input
              id={`attach-title-${slot}`}
              name="title"
              placeholder={`e.g. ${
                documentType === "RESUME" ? "Resume v2" : "Cover letter – Google"
              }`}
              type="text"
            />
          </div>
          <div className="space-y-1">
            <label
              className="block text-xs text-muted-foreground"
              htmlFor={`attach-file-${slot}`}
            >
              File <span className="text-muted-foreground">({accept})</span>
            </label>
            <FileInput
              accept={accept}
              className="hover:border-border"
              id={`attach-file-${slot}`}
              name="file"
              required
            />
          </div>
          {uploadState.error ? (
            <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {uploadState.error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <SubmitBtn label="Upload & attach" saving="Uploading..." />
            <Button
              className="h-8 px-3 text-xs"
              onClick={() => setShowUpload(false)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function StatusSelector({
  applicationId,
  currentStatus,
}: {
  applicationId: string;
  currentStatus: TrackedApplicationStatus;
}) {
  const [state, formAction] = useActionState(updateApplicationStatus, INITIAL_ACTION_STATE);
  useActionNotifications(state);

  return (
    <form action={formAction} className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
      <input name="applicationId" type="hidden" value={applicationId} />
      <div className="relative w-full min-w-0 sm:w-auto">
        <select
          className="h-10 w-full min-w-0 appearance-none rounded-[12px] border border-input bg-card py-0 pl-3.5 pr-12 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/25 sm:min-w-[156px]"
          defaultValue={currentStatus}
          key={currentStatus}
          name="status"
          onChange={(event) => {
            const form = event.target.closest("form");
            if (form) {
              form.requestSubmit();
            }
          }}
        >
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    </form>
  );
}

function WorkspaceActionsMenu({
  applicationId,
  existingTags,
  userTags,
  onEdit,
}: {
  applicationId: string;
  existingTags: Tag[];
  userTags: Tag[];
  onEdit: () => void;
}) {
  const router = useRouter();
  const { notify } = useNotifications();
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [tagState, tagAction, tagPending] = useActionState(addTag, INITIAL_ACTION_STATE);

  const suggestableTags = userTags.filter(
    (tag) => !existingTags.some((existingTag) => existingTag.id === tag.id)
  );

  useEffect(() => {
    if (tagState.success) {
      notify({ title: "Tag added", message: tagState.success, tone: "success" });
      setTagDialogOpen(false);
    } else if (tagState.error) {
      notify({ title: "Couldn't add tag", message: tagState.error, tone: "error" });
    }
  }, [notify, tagState]);

  function handleAddTagSubmit() {
    const name = tagInputRef.current?.value?.trim() ?? "";
    if (!name || tagPending) return;

    const formData = new FormData();
    formData.set("applicationId", applicationId);
    formData.set("name", name);
    startTransition(() => tagAction(formData));
  }

  async function handleDelete() {
    if (deletePending) return;

    setDeletePending(true);
    try {
      const response = await fetch(`/api/applications/${applicationId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Could not delete this application.");
      }
      notify({
        title: "Application deleted",
        message: "Removed from your applications.",
        tone: "success",
      });
      setDeleteDialogOpen(false);
      router.push("/applications");
      router.refresh();
    } catch (error) {
      notify({
        title: "Couldn't delete",
        message: error instanceof Error ? error.message : "Could not delete this application.",
        tone: "error",
      });
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Application actions"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[140px]">
          <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTagDialogOpen(true)}>Add tag</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setDeleteDialogOpen(true)}
            variant="destructive"
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmActionDialog
        cancelLabel="Cancel"
        confirmLabel={tagPending ? "Adding..." : "Add tag"}
        description={
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Tags help you filter and group applications.
            </p>
            {suggestableTags.length > 0 ? (
              <datalist id={`workspace-tag-suggestions-${applicationId}`}>
                {suggestableTags.map((tag) => (
                  <option key={tag.id} value={tag.name} />
                ))}
              </datalist>
            ) : null}
            <Input
              autoFocus
              list={
                suggestableTags.length > 0
                  ? `workspace-tag-suggestions-${applicationId}`
                  : undefined
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddTagSubmit();
                }
              }}
              placeholder="Tag name"
              ref={tagInputRef}
            />
          </div>
        }
        onConfirm={handleAddTagSubmit}
        onOpenChange={setTagDialogOpen}
        open={tagDialogOpen}
        pending={tagPending}
        title="Add tag"
      />

      <ConfirmActionDialog
        confirmLabel={deletePending ? "Deleting..." : "Delete"}
        description="Delete this job from your applications?"
        destructive
        onConfirm={handleDelete}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        pending={deletePending}
        title="Delete application?"
      />
    </>
  );
}

function JobDescriptionField({
  applicationId,
  hasRoleUrl,
  value,
}: {
  applicationId: string;
  hasRoleUrl: boolean;
  value: string;
}) {
  const [editing, setEditing] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteContent, setPasteContent] = useState("");
  const [draft, setDraft] = useState(value);
  const [importing, setImporting] = useState(false);

  const [editState, editAction] = useActionState(updateApplicationField, INITIAL_ACTION_STATE);
  const [importState, importAction] = useActionState(importJobDescription, INITIAL_ACTION_STATE);
  useActionNotifications(editState);
  useActionNotifications(importState);

  const importActionState = importState as ActionState & { fetchFailed?: boolean };
  const needsPaste = showPaste || importActionState.fetchFailed;
  const compactReadOnlyPreview = Boolean(value) && !editing && !needsPaste && !importing;

  function handleCancel() {
    setDraft(value);
    setEditing(false);
  }

  function handlePasteClick() {
    setShowPaste(true);
  }

  function handleImportFromLink() {
    setImporting(true);
    const formData = new FormData();
    formData.set("applicationId", applicationId);
    formData.set("content", "");
    startTransition(async () => {
      await importAction(formData);
      setImporting(false);
    });
  }

  return (
    <div
      className={`surface-panel min-w-0 p-3.5 sm:p-5 ${
        compactReadOnlyPreview
          ? "md:flex md:h-[clamp(20rem,42dvh,34rem)] md:flex-col md:overflow-hidden"
          : ""
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className={WORKSPACE_FIELD_TITLE_CLASS}>Job description</h3>
        <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:items-center sm:gap-1">
          {!editing && !showPaste && hasRoleUrl ? (
            <button
              className="min-w-0 truncate rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={handleImportFromLink}
              type="button"
            >
              {value ? "Re-import from link" : "Import from link"}
            </button>
          ) : null}
          {!editing && !showPaste ? (
            <button
              className="min-w-0 truncate rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={handlePasteClick}
              type="button"
            >
              Paste posting
            </button>
          ) : null}
          {!editing && !showPaste ? (
            <button
              className="min-w-0 truncate rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={() => setEditing(true)}
              type="button"
            >
              Edit
            </button>
          ) : null}
        </div>
      </div>

      {importState.error ? (
        <p className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {importState.error}
        </p>
      ) : null}

      {needsPaste && !editing ? (
        <form
          action={async (formData) => {
            setImporting(true);
            await importAction(formData);
            setImporting(false);
            setShowPaste(false);
            setPasteContent("");
          }}
          className="mt-3 grid gap-2"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <p className="text-xs text-muted-foreground">
            Paste the job posting content below and it will be cleaned up into an organized summary.
          </p>
          <Textarea
            className="min-h-[120px] resize-y text-sm"
            name="content"
            onChange={(event) => setPasteContent(event.target.value)}
            placeholder="Paste the full job posting text here..."
            rows={6}
            value={pasteContent}
          />
          <div className="flex gap-2">
            <SubmitBtn label="Organize & save" saving="Organizing..." />
            {hasRoleUrl && !pasteContent ? (
              <Button
                className="h-8 px-3 text-xs"
                onClick={() => {
                  setImporting(true);
                  const formData = new FormData();
                  formData.set("applicationId", applicationId);
                  formData.set("content", "");
                  startTransition(async () => {
                    await importAction(formData);
                    setImporting(false);
                  });
                  setShowPaste(false);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                Import from link
              </Button>
            ) : null}
            <Button
              className="h-8 px-3 text-xs"
              onClick={() => {
                setShowPaste(false);
                setPasteContent("");
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : editing ? (
        <form
          action={async (formData) => {
            await editAction(formData);
            setEditing(false);
          }}
          className="mt-3 grid gap-2"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <input name="field" type="hidden" value="jobDescription" />
          <Textarea
            className="min-h-[80px] resize-y text-sm"
            name="value"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste the job description here..."
            rows={4}
            value={draft}
          />
          <div className="flex gap-2">
            <SubmitBtn label="Save" saving="Saving..." />
            <Button
              className="h-8 px-3 text-xs"
              onClick={handleCancel}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : importing ? (
        <div className="mt-4 flex items-center justify-center gap-2 py-4">
          <LoadingSpinner className="h-4 w-4" />
          <span className="text-sm text-muted-foreground">Importing and organizing...</span>
        </div>
      ) : value ? (
        <div className="mt-3 max-h-[15rem] overflow-y-auto pr-2 [scrollbar-gutter:stable] md:min-h-0 md:flex-1 md:max-h-none">
          {renderDescriptionSummary(value)}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm italic text-muted-foreground">
            No job description yet. Import it from the posting link, paste the posting text, or edit it manually.
          </p>
        </div>
      )}
    </div>
  );
}

function toDateTimeLocalInputValue(date: Date | null) {
  if (!date) return "";
  const value = new Date(date);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function useBrowserTimeZone() {
  return useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    () => ""
  );
}

function compareReminderEvents(left: TimelineEvent, right: TimelineEvent) {
  const leftTime = left.reminderAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.reminderAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return right.timestamp.getTime() - left.timestamp.getTime();
}

function ReminderRow({
  applicationId,
  reminder,
}: {
  applicationId: string;
  reminder: TimelineEvent;
}) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(reminder.note ?? "");
  const [timeDraft, setTimeDraft] = useState(toDateTimeLocalInputValue(reminder.reminderAt));
  const [updateState, updateAction] = useActionState(updateTimelineEvent, INITIAL_ACTION_STATE);
  const [deleteState, deleteAction] = useActionState(deleteTimelineEvent, INITIAL_ACTION_STATE);
  const browserTimeZone = useBrowserTimeZone();
  useActionNotifications(updateState);
  useActionNotifications(deleteState);

  function cancelEdit() {
    setNoteDraft(reminder.note ?? "");
    setTimeDraft(toDateTimeLocalInputValue(reminder.reminderAt));
    setEditing(false);
  }

  function dispatchDelete() {
    const payload = new FormData();
    payload.set("applicationId", applicationId);
    payload.set("eventId", reminder.id);
    setDeleteOpen(false);
    startTransition(() => deleteAction(payload));
  }

  if (editing) {
    return (
      <form
        action={async (formData) => {
          await updateAction(formData);
          setEditing(false);
        }}
        className="rounded-[14px] border border-border/70 bg-card p-3"
      >
        <input name="applicationId" type="hidden" value={applicationId} />
        <input name="eventId" type="hidden" value={reminder.id} />
        <input name="type" type="hidden" value="REMINDER" />
        <input name="timeZone" type="hidden" value={browserTimeZone} />
        <div className="grid gap-2">
          <Textarea
            className="min-h-[78px] resize-y text-sm"
            name="note"
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder="Reminder"
            required
            rows={3}
            value={noteDraft}
          />
          <label className="grid gap-1.5 text-xs text-muted-foreground sm:max-w-72">
            <span className="font-medium uppercase tracking-[0.12em]">Notify at</span>
            <Input
              className="h-9 text-sm"
              name="reminderAt"
              onChange={(event) => setTimeDraft(event.target.value)}
              type="datetime-local"
              value={timeDraft}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <SubmitBtn label="Save reminder" saving="Saving..." />
            <Button
              className="h-8 px-3 text-xs"
              onClick={cancelEdit}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    // `min-w-0 overflow-hidden` on the card itself: without this, an
    // unbreakable JWT token inside the note could push the card wider
    // than its grid column. The grid columns use minmax(0, …) but if any
    // ancestor flex/grid item lacks min-width:0, child content can still
    // force the layout wide. Belt-and-suspenders.
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-border/70 bg-card p-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-border/70 bg-muted/35 text-muted-foreground">
          <Bell className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          {/*
            `break-all` is the most aggressive wrap mode — it breaks at any
            character, even mid-word. We need this because reminder notes
            commonly contain pasted JWT URLs (400+ chars, no whitespace) and
            the gentler `break-words` only triggers as a last resort. The
            container also has `overflow-hidden` as a final safety net.
            `whitespace-pre-wrap` still preserves user-typed newlines.
          */}
          <p className="whitespace-pre-wrap break-all text-sm leading-6 text-foreground/85 [overflow-wrap:anywhere]">
            {reminder.note}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            {reminder.reminderAt ? formatDateTime(reminder.reminderAt) : "No notification time"}
            {reminder.reminderNotifiedAt ? " · sent" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Edit reminder"
            className="h-8 w-8 px-0"
            onClick={() => setEditing(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            aria-label="Delete reminder"
            className="h-8 w-8 px-0 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ConfirmActionDialog
        confirmLabel="Delete"
        description="Delete this reminder?"
        destructive
        onConfirm={dispatchDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Delete reminder?"
      />
    </div>
  );
}

function RemindersSection({
  applicationId,
  reminders,
}: {
  applicationId: string;
  reminders: TimelineEvent[];
}) {
  const [adding, setAdding] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [timeDraft, setTimeDraft] = useState("");
  const [state, formAction] = useActionState(addTimelineEvent, INITIAL_ACTION_STATE);
  const browserTimeZone = useBrowserTimeZone();
  useActionNotifications(state);
  const sortedReminders = [...reminders].sort(compareReminderEvents);

  return (
    // `min-w-0 overflow-hidden` on the outer Reminders section so a single
    // reminder with an ultra-long pasted URL cannot stretch the whole
    // section beyond its grid column.
    <section className="surface-panel min-w-0 overflow-hidden p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className={WORKSPACE_FIELD_TITLE_CLASS}>Reminders</h3>
        {!adding ? (
          <Button
            className="h-8 px-3 text-xs"
            onClick={() => setAdding(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Add reminder
          </Button>
        ) : null}
      </div>

      {adding ? (
        <form
          action={async (formData) => {
            await formAction(formData);
            setAdding(false);
            setNoteDraft("");
            setTimeDraft("");
          }}
          className="mt-3 grid gap-2 rounded-[14px] border border-border/70 bg-card p-3"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <input name="type" type="hidden" value="REMINDER" />
          <input name="timeZone" type="hidden" value={browserTimeZone} />
          <Textarea
            className="min-h-[82px] resize-y text-sm"
            name="note"
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder="Reminder"
            required
            rows={3}
            value={noteDraft}
          />
          <label className="grid gap-1.5 text-xs text-muted-foreground sm:max-w-72">
            <span className="font-medium uppercase tracking-[0.12em]">Notify at</span>
            <Input
              className="h-9 text-sm"
              name="reminderAt"
              onChange={(event) => setTimeDraft(event.target.value)}
              type="datetime-local"
              value={timeDraft}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <SubmitBtn label="Save reminder" saving="Saving..." />
            <Button
              className="h-8 px-3 text-xs"
              onClick={() => {
                setAdding(false);
                setNoteDraft("");
                setTimeDraft("");
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <div className="mt-3 grid gap-2">
        {sortedReminders.length === 0 ? (
          <p className="rounded-[14px] border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">
            No reminders yet.
          </p>
        ) : (
          sortedReminders.map((reminder) => (
            <ReminderRow
              applicationId={applicationId}
              key={reminder.id}
              reminder={reminder}
            />
          ))
        )}
      </div>
    </section>
  );
}

function EventRow({ applicationId, event }: { applicationId: string; event: TimelineEvent }) {
  const [state, formAction] = useActionState(deleteTimelineEvent, INITIAL_ACTION_STATE);
  const [open, setOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useActionNotifications(state);
  const note = isGeneratedStatusNote(event) ? null : event.note;
  const isReminder = event.type === "REMINDER";
  const typeLabel = isCreationEvent(event)
    ? "Created"
    : event.type.charAt(0) + event.type.slice(1).toLowerCase();
  const headlineTimestamp = isReminder && event.reminderAt ? event.reminderAt : event.timestamp;
  const summaryText = !isReminder ? note?.trim() || "No additional note." : null;

  function dispatchDelete() {
    const payload = new FormData();
    payload.set("applicationId", applicationId);
    payload.set("eventId", event.id);
    setDeleteOpen(false);
    startTransition(() => formAction(payload));
  }

  return (
    <div className="rounded-[14px] border border-border/70 bg-card">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium ${timelineEventBadgeClass(event.type)}`}
            >
              {typeLabel}
            </span>
            <span className="text-xs text-muted-foreground">{formatDateTime(headlineTimestamp)}</span>
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
          {summaryText ? <p className="mt-2 truncate pr-3 text-sm text-foreground/85">{summaryText}</p> : null}
        </button>

        <Button
          className="h-8 px-3 text-xs"
          onClick={() => setDeleteOpen(true)}
          size="sm"
          type="button"
          variant="destructive"
        >
          Delete
        </Button>
      </div>

      {open ? (
        <div className="border-t border-border/60 px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="grid gap-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Type
                </p>
                <p className="mt-1 text-sm text-foreground/85">{typeLabel}</p>
              </div>

              {isReminder && event.reminderAt ? (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Detail
                  </p>
                  <p className="mt-1 text-sm font-medium text-violet-700 dark:text-violet-300">
                    Reminder set for {formatDateTime(event.reminderAt)}
                  </p>
                </div>
              ) : null}

              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {isReminder && event.reminderAt ? "Created at" : "Logged at"}
                </p>
                <p className="mt-1 text-sm text-foreground/85">{formatDateTime(event.timestamp)}</p>
              </div>

              {note ? (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {isReminder ? "Reminder note" : "Note"}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-all text-sm text-foreground/85 [overflow-wrap:anywhere]">{note}</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmActionDialog
        confirmLabel="Delete"
        description={`Delete this ${typeLabel.toLowerCase()} event from the timeline?`}
        destructive
        onConfirm={dispatchDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={`Delete ${typeLabel.toLowerCase()}?`}
      />
    </div>
  );
}

function TailoredResumeSection({
  applicationId,
  initialResume,
}: {
  applicationId: string;
  initialResume: {
    fileName: string;
    mimeType: string;
    downloadHref: string;
  } | null;
}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [generatedResume, setGeneratedResume] = useState<{
    fileName: string;
    mimeType: string;
    pdfBase64?: string;
    downloadHref?: string;
  } | null>(initialResume);

  function handleDownload() {
    if (!generatedResume) {
      return;
    }

    if (generatedResume.downloadHref && !generatedResume.pdfBase64) {
      window.location.href = generatedResume.downloadHref;
      return;
    }

    if (!generatedResume.pdfBase64) {
      return;
    }

    const binary = atob(generatedResume.pdfBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: generatedResume.mimeType,
    });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = generatedResume.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setProfileNotice(null);

    try {
      const response = await fetch(`/api/applications/${applicationId}/tailored-resume`, {
        method: "POST",
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "Generation failed." }));
        setError(body.error ?? "Generation failed.");
        setGenerating(false);
        return;
      }

      const json = await response.json();
      setProfileNotice(
        typeof json.profileNotice === "string" && json.profileNotice.trim()
          ? json.profileNotice.trim()
          : null
      );
      setGeneratedResume({
        fileName: String(json.fileName ?? "tailored-resume.pdf"),
        mimeType: String(json.mimeType ?? "application/pdf"),
        pdfBase64: String(json.pdfBase64 ?? ""),
        downloadHref:
          typeof json.documentId === "string" && json.documentId
            ? `/api/profile/documents/${json.documentId}/download`
            : undefined,
      });
    } catch {
      setError("Network error. Try again.");
    }

    setGenerating(false);
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Button disabled={generating} onClick={handleGenerate} size="sm" type="button" variant="outline">
          {generating ? (
            <>
              <LoadingSpinner className="mr-1.5 h-3.5 w-3.5" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {generatedResume ? "Regenerate tailored resume" : "Generate tailored resume"}
            </>
          )}
        </Button>
        {generatedResume ? (
          <Button className="h-8 px-3 text-xs" onClick={handleDownload} size="sm" type="button" variant="secondary">
            Download tailored resume
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {profileNotice ? (
        <p className="mt-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs leading-relaxed text-blue-700 dark:text-blue-200">
          {profileNotice}
        </p>
      ) : null}
      {generatedResume ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Tailored resume ready. Download the generated PDF file.
        </p>
      ) : null}
    </div>
  );
}

function WorkspaceAISection({
  applicationId,
  attachedResumeId,
  fitAnalysisText,
  aiConfigured,
  company,
  roleTitle,
  userDocuments,
  generatedDocuments,
}: {
  applicationId: string;
  attachedResumeId: string | null;
  fitAnalysisText: string | null;
  aiConfigured: boolean;
  company: string;
  roleTitle: string;
  userDocuments: UserDocument[];
  generatedDocuments: GeneratedApplicationDocument[];
}) {
  const [hasFitAnalysis, setHasFitAnalysis] = useState(Boolean(fitAnalysisText));
  const initialStructuredFit = parseStoredFitAnalysis(fitAnalysisText);
  const canAnalyze = true;
  const latestGeneratedCoverLetter =
    generatedDocuments.find((document) => document.type === "COVER_LETTER") ?? null;
  const latestGeneratedResume =
    generatedDocuments.find((document) => document.type === "RESUME") ?? null;
  const initialCoverLetterText = latestGeneratedCoverLetter?.extractedText?.trim() ?? "";
  const initialCoverLetter =
    latestGeneratedCoverLetter
      ? {
          text: initialCoverLetterText,
          wordCount: initialCoverLetterText.split(/\s+/).filter(Boolean).length,
          documentId: latestGeneratedCoverLetter.id,
          title: latestGeneratedCoverLetter.title,
          downloadHref: `/api/profile/documents/${latestGeneratedCoverLetter.id}/download`,
          downloadLabel: null,
        }
      : null;

  return (
    <div className="grid gap-3">
      {aiConfigured ? (
        <AIWorkspace
          company={company}
          fitAnalysisEndpoint={`/api/applications/${applicationId}/ai/analyze`}
          initialFitAnalysisText={
            initialStructuredFit || fitAnalysisText ? fitAnalysisText : null
          }
          canAnalyzeFit={canAnalyze}
          fitUnavailableMessage="Fit analysis is unavailable for this application."
          fixedResumeId={attachedResumeId}
          jobTitle={roleTitle}
          onFitAnalysisGenerated={() => {
            setHasFitAnalysis(true);
          }}
          coverLetterEndpoint={`/api/applications/${applicationId}/ai/cover-letter`}
          initialCoverLetter={initialCoverLetter}
          showResumeSelector={false}
          showCoverLetter
          sectionTitleClassName={`flex items-center gap-2 ${WORKSPACE_FIELD_TITLE_CLASS}`}
          userResumes={userDocuments
            .filter((document) => document.type === "RESUME")
            .map((document) => ({
              id: document.id,
              title: document.title,
              isPrimary: document.isPrimary,
            }))}
        />
      ) : (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-4">
          <p className={WORKSPACE_FIELD_TITLE_CLASS}>Fit analysis</p>
          <p className="mt-2 text-sm text-muted-foreground">AI features are not configured.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">OPENAI_API_KEY</code> to{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code> to unlock fit analysis and cover letter generation.
          </p>
        </div>
      )}
      <div className="rounded-[16px] border border-border/60 bg-card">
        <div className="flex w-full items-center justify-between px-3 py-2.5 text-left">
          <span className={`flex items-center gap-2 ${WORKSPACE_FIELD_TITLE_CLASS}`}>
            <span className="shrink-0 text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            Tailored resume
          </span>
        </div>
        <div className="border-t border-border/60 p-3">
          <TailoredResumeSection
            applicationId={applicationId}
            initialResume={
              latestGeneratedResume
                ? {
                    fileName:
                      latestGeneratedResume.originalFileName ||
                      latestGeneratedResume.filename ||
                      "tailored-resume.pdf",
                    mimeType: latestGeneratedResume.mimeType,
                    downloadHref: `/api/profile/documents/${latestGeneratedResume.id}/download`,
                  }
                : null
            }
          />
          {!hasFitAnalysis ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Uses your primary template, profile, and the job description to create a PDF.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ApplicationWorkspaceClient({
  aiConfigured,
  application,
  generatedDocuments,
  initialHeaderEditing = false,
  userDocuments,
  userTags,
}: WorkspaceClientProps) {
  const tags = application.tags.map(({ tag }) => tag);
  const resumeLink = application.documentLinks.find(
    (link) => link.slot === "SENT_RESUME" && link.document.type === "RESUME"
  );
  const coverLetterLink = application.documentLinks.find(
    (link) => link.slot === "SENT_COVER_LETTER" && link.document.type === "COVER_LETTER"
  );
  const [headerEditing, setHeaderEditing] = useState(initialHeaderEditing);
  const reminders = application.events.filter((event) => event.type === "REMINDER");
  const timelineEvents = application.events.filter((event) => event.type !== "REMINDER");

  return (
    <div className="grid gap-4 sm:gap-5">
      <section className="surface-panel p-3.5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <ApplicationHeaderEditor
              application={{
                id: application.id,
                company: application.company,
                roleTitle: application.roleTitle,
                roleUrl: application.roleUrl,
              }}
              editing={headerEditing}
              onClose={() => setHeaderEditing(false)}
            />

            <p className="text-ellipsis-1 text-sm text-muted-foreground">
              {formatDate(application.deadline)} · Updated {formatDateTime(application.updatedAt)}
            </p>

            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <TagChip applicationId={application.id} key={tag.id} tag={tag} />
                ))}
              </div>
            ) : null}

            <div className="grid min-w-0 gap-2 pt-1 sm:flex sm:flex-wrap sm:items-center">
              <AttachDocumentControl
                applicationId={application.id}
                currentLink={resumeLink}
                documents={userDocuments}
                label="Attach resume"
                slot="SENT_RESUME"
              />
              <AttachDocumentControl
                applicationId={application.id}
                currentLink={coverLetterLink}
                documents={userDocuments}
                label="Attach cover letter"
                slot="SENT_COVER_LETTER"
              />
            </div>
          </div>

          <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:w-auto sm:items-end">
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
              <StatusSelector applicationId={application.id} currentStatus={application.status} />
              {!headerEditing ? (
                <WorkspaceActionsMenu
                  applicationId={application.id}
                  existingTags={tags}
                  onEdit={() => setHeaderEditing(true)}
                  userTags={userTags}
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="grid min-w-0 items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        {/* Main column — flat sections, ordered: job description → AI
            workspace (Fit analysis + Resume tailoring) → small Notes. The
            previous Documents section is gone; attach dropdowns live in the
            title-box footer above. */}
        <div className="grid min-w-0 content-start gap-4 self-start sm:gap-5">
          <JobDescriptionField
            applicationId={application.id}
            hasRoleUrl={Boolean(application.roleUrl)}
            value={application.jobDescription ?? ""}
          />

          <WorkspaceAISection
            applicationId={application.id}
            attachedResumeId={resumeLink?.document.id ?? null}
            aiConfigured={aiConfigured}
            company={application.company}
            generatedDocuments={generatedDocuments}
            fitAnalysisText={application.fitAnalysis}
            roleTitle={application.roleTitle}
            userDocuments={userDocuments}
          />

          <RemindersSection applicationId={application.id} reminders={reminders} />
        </div>

        <div className="grid min-w-0 content-start gap-4 self-start sm:gap-5">
          <JobAssistant
            aiConfigured={aiConfigured}
            applicationId={application.id}
            company={application.company}
            hasCoverLetter={Boolean(coverLetterLink)}
            hasFitAnalysis={Boolean(application.fitAnalysis)}
            hasJobDescription={Boolean(application.jobDescription)}
            hasNotes={reminders.length > 0}
            hasResume={Boolean(resumeLink)}
            roleTitle={application.roleTitle}
          />

          <section className="surface-panel p-3.5 sm:p-6">
            <h2 className="text-base font-semibold text-foreground">Timeline</h2>

            <div className="mt-3 grid gap-3">
              {timelineEvents.length === 0 ? (
                <p className="py-4 text-center text-sm italic text-muted-foreground">
                  No events recorded yet.
                </p>
              ) : (
                <div className="grid gap-1">
                  {timelineEvents.map((event) => (
                    <EventRow applicationId={application.id} event={event} key={event.id} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
