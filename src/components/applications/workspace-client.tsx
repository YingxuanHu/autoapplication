"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  addTag,
  addTimelineEvent,
  deleteTimelineEvent,
  importJobDescription,
  linkDocument,
  removeTag,
  unlinkDocument,
  updateApplicationField,
  updateApplicationStatus,
  uploadWorkspaceDocument,
} from "@/app/applications/[id]/actions";
import { importDocumentToProfile } from "@/app/profile/actions";
import { AIWorkspace } from "@/components/jobs/ai-workspace";
import { DeleteApplicationButton } from "@/components/applications/delete-application-button";
import { JobAssistant } from "@/components/applications/job-assistant";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNotifications } from "@/components/ui/notification-provider";
import type { DocumentType, TrackedApplicationEventType, TrackedApplicationStatus } from "@/generated/prisma/client";
import { parseStoredFitAnalysis } from "@/lib/ai/fit-analysis-format";
import { getJobDescriptionSummaryBlocks } from "@/lib/job-description-format";
import { TRACKED_STATUS_LABEL } from "@/lib/tracker-ui";

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
  analysis: { documentId: string } | null;
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
  userDocuments: UserDocument[];
  userTags: Tag[];
};

const statusOptions = [
  { value: "WISHLIST", label: "Wishlist" },
  { value: "PREPARING", label: "Preparing" },
  { value: "APPLIED", label: "Applied" },
  { value: "SCREEN", label: "Screen" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" },
] as const satisfies ReadonlyArray<{
  value: TrackedApplicationStatus;
  label: string;
}>;

const eventTypeOptions = [
  { value: "NOTE", label: "Note" },
  { value: "REMINDER", label: "Reminder" },
  { value: "APPLIED", label: "Applied" },
  { value: "SCREEN", label: "Screen" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
] as const satisfies ReadonlyArray<{
  value: TrackedApplicationEventType;
  label: string;
}>;

const statusBadgeClass: Record<string, string> = {
  WISHLIST: "border-border/70 bg-background text-muted-foreground",
  PREPARING: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  APPLIED: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  SCREEN: "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  INTERVIEW: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  OFFER: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  REJECTED: "border-destructive/20 bg-destructive/10 text-destructive",
  WITHDRAWN: "border-border/70 bg-muted text-muted-foreground",
  REMINDER: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  NOTE: "border-border/70 bg-background text-muted-foreground",
};

const ACCEPT_RESUME = ".pdf,.doc,.docx,.txt,.rtf,.png,.jpg,.jpeg,.webp";
const ACCEPT_COVER_LETTER = ".pdf,.doc,.docx,.txt,.rtf";
const WORKSPACE_FIELD_TITLE_CLASS = "text-[0.95rem] font-semibold tracking-tight text-foreground";
const DEFAULT_REMINDER_TIME = "09:00";
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
    return event.note === `Status updated to ${TRACKED_STATUS_LABEL.PREPARING}.`;
  }

  if (!["APPLIED", "SCREEN", "INTERVIEW", "OFFER", "REJECTED"].includes(event.type)) {
    return false;
  }

  const eventStatus = event.type as Extract<
    TrackedApplicationEventType,
    "APPLIED" | "SCREEN" | "INTERVIEW" | "OFFER" | "REJECTED"
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

function SubmitBtn({ label, saving }: { label: string; saving: string }) {
  const { pending } = useFormStatus();

  return (
    <Button className="h-8 px-3 text-xs" disabled={pending} size="sm" type="submit">
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

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

function EditableField({
  applicationId,
  field,
  label,
  value,
  placeholder,
}: {
  applicationId: string;
  field: "notes";
  label: string;
  value: string;
  placeholder: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [state, formAction] = useActionState(updateApplicationField, INITIAL_ACTION_STATE);
  useActionNotifications(state);

  function handleCancel() {
    setDraft(value);
    setEditing(false);
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className={WORKSPACE_FIELD_TITLE_CLASS}>{label}</h3>
        {!editing ? (
          <button
            className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
            onClick={() => setEditing(true)}
            type="button"
          >
            Edit
          </button>
        ) : null}
      </div>

      {editing ? (
        <form
          action={async (formData) => {
            await formAction(formData);
            setEditing(false);
          }}
          className="mt-3 grid gap-2"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <input name="field" type="hidden" value={field} />
          <Textarea
            className="min-h-[80px] resize-y text-sm"
            name="value"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
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
      ) : (
        <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/80">
          {value || <span className="italic text-muted-foreground">{placeholder}</span>}
        </p>
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
        className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-xs font-medium text-foreground transition hover:bg-muted/70"
        title={`Remove "${tag.name}"`}
        type="submit"
      >
        {tag.name}
        <span aria-hidden className="opacity-60">
          ×
        </span>
      </button>
    </form>
  );
}

function TagsSection({
  applicationId,
  children,
  tags,
  userTags,
}: {
  applicationId: string;
  children?: React.ReactNode;
  tags: Tag[];
  userTags: Tag[];
}) {
  const [inputValue, setInputValue] = useState("");
  const [state, formAction] = useActionState(addTag, INITIAL_ACTION_STATE);
  useActionNotifications(state);

  const suggestableTags = userTags.filter((tag) => !tags.some((existingTag) => existingTag.id === tag.id));

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {tags.map((tag) => (
        <TagChip applicationId={applicationId} key={tag.id} tag={tag} />
      ))}
      <form
        action={async (formData) => {
          await formAction(formData);
          setInputValue("");
        }}
        className="flex items-center gap-1"
      >
        <input name="applicationId" type="hidden" value={applicationId} />
        {suggestableTags.length > 0 ? (
          <datalist id="tag-suggestions">
            {suggestableTags.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
        ) : null}
        <Input
          className="h-7 w-28 px-2 text-xs"
          list="tag-suggestions"
          name="name"
          onChange={(event) => setInputValue(event.target.value)}
          placeholder="Add tag..."
          value={inputValue}
        />
        <SubmitBtn label="+" saving="..." />
      </form>
      {children}
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
    <form action={formAction} className="flex items-center gap-2">
      <input name="applicationId" type="hidden" value={applicationId} />
      <select
        className="h-9 min-w-[140px] rounded-lg border border-border/70 bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
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
    </form>
  );
}

function DocumentSlot({
  applicationId,
  slot,
  label,
  currentLink,
  documents,
}: {
  applicationId: string;
  slot: "SENT_RESUME" | "SENT_COVER_LETTER";
  label: string;
  currentLink: DocumentLink | undefined;
  documents: UserDocument[];
}) {
  const [showUpload, setShowUpload] = useState(false);

  const [linkState, linkAction] = useActionState(linkDocument, INITIAL_ACTION_STATE);
  const [unlinkState, unlinkAction] = useActionState(unlinkDocument, INITIAL_ACTION_STATE);
  const [uploadState, uploadAction] = useActionState(uploadWorkspaceDocument, INITIAL_ACTION_STATE);
  const [importState, importAction] = useActionState(importDocumentToProfile, INITIAL_ACTION_STATE);

  useActionNotifications(linkState);
  useActionNotifications(unlinkState);
  useActionNotifications(uploadState);
  useActionNotifications(importState);

  const documentType = slot === "SENT_RESUME" ? "RESUME" : "COVER_LETTER";
  const accept = slot === "SENT_RESUME" ? ACCEPT_RESUME : ACCEPT_COVER_LETTER;
  const available = documents.filter((document) => document.type === documentType);

  return (
    <div className="rounded-xl border border-border/70 bg-background/50 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className={WORKSPACE_FIELD_TITLE_CLASS}>{label}</h4>
        {!showUpload ? (
          <button
            className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
            onClick={() => setShowUpload(true)}
            type="button"
          >
            Upload new
          </button>
        ) : null}
      </div>

      {showUpload ? (
        <form
          action={async (formData) => {
            await uploadAction(formData);
            setShowUpload(false);
          }}
          className="mt-3 grid gap-2"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <input name="slot" type="hidden" value={slot} />
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground" htmlFor={`upload-title-${slot}`}>
              Title (optional)
            </label>
            <Input
              id={`upload-title-${slot}`}
              name="title"
              placeholder={`e.g. ${documentType === "RESUME" ? "Resume v2" : "Cover letter – Google"}`}
              type="text"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground" htmlFor={`upload-file-${slot}`}>
              File <span className="text-muted-foreground">({accept})</span>
            </label>
            <FileInput
              accept={accept}
              className="hover:border-border"
              id={`upload-file-${slot}`}
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
              onClick={() => {
                setShowUpload(false);
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : currentLink ? (
        <div className="mt-2 grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-foreground/80">{currentLink.document.title}</p>
            <div className="flex items-center gap-1">
              <Button
                className="h-8 px-3 text-xs"
                render={<Link href={`/api/profile/documents/${currentLink.document.id}/download`} />}
                size="sm"
                variant="secondary"
              >
                Download
              </Button>
              <form action={unlinkAction}>
                <input name="applicationId" type="hidden" value={applicationId} />
                <input name="slot" type="hidden" value={slot} />
                <SubmitBtn label="Remove" saving="..." />
              </form>
            </div>
          </div>
          {slot === "SENT_RESUME" ? (
            <form action={importAction}>
              <input name="documentId" type="hidden" value={currentLink.document.id} />
              {currentLink.document.analysis ? (
                <Button
                  className="h-8 px-3 text-xs"
                  disabled
                  size="sm"
                  title="Already imported to profile"
                  type="button"
                  variant="secondary"
                >
                  Imported to profile
                </Button>
              ) : (
                <SubmitBtn label="Import to profile" saving="Importing..." />
              )}
            </form>
          ) : null}
        </div>
      ) : available.length > 0 ? (
        <form action={linkAction} className="mt-2 flex items-center gap-2">
          <input name="applicationId" type="hidden" value={applicationId} />
          <input name="slot" type="hidden" value={slot} />
          <select
            className="h-9 flex-1 rounded-lg border border-border/70 bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            name="documentId"
          >
            <option value="">Select existing...</option>
            {available.map((document) => (
              <option key={document.id} value={document.id}>
                {document.title}
              </option>
            ))}
          </select>
          <SubmitBtn label="Attach" saving="..." />
        </form>
      ) : (
        <p className="mt-2 text-sm italic text-muted-foreground">
          No {documentType === "RESUME" ? "resumes" : "cover letters"} yet. Click &quot;Upload new&quot; to add one.
        </p>
      )}
    </div>
  );
}

function AddEventDropdown({ applicationId }: { applicationId: string }) {
  const [state, formAction] = useActionState(addTimelineEvent, INITIAL_ACTION_STATE);
  const [selectedType, setSelectedType] = useState<TrackedApplicationEventType>("NOTE");
  const [open, setOpen] = useState(false);
  const [reminderDate, setReminderDate] = useState("");
  const [reminderTime, setReminderTime] = useState(DEFAULT_REMINDER_TIME);
  const [reminderValue, setReminderValue] = useState("");
  const [reminderError, setReminderError] = useState<string | null>(null);
  useActionNotifications(state);

  function resetReminderDraft() {
    setReminderDate("");
    setReminderTime(DEFAULT_REMINDER_TIME);
    setReminderValue("");
    setReminderError(null);
  }

  function handleEventTypeChange(value: TrackedApplicationEventType) {
    setSelectedType(value);
    if (value !== "REMINDER") {
      resetReminderDraft();
    }
  }

  function handleSetReminder() {
    if (!reminderDate || !reminderTime) {
      setReminderError("Choose both a date and time first.");
      return;
    }

    setReminderValue(`${reminderDate}T${reminderTime}`);
    setReminderError(null);
  }

  return (
    <div className="relative">
      <Button
        className="h-8 px-3 text-xs"
        onClick={() => setOpen((current) => !current)}
        size="sm"
        type="button"
      >
        Add event
      </Button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+0.5rem)] z-20 w-[min(21rem,calc(100vw-3rem))] rounded-xl border border-border/70 bg-background/98 p-3 shadow-[0_20px_45px_rgba(15,23,42,0.14)] backdrop-blur">
          <form
            action={async (formData) => {
              await formAction(formData);
              setOpen(false);
              setSelectedType("NOTE");
              resetReminderDraft();
            }}
            className="grid gap-3"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-foreground">Add event</h3>
              <button
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
                onClick={() => setOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="space-y-1">
              <FieldLabel htmlFor="event-type">Type</FieldLabel>
              <select
                className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                defaultValue="NOTE"
                id="event-type"
                name="type"
                onChange={(event) => handleEventTypeChange(event.target.value as TrackedApplicationEventType)}
              >
                {eventTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {selectedType === "REMINDER" ? (
              <div className="space-y-2">
                <FieldLabel>Remind me at</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-[minmax(11rem,1.2fr)_minmax(8rem,0.8fr)]">
                  <Input
                    className="text-sm"
                    id="event-reminder-date"
                    onChange={(event) => {
                      setReminderDate(event.target.value);
                      setReminderValue("");
                      setReminderError(null);
                    }}
                    type="date"
                    value={reminderDate}
                  />
                  <Input
                    className="text-sm"
                    id="event-reminder-time"
                    onChange={(event) => {
                      setReminderTime(event.target.value);
                      setReminderValue("");
                      setReminderError(null);
                    }}
                    type="time"
                    value={reminderTime}
                  />
                </div>
                <div className="flex justify-start">
                  <Button
                    className="h-9 px-3 text-xs"
                    onClick={handleSetReminder}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Set reminder
                  </Button>
                </div>
                <input name="reminderAt" type="hidden" value={reminderValue} />
                {reminderValue ? (
                  <p className="text-xs text-muted-foreground">
                    Reminder set for {formatDateTime(new Date(reminderValue))}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Pick a date and time, then click <span className="font-medium text-foreground">Set reminder</span>.
                  </p>
                )}
                {reminderError ? (
                  <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {reminderError}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-1">
              <FieldLabel htmlFor="event-note">
                {selectedType === "REMINDER" ? "What to remind about" : "Note"}
              </FieldLabel>
              <Textarea
                className="min-h-[84px] resize-y text-sm"
                id="event-note"
                name="note"
                placeholder={selectedType === "REMINDER" ? "What should this reminder cover?" : "Add a quick note..."}
                rows={3}
              />
            </div>

            <input name="applicationId" type="hidden" value={applicationId} />
            <div className="flex justify-end">
              <SubmitBtn label="Add event" saving="Adding..." />
            </div>
          </form>
        </div>
      ) : null}
    </div>
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
    <div className="rounded-xl border border-border/70 bg-background/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className={WORKSPACE_FIELD_TITLE_CLASS}>Job description</h3>
        <div className="flex items-center gap-1">
          {!editing && !showPaste && hasRoleUrl ? (
            <button
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
              onClick={handleImportFromLink}
              type="button"
            >
              {value ? "Re-import from link" : "Import from link"}
            </button>
          ) : null}
          {!editing && !showPaste ? (
            <button
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
              onClick={handlePasteClick}
              type="button"
            >
              Paste posting
            </button>
          ) : null}
          {!editing && !showPaste ? (
            <button
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
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
      ) : (
        <div className="mt-3">
          {value ? (
            renderDescriptionSummary(value)
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No job description yet. Import it from the posting link, paste the posting text, or edit it manually.
            </p>
          )}
        </div>
      )}
    </div>
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
    <div className="rounded-xl border border-border/70 bg-background">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass[event.type] ?? statusBadgeClass.NOTE}`}
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
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">{note}</p>
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

function TailoredResumeSection({ applicationId }: { applicationId: string }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedResume, setGeneratedResume] = useState<{
    fileName: string;
    mimeType: string;
    pdfBase64: string;
  } | null>(null);

  function handleDownload() {
    if (!generatedResume) {
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
      setGeneratedResume({
        fileName: String(json.fileName ?? "tailored-resume.pdf"),
        mimeType: String(json.mimeType ?? "application/pdf"),
        pdfBase64: String(json.pdfBase64 ?? ""),
      });
    } catch {
      setError("Network error. Try again.");
    }

    setGenerating(false);
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Button className="h-8 px-3 text-xs" disabled={generating} onClick={handleGenerate} size="sm" type="button">
          {generating ? (
            <>
              <LoadingSpinner className="h-3 w-3" />
              Generating...
            </>
          ) : (
            generatedResume ? "Regenerate" : "Generate tailored resume"
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
  canonicalJobId,
  fitAnalysisText,
  hasJobDescription,
  aiConfigured,
  company,
  roleTitle,
}: {
  applicationId: string;
  canonicalJobId: string | null;
  fitAnalysisText: string | null;
  hasJobDescription: boolean;
  aiConfigured: boolean;
  company: string;
  roleTitle: string;
}) {
  const [hasFitAnalysis, setHasFitAnalysis] = useState(Boolean(fitAnalysisText));
  const initialStructuredFit = parseStoredFitAnalysis(fitAnalysisText);
  const canAnalyze = Boolean(canonicalJobId) || hasJobDescription;

  return (
    <div className="grid gap-3">
      {aiConfigured ? (
        <AIWorkspace
          company={company}
          coverLetterEndpoint={`/api/applications/${applicationId}/ai/cover-letter`}
          fitAnalysisEndpoint={`/api/applications/${applicationId}/ai/analyze`}
          initialFitAnalysisText={
            initialStructuredFit || fitAnalysisText ? fitAnalysisText : null
          }
          canAnalyzeFit={canAnalyze}
          fitUnavailableMessage="Add a job description first, or link this application to a pool job."
          jobTitle={roleTitle}
          onFitAnalysisGenerated={() => {
            setHasFitAnalysis(true);
          }}
          sectionTitleClassName={`flex items-center gap-2 ${WORKSPACE_FIELD_TITLE_CLASS}`}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-background/50 p-4">
          <p className={WORKSPACE_FIELD_TITLE_CLASS}>Fit analysis</p>
          <p className="mt-2 text-sm text-muted-foreground">AI features are not configured.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">OPENAI_API_KEY</code> to{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code> to unlock fit analysis and cover letter generation.
          </p>
        </div>
      )}
      {hasFitAnalysis ? (
        <div className="rounded-xl border border-border/70 bg-background/50 p-4">
          <h4 className={WORKSPACE_FIELD_TITLE_CLASS}>Tailored resume</h4>
          <div className="mt-3">
            <TailoredResumeSection applicationId={applicationId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ApplicationWorkspaceClient({
  aiConfigured,
  application,
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

  return (
    <div className="grid gap-6">
      <section className="surface-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold text-foreground">{application.company}</h2>
            <p className="mt-1 text-base text-foreground/80">{application.roleTitle}</p>

            <p className="mt-2 text-sm text-muted-foreground">
              {formatDate(application.deadline)} · Updated {formatDateTime(application.updatedAt)}
            </p>

            {application.roleUrl ? (
              <a
                className="mt-2 inline-block text-sm font-medium text-foreground/80 underline underline-offset-2 hover:text-foreground"
                href={application.roleUrl}
                rel="noreferrer"
                target="_blank"
              >
                View job posting
              </a>
            ) : null}

            <TagsSection applicationId={application.id} tags={tags} userTags={userTags}>
              <AddEventDropdown applicationId={application.id} />
            </TagsSection>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <StatusSelector applicationId={application.id} currentStatus={application.status} />
            <DeleteApplicationButton
              applicationId={application.id}
              redirectToList
              size="sm"
              variant="ghost"
            />
          </div>
        </div>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="grid content-start gap-6 self-start">
          <section className="surface-panel p-5">
            <h2 className="text-base font-semibold text-foreground">Details</h2>

            <div className="mt-3 grid gap-3">
              <EditableField
                applicationId={application.id}
                field="notes"
                label="Notes"
                placeholder="Add notes about this application..."
                value={application.notes ?? ""}
              />
              <JobDescriptionField
                applicationId={application.id}
                hasRoleUrl={Boolean(application.roleUrl)}
                value={application.jobDescription ?? ""}
              />
              <WorkspaceAISection
                applicationId={application.id}
                aiConfigured={aiConfigured}
                canonicalJobId={application.canonicalJob?.id ?? null}
                company={application.company}
                fitAnalysisText={application.fitAnalysis}
                hasJobDescription={Boolean(application.jobDescription)}
                roleTitle={application.roleTitle}
              />
            </div>
          </section>

          <section className="surface-panel p-5">
            <h2 className="text-base font-semibold text-foreground">Documents</h2>

            <div className="mt-3 grid gap-3">
              <DocumentSlot
                applicationId={application.id}
                currentLink={resumeLink}
                documents={userDocuments}
                label="Resume"
                slot="SENT_RESUME"
              />
              <DocumentSlot
                applicationId={application.id}
                currentLink={coverLetterLink}
                documents={userDocuments}
                label="Cover letter"
                slot="SENT_COVER_LETTER"
              />
            </div>
          </section>
        </div>

        <div className="grid content-start gap-6 self-start">
          <section className="surface-panel p-0">
            <JobAssistant
              aiConfigured={aiConfigured}
              applicationId={application.id}
              company={application.company}
              hasCoverLetter={Boolean(coverLetterLink)}
              hasFitAnalysis={Boolean(application.fitAnalysis)}
              hasJobDescription={Boolean(application.jobDescription)}
              hasNotes={Boolean(application.notes)}
              hasResume={Boolean(resumeLink)}
              roleTitle={application.roleTitle}
            />
          </section>

          <section className="surface-panel p-5">
            <h2 className="text-base font-semibold text-foreground">Timeline</h2>

            <div className="mt-3 grid gap-3">
              {application.events.length === 0 ? (
                <p className="py-4 text-center text-sm italic text-muted-foreground">
                  No events recorded yet.
                </p>
              ) : (
                <div className="grid gap-1">
                  {application.events.map((event) => (
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
