"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  addTag,
  addTimelineEvent,
  analyzeResumeFit,
  deleteTimelineEvent,
  linkDocument,
  removeTag,
  summarizeJobDescription,
  unlinkDocument,
  updateApplicationField,
  updateApplicationStatus,
  uploadWorkspaceDocument,
} from "@/app/applications/[id]/actions";
import { importDocumentToProfile } from "@/app/profile/actions";
import { JobAssistant } from "@/components/applications/job-assistant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNotifications } from "@/components/ui/notification-provider";
import type { DocumentType, TrackedApplicationEventType, TrackedApplicationStatus } from "@/generated/prisma/client";
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

function renderFormattedText(text: string) {
  return text.split("\n").map((line, index) => {
    const boldMatch = line.match(/^\*\*(.+)\*\*$/);
    if (boldMatch) {
      return (
        <p className="mt-3 text-sm font-semibold text-foreground first:mt-0" key={index}>
          {boldMatch[1]}
        </p>
      );
    }

    if (line.startsWith("• ") || line.startsWith("- ") || line.startsWith("· ")) {
      return (
        <p className="ml-3 text-sm text-foreground/80" key={index}>
          · {renderInlineBold(line.slice(2))}
        </p>
      );
    }

    if (line.trim() === "") {
      return <div className="h-1" key={index} />;
    }

    return (
      <p className="text-sm text-foreground/80" key={index}>
        {renderInlineBold(line)}
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
  if (!["APPLIED", "SCREEN", "INTERVIEW", "OFFER", "REJECTED"].includes(event.type)) {
    return false;
  }

  const eventStatus = event.type as Extract<
    TrackedApplicationEventType,
    "APPLIED" | "SCREEN" | "INTERVIEW" | "OFFER" | "REJECTED"
  >;

  return event.note === `Status updated to ${TRACKED_STATUS_LABEL[eventStatus]}.`;
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
      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
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
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
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
  tags,
  userTags,
}: {
  applicationId: string;
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
  const [fileName, setFileName] = useState("");

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
        <h4 className="text-sm font-semibold text-foreground">{label}</h4>
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
            setFileName("");
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
            <input
              accept={accept}
              className="block w-full cursor-pointer rounded-lg border border-border/70 bg-background px-3 py-2 text-sm text-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium file:text-foreground hover:border-border"
              id={`upload-file-${slot}`}
              name="file"
              onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
              required
              type="file"
            />
            {fileName ? <p className="text-xs text-muted-foreground">Selected: {fileName}</p> : null}
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
                setFileName("");
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

function AddEventForm({ applicationId }: { applicationId: string }) {
  const [state, formAction] = useActionState(addTimelineEvent, INITIAL_ACTION_STATE);
  const [selectedType, setSelectedType] = useState<TrackedApplicationEventType>("NOTE");
  useActionNotifications(state);

  return (
    <form action={formAction} className="rounded-xl border border-border/70 bg-background/50 p-4">
      <h3 className="text-sm font-semibold text-foreground">Add event</h3>
      <div className="mt-3 grid gap-3">
        <div className="space-y-1">
          <FieldLabel htmlFor="event-type">Type</FieldLabel>
          <select
            className="h-9 rounded-lg border border-border/70 bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            defaultValue="NOTE"
            id="event-type"
            name="type"
            onChange={(event) => setSelectedType(event.target.value as TrackedApplicationEventType)}
          >
            {eventTypeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {selectedType === "REMINDER" ? (
          <div className="space-y-1">
            <FieldLabel htmlFor="event-reminder-at">Remind me at</FieldLabel>
            <Input className="text-sm" id="event-reminder-at" name="reminderAt" required type="datetime-local" />
          </div>
        ) : null}
        <div className="space-y-1">
          <FieldLabel htmlFor="event-note">
            {selectedType === "REMINDER" ? "What to remind about (optional)" : "Note (optional)"}
          </FieldLabel>
          <Textarea className="min-h-[60px] resize-y text-sm" id="event-note" name="note" rows={2} />
        </div>
        <input name="applicationId" type="hidden" value={applicationId} />
        <SubmitBtn label="Add event" saving="Adding..." />
      </div>
    </form>
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
  const [summarizing, setSummarizing] = useState(false);

  const [editState, editAction] = useActionState(updateApplicationField, INITIAL_ACTION_STATE);
  const [summarizeState, summarizeAction] = useActionState(summarizeJobDescription, INITIAL_ACTION_STATE);
  useActionNotifications(editState);
  useActionNotifications(summarizeState);

  const summarizeActionState = summarizeState as ActionState & { fetchFailed?: boolean };
  const needsPaste = showPaste || summarizeActionState.fetchFailed;

  function handleCancel() {
    setDraft(value);
    setEditing(false);
  }

  function handleSummarizeClick() {
    setShowPaste(true);
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Job description</h3>
        <div className="flex items-center gap-1">
          {!editing && !showPaste && !summarizeActionState.fetchFailed ? (
            <button
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
              onClick={handleSummarizeClick}
              type="button"
            >
              {value ? "Re-summarize" : "Summarize with AI"}
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

      {summarizeState.error ? (
        <p className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {summarizeState.error}
        </p>
      ) : null}

      {needsPaste && !editing ? (
        <form
          action={async (formData) => {
            setSummarizing(true);
            await summarizeAction(formData);
            setSummarizing(false);
            setShowPaste(false);
            setPasteContent("");
          }}
          className="mt-3 grid gap-2"
        >
          <input name="applicationId" type="hidden" value={applicationId} />
          <p className="text-xs text-muted-foreground">
            Paste the job posting content below for the best results. AI will extract and organize the key details.
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
            <SubmitBtn label="Summarize" saving="Summarizing..." />
            {hasRoleUrl && !pasteContent ? (
              <Button
                className="h-8 px-3 text-xs"
                onClick={() => {
                  setSummarizing(true);
                  const formData = new FormData();
                  formData.set("applicationId", applicationId);
                  formData.set("content", "");
                  startTransition(async () => {
                    await summarizeAction(formData);
                    setSummarizing(false);
                  });
                  setShowPaste(false);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                Auto-fetch from URL
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
      ) : summarizing ? (
        <div className="mt-4 flex items-center justify-center gap-2 py-4">
          <LoadingSpinner className="h-4 w-4" />
          <span className="text-sm text-muted-foreground">Summarizing with AI...</span>
        </div>
      ) : (
        <div className="mt-3">
          {value ? (
            renderFormattedText(value)
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No job description yet. Use &quot;Summarize with AI&quot; to paste and extract, or &quot;Edit&quot; to write manually.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ applicationId, event }: { applicationId: string; event: TimelineEvent }) {
  const [state, formAction] = useActionState(deleteTimelineEvent, INITIAL_ACTION_STATE);
  useActionNotifications(state);
  const note = isGeneratedStatusNote(event) ? null : event.note;
  const isReminder = event.type === "REMINDER";

  return (
    <div className="flex items-start justify-between gap-2 rounded-xl border border-border/70 bg-background px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass[event.type] ?? statusBadgeClass.NOTE}`}
          >
            {event.type.charAt(0) + event.type.slice(1).toLowerCase()}
          </span>
          <span className="text-xs text-muted-foreground">{formatDateTime(event.timestamp)}</span>
        </div>
        {isReminder && event.reminderAt ? (
          <p className="mt-1 text-xs font-medium text-violet-700 dark:text-violet-300">
            Fires at: {formatDateTime(event.reminderAt)}
          </p>
        ) : null}
        {note ? <p className="mt-1 text-sm text-foreground/80">{note}</p> : null}
      </div>
      <form action={formAction}>
        <input name="applicationId" type="hidden" value={applicationId} />
        <input name="eventId" type="hidden" value={event.id} />
        <SubmitBtn label="Delete" saving="..." />
      </form>
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

function FitAnalysisSection({
  applicationId,
  fitAnalysis,
  hasJobDescription,
  hasResume,
}: {
  applicationId: string;
  fitAnalysis: string | null;
  hasJobDescription: boolean;
  hasResume: boolean;
}) {
  const [state, formAction] = useActionState(analyzeResumeFit, INITIAL_ACTION_STATE);
  useActionNotifications(state);

  const canAnalyze = hasJobDescription && hasResume;

  return (
    <div className="rounded-xl border border-border/70 bg-background/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Fit analysis</h3>
        {canAnalyze ? (
          <form action={formAction}>
            <input name="applicationId" type="hidden" value={applicationId} />
            <SubmitBtn label={fitAnalysis ? "Re-analyze" : "Analyze fit"} saving="Analyzing..." />
          </form>
        ) : null}
      </div>

      {state.error ? (
        <p className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}

      {!canAnalyze && !fitAnalysis ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {!hasJobDescription && !hasResume
            ? "Add a job description and link a resume to analyze fit."
            : !hasJobDescription
              ? "Add a job description first."
              : "Link a resume or set a primary resume in your Profile."}
        </p>
      ) : fitAnalysis ? (
        <>
          <div className="mt-3">{renderFormattedText(fitAnalysis)}</div>
          <div className="mt-3 border-t border-border/70 pt-3">
            <TailoredResumeSection applicationId={applicationId} />
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Click &quot;Analyze fit&quot; to compare your resume against this job.
        </p>
      )}
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

            <TagsSection applicationId={application.id} tags={tags} userTags={userTags} />
          </div>

          <StatusSelector applicationId={application.id} currentStatus={application.status} />
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
              <FitAnalysisSection
                applicationId={application.id}
                fitAnalysis={application.fitAnalysis}
                hasJobDescription={Boolean(application.jobDescription)}
                hasResume={Boolean(resumeLink)}
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
              <AddEventForm applicationId={application.id} />

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
