import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  addTrackedEventAction,
  deleteTrackedApplicationAction,
  deleteTrackedEventAction,
  linkTrackedDocumentAction,
  saveTrackedApplicationAction,
  unlinkTrackedDocumentAction,
} from "@/app/dashboard/actions";
import { getOptionalSessionUser } from "@/lib/current-user";
import { getTrackedApplicationWorkspace } from "@/lib/queries/tracker";
import {
  formatTrackerDate,
  toDateInputValue,
  toDatetimeLocalValue,
  TRACKED_EVENT_LABEL,
  TRACKED_STATUS_LABEL,
  trackedStatusClass,
} from "@/lib/tracker-ui";

export default async function TrackedApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const sessionUser = await getOptionalSessionUser();
  if (!sessionUser) {
    redirect("/sign-in");
  }

  const { id } = await params;
  const workspace = await getTrackedApplicationWorkspace(id);
  if (!workspace.application) {
    notFound();
  }

  const application = workspace.application;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div>
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            Back to tracker
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {application.company} · {application.roleTitle}
            </h1>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${trackedStatusClass(application.status)}`}
            >
              {TRACKED_STATUS_LABEL[application.status]}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Deadline: {formatTrackerDate(application.deadline)}
            {application.canonicalJob ? ` · Feed-linked job` : ""}
          </p>
        </div>

        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link href="/notifications" className="hover:text-foreground">
            Notifications
            {workspace.unreadNotificationCount > 0
              ? ` (${workspace.unreadNotificationCount})`
              : ""}
          </Link>
          {application.canonicalJob ? (
            <Link href={`/jobs/${application.canonicalJob.id}`} className="hover:text-foreground">
              Open job
            </Link>
          ) : application.roleUrl ? (
            <a
              href={application.roleUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Open posting
            </a>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
        <div className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Overview</h2>
            <form action={saveTrackedApplicationAction} className="mt-4 grid gap-4">
              <input type="hidden" name="applicationId" value={application.id} />

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Company
                  </span>
                  <input
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    name="company"
                    defaultValue={application.company}
                    required
                  />
                </label>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Role
                  </span>
                  <input
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    name="roleTitle"
                    defaultValue={application.roleTitle}
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 sm:col-span-2 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Posting URL
                  </span>
                  <input
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    name="roleUrl"
                    type="url"
                    defaultValue={application.roleUrl ?? ""}
                    placeholder="https://..."
                  />
                </label>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </span>
                  <select
                    name="status"
                    defaultValue={application.status}
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <option value="WISHLIST">Wishlist</option>
                    <option value="APPLIED">Applied</option>
                    <option value="SCREEN">Screen</option>
                    <option value="INTERVIEW">Interview</option>
                    <option value="OFFER">Offer</option>
                    <option value="REJECTED">Rejected</option>
                    <option value="WITHDRAWN">Withdrawn</option>
                  </select>
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Deadline
                  </span>
                  <input
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    name="deadline"
                    type="date"
                    defaultValue={toDateInputValue(application.deadline)}
                  />
                </label>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Tags
                  </span>
                  <input
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    name="tags"
                    defaultValue={application.tags.map(({ tag }) => tag.name).join(", ")}
                    placeholder="frontend, finance, follow-up"
                  />
                </label>
              </div>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Notes
                </span>
                <textarea
                  className="min-h-28 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  name="notes"
                  defaultValue={application.notes ?? ""}
                />
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Job description
                </span>
                <textarea
                  className="min-h-40 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  name="jobDescription"
                  defaultValue={application.jobDescription ?? ""}
                />
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Fit analysis
                </span>
                <textarea
                  className="min-h-28 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  name="fitAnalysis"
                  defaultValue={application.fitAnalysis ?? ""}
                />
              </label>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="submit"
                  className="h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background"
                >
                  Save overview
                </button>
              </div>
            </form>
            <form action={deleteTrackedApplicationAction} className="mt-3">
              <input type="hidden" name="applicationId" value={application.id} />
              <button
                type="submit"
                className="h-9 rounded-lg bg-destructive/10 px-4 text-sm font-medium text-destructive"
              >
                Delete tracked application
              </button>
            </form>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Timeline</h2>
            <form action={addTrackedEventAction} className="mt-4 grid gap-4">
              <input type="hidden" name="applicationId" value={application.id} />
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Event type
                  </span>
                  <select
                    name="type"
                    defaultValue="NOTE"
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <option value="NOTE">Note</option>
                    <option value="REMINDER">Reminder</option>
                    <option value="APPLIED">Applied</option>
                    <option value="SCREEN">Screen</option>
                    <option value="INTERVIEW">Interview</option>
                    <option value="OFFER">Offer</option>
                    <option value="REJECTED">Rejected</option>
                  </select>
                </label>

                <label className="grid gap-1.5 text-sm sm:col-span-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Reminder time
                  </span>
                  <input
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    name="reminderAt"
                    type="datetime-local"
                  />
                </label>
              </div>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Note
                </span>
                <textarea
                  className="min-h-24 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  name="note"
                  placeholder="Interview feedback, recruiter follow-up, personal reminder..."
                />
              </label>

              <div>
                <button
                  type="submit"
                  className="h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background"
                >
                  Add event
                </button>
              </div>
            </form>

            <div className="mt-6 space-y-3">
              {application.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No timeline events yet.</p>
              ) : (
                application.events.map((event) => (
                  <article
                    key={event.id}
                    className="rounded-lg border border-border/70 bg-background p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {TRACKED_EVENT_LABEL[event.type]}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Intl.DateTimeFormat("en-CA", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(event.timestamp)}
                        </p>
                      </div>
                      <form action={deleteTrackedEventAction}>
                        <input type="hidden" name="applicationId" value={application.id} />
                        <input type="hidden" name="eventId" value={event.id} />
                        <button
                          type="submit"
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                    {event.note ? (
                      <p className="mt-2 text-sm text-foreground/80">{event.note}</p>
                    ) : null}
                    {event.reminderAt ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Reminder: {toDatetimeLocalValue(event.reminderAt).replace("T", " ")}
                        {event.reminderNotifiedAt ? " · sent" : ""}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Documents</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Link the exact resume or cover letter used for this application.
            </p>

            <div className="mt-4 space-y-4">
              {(["SENT_RESUME", "SENT_COVER_LETTER"] as const).map((slot) => {
                const linked = application.documentLinks.find((link) => link.slot === slot);
                const compatibleDocuments = workspace.userDocuments.filter((document) =>
                  slot === "SENT_RESUME"
                    ? document.type === "RESUME" || document.type === "RESUME_TEMPLATE"
                    : document.type === "COVER_LETTER"
                );

                return (
                  <div key={slot} className="rounded-lg border border-border/70 bg-background p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {slot === "SENT_RESUME" ? "Resume" : "Cover letter"}
                    </p>
                    {linked ? (
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {linked.document.filename}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {linked.document.type.toLowerCase().replaceAll("_", " ")}
                          </p>
                        </div>
                        <form action={unlinkTrackedDocumentAction}>
                          <input type="hidden" name="applicationId" value={application.id} />
                          <input type="hidden" name="slot" value={slot} />
                          <button
                            type="submit"
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            Unlink
                          </button>
                        </form>
                      </div>
                    ) : compatibleDocuments.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No matching documents uploaded yet.
                      </p>
                    ) : (
                      <form action={linkTrackedDocumentAction} className="mt-3 flex gap-3">
                        <input type="hidden" name="applicationId" value={application.id} />
                        <input type="hidden" name="slot" value={slot} />
                        <select
                          name="documentId"
                          className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          defaultValue=""
                        >
                          <option value="" disabled>
                            Select a document
                          </option>
                          {compatibleDocuments.map((document) => (
                            <option key={document.id} value={document.id}>
                              {document.filename}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="h-9 rounded-lg border border-border px-4 text-sm font-medium"
                        >
                          Link
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Tags</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Current tags:{" "}
              {application.tags.length > 0
                ? application.tags.map(({ tag }) => tag.name).join(", ")
                : "none"}
            </p>
            {workspace.userTags.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {workspace.userTags.map((tag) => (
                  <span
                    key={tag.id}
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      application.tags.some((entry) => entry.tag.id === tag.id)
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          {application.canonicalJob ? (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Linked feed job</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {application.canonicalJob.title} · {application.canonicalJob.company}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {application.canonicalJob.location} · {application.canonicalJob.workMode.toLowerCase()}
              </p>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <Link href={`/jobs/${application.canonicalJob.id}`} className="hover:text-foreground">
                  Open job detail
                </Link>
                <a
                  href={application.canonicalJob.applyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground"
                >
                  Open apply URL
                </a>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
