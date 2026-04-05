import type { Prisma, TrackedApplicationDocumentSlot, TrackedApplicationEventType, TrackedApplicationStatus } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import {
  requireCurrentAuthUserId,
  requireCurrentProfileId,
} from "@/lib/current-user";
import { checkSingleTrackedApplicationReminder } from "@/lib/reminders";
import { TRACKED_ACTIVE_STATUSES } from "@/lib/tracker-constants";

export type TrackerDeadlineFilter = "ALL" | "UPCOMING" | "OVERDUE" | "NO_DEADLINE";
export type TrackerSortFilter =
  | "UPDATED_DESC"
  | "UPDATED_ASC"
  | "DEADLINE_ASC"
  | "DEADLINE_DESC"
  | "COMPANY_ASC"
  | "COMPANY_DESC";

function startOfUtcDay(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function normalizeOptionalUrl(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://");
  }

  return trimmed;
}

function normalizeTagNames(raw: string | string[]) {
  const tokens = Array.isArray(raw) ? raw : raw.split(",");

  return [...new Set(
    tokens
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.slice(0, 40))
  )].sort((left, right) => left.localeCompare(right));
}

function statusToEventType(status: TrackedApplicationStatus): TrackedApplicationEventType {
  switch (status) {
    case "APPLIED":
      return "APPLIED";
    case "SCREEN":
      return "SCREEN";
    case "INTERVIEW":
      return "INTERVIEW";
    case "OFFER":
      return "OFFER";
    case "REJECTED":
      return "REJECTED";
    case "WISHLIST":
    case "WITHDRAWN":
    default:
      return "NOTE";
  }
}

function isDocumentTypeCompatibleWithSlot(
  slot: TrackedApplicationDocumentSlot,
  documentType: string
) {
  if (slot === "SENT_RESUME") {
    return documentType === "RESUME";
  }

  return documentType === "COVER_LETTER";
}

function getIncompatibleDocumentTypeMessage(slot: TrackedApplicationDocumentSlot) {
  if (slot === "SENT_RESUME") {
    return "Only uploaded resumes can be linked to the resume slot.";
  }

  return "Only uploaded cover letters can be linked to the cover letter slot.";
}

async function upsertTrackedApplicationResumeDocument(input: {
  applicationId: string;
  profileId: string;
  documentId: string | null | undefined;
}) {
  if (!input.documentId) {
    return;
  }

  const resumeDocument = await prisma.document.findFirst({
    where: {
      id: input.documentId,
      userId: input.profileId,
      type: "RESUME",
    },
    select: { id: true },
  });

  if (!resumeDocument) {
    return;
  }

  await prisma.trackedApplicationDocument.upsert({
    where: {
      trackedApplicationId_slot: {
        trackedApplicationId: input.applicationId,
        slot: "SENT_RESUME",
      },
    },
    create: {
      trackedApplicationId: input.applicationId,
      documentId: resumeDocument.id,
      slot: "SENT_RESUME",
    },
    update: {
      documentId: resumeDocument.id,
    },
  });
}

function buildTrackedOrderBy(sort: TrackerSortFilter): Prisma.TrackedApplicationOrderByWithRelationInput[] {
  switch (sort) {
    case "UPDATED_ASC":
      return [{ updatedAt: "asc" }];
    case "DEADLINE_ASC":
      return [{ deadline: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }];
    case "DEADLINE_DESC":
      return [{ deadline: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }];
    case "COMPANY_ASC":
      return [{ company: "asc" }, { updatedAt: "desc" }];
    case "COMPANY_DESC":
      return [{ company: "desc" }, { updatedAt: "desc" }];
    case "UPDATED_DESC":
    default:
      return [{ updatedAt: "desc" }];
  }
}

export async function getTrackedDashboardData(input: {
  status?: TrackedApplicationStatus | "ALL";
  deadline?: TrackerDeadlineFilter;
  sort?: TrackerSortFilter;
  tags?: string[];
}) {
  const userId = await requireCurrentAuthUserId();
  const status = input.status ?? "ALL";
  const deadline = input.deadline ?? "ALL";
  const tags = normalizeTagNames(input.tags ?? []);
  const where: Prisma.TrackedApplicationWhereInput = {
    userId,
  };

  if (status !== "ALL") {
    where.status = status;
  }

  const today = startOfUtcDay(new Date());
  if (deadline === "UPCOMING") {
    where.deadline = { gte: today };
  } else if (deadline === "OVERDUE") {
    where.deadline = { lt: today };
  } else if (deadline === "NO_DEADLINE") {
    where.deadline = null;
  }

  if (tags.length > 0) {
    where.AND = tags.map((name) => ({
      tags: {
        some: {
          tag: {
            name,
            userId,
          },
        },
      },
    }));
  }

  const orderBy = buildTrackedOrderBy(input.sort ?? "UPDATED_DESC");

  const [applications, totalApplicationCount, activeCount, unreadNotificationCount, userTags] =
    await Promise.all([
      prisma.trackedApplication.findMany({
        where,
        select: {
          id: true,
          canonicalJobId: true,
          company: true,
          roleTitle: true,
          roleUrl: true,
          status: true,
          deadline: true,
          notes: true,
          updatedAt: true,
          canonicalJob: {
            select: {
              id: true,
              status: true,
              location: true,
              workMode: true,
            },
          },
          tags: {
            orderBy: {
              tag: {
                name: "asc",
              },
            },
            select: {
              tag: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy,
      }),
      prisma.trackedApplication.count({
        where: { userId },
      }),
      prisma.trackedApplication.count({
        where: {
          userId,
          status: {
            in: TRACKED_ACTIVE_STATUSES,
          },
        },
      }),
      prisma.notification.count({
        where: { userId, readAt: null },
      }),
      prisma.tag.findMany({
        where: { userId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);

  return {
    applications,
    totalApplicationCount,
    activeCount,
    unreadNotificationCount,
    userTags,
    selectedTags: tags,
  };
}

export async function getTrackedApplicationWorkspace(id: string) {
  const [authUserId, profileId] = await Promise.all([
    requireCurrentAuthUserId(),
    requireCurrentProfileId(),
  ]);

  const [application, unreadNotificationCount, userDocuments, userTags] =
    await Promise.all([
      prisma.trackedApplication.findFirst({
        where: { id, userId: authUserId },
        select: {
          id: true,
          company: true,
          roleTitle: true,
          roleUrl: true,
          status: true,
          deadline: true,
          jobDescription: true,
          fitAnalysis: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
          canonicalJob: {
            select: {
              id: true,
              title: true,
              company: true,
              location: true,
              workMode: true,
              status: true,
              applyUrl: true,
              deadline: true,
            },
          },
          events: {
            orderBy: { timestamp: "desc" },
            select: {
              id: true,
              type: true,
              timestamp: true,
              note: true,
              reminderAt: true,
              reminderNotifiedAt: true,
            },
          },
          documentLinks: {
            orderBy: { slot: "asc" },
            select: {
              id: true,
              slot: true,
              document: {
                select: {
                  id: true,
                  title: true,
                  type: true,
                  analysis: {
                    select: {
                      documentId: true,
                    },
                  },
                },
              },
            },
          },
          tags: {
            orderBy: {
              tag: {
                name: "asc",
              },
            },
            select: {
              tag: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      }),
      prisma.notification.count({
        where: { userId: authUserId, readAt: null },
      }),
      prisma.document.findMany({
        where: { userId: profileId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          type: true,
          analysis: {
            select: {
              documentId: true,
            },
          },
        },
      }),
      prisma.tag.findMany({
        where: { userId: authUserId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);

  return {
    application,
    unreadNotificationCount,
    userDocuments,
    userTags,
  };
}

export async function getNotificationCenterData() {
  const userId = await requireCurrentAuthUserId();

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      select: {
        id: true,
        trackedApplicationId: true,
        title: true,
        message: true,
        createdAt: true,
        readAt: true,
      },
    }),
    prisma.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  return {
    notifications,
    unreadCount,
  };
}

export async function getTrackerSettingsData() {
  const userId = await requireCurrentAuthUserId();

  const [user, unreadNotificationCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailNotificationsEnabled: true,
        emailVerified: true,
        name: true,
      },
    }),
    prisma.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  return {
    user,
    unreadNotificationCount,
  };
}

export async function getComparableDocuments() {
  const [authUserId, profileId] = await Promise.all([
    requireCurrentAuthUserId(),
    requireCurrentProfileId(),
  ]);

  const [documents, unreadNotificationCount] = await Promise.all([
    prisma.document.findMany({
      where: { userId: profileId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        filename: true,
        type: true,
        extractedText: true,
      },
    }),
    prisma.notification.count({
      where: { userId: authUserId, readAt: null },
    }),
  ]);

  return {
    documents,
    unreadNotificationCount,
  };
}

export async function getComparableDocumentText(documentId: string) {
  const profileId = await requireCurrentProfileId();
  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      userId: profileId,
    },
    select: {
      extractedText: true,
    },
  });

  if (!document) {
    return { text: null, error: "Document not found." };
  }

  if (!document.extractedText?.trim()) {
    return {
      text: null,
      error: "This document has no extracted text. Re-upload or parse it first.",
    };
  }

  return {
    text: document.extractedText,
    error: null,
  };
}

export async function createTrackedApplication(input: {
  company: string;
  roleTitle: string;
  roleUrl?: string | null;
  status?: TrackedApplicationStatus;
  deadline?: Date | null;
  notes?: string | null;
}) {
  const userId = await requireCurrentAuthUserId();
  const status = input.status ?? "WISHLIST";

  const created = await prisma.trackedApplication.create({
    data: {
      userId,
      company: input.company.trim(),
      roleTitle: input.roleTitle.trim(),
      roleUrl: normalizeOptionalUrl(input.roleUrl),
      status,
      deadline: input.deadline ?? null,
      notes: input.notes?.trim() || null,
    },
  });

  await prisma.trackedApplicationEvent.create({
    data: {
      trackedApplicationId: created.id,
      type: statusToEventType(status),
      note:
        status === "WISHLIST"
          ? "Application added to tracker."
          : `Application added to tracker with status ${status.toLowerCase()}.`,
    },
  });

  await checkSingleTrackedApplicationReminder(created.id);
  return created;
}

const TRACKED_STATUS_NOTE: Record<TrackedApplicationStatus, string> = {
  WISHLIST: "wishlist",
  APPLIED: "applied",
  SCREEN: "screen",
  INTERVIEW: "interview",
  OFFER: "offer",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
};

export async function upsertTrackedApplicationFromJob(input: {
  canonicalJobId: string;
  status: TrackedApplicationStatus;
}) {
  const [authUserId, profileId] = await Promise.all([
    requireCurrentAuthUserId(),
    requireCurrentProfileId(),
  ]);

  const [existing, job] = await Promise.all([
    prisma.trackedApplication.findUnique({
      where: {
        userId_canonicalJobId: {
          userId: authUserId,
          canonicalJobId: input.canonicalJobId,
        },
      },
      select: {
        id: true,
        status: true,
        notes: true,
        fitAnalysis: true,
        jobDescription: true,
      },
    }),
    prisma.jobCanonical.findUnique({
      where: { id: input.canonicalJobId },
      select: {
        id: true,
        company: true,
        title: true,
        applyUrl: true,
        deadline: true,
        description: true,
        applicationPackages: {
          where: { userId: profileId },
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            whyItMatches: true,
            resumeVariant: {
              select: {
                documentId: true,
              },
            },
          },
        },
      },
    }),
  ]);

  if (!job) {
    throw new Error("Job not found");
  }

  const latestPackage = job.applicationPackages[0] ?? null;
  const tracked = existing
    ? await prisma.trackedApplication.update({
        where: { id: existing.id },
        data: {
          company: job.company,
          roleTitle: job.title,
          roleUrl: job.applyUrl,
          deadline: job.deadline,
          status: input.status,
          jobDescription: existing.jobDescription ?? job.description,
          fitAnalysis: existing.fitAnalysis ?? latestPackage?.whyItMatches ?? null,
        },
      })
    : await prisma.trackedApplication.create({
        data: {
          userId: authUserId,
          canonicalJobId: job.id,
          company: job.company,
          roleTitle: job.title,
          roleUrl: job.applyUrl,
          status: input.status,
          deadline: job.deadline,
          jobDescription: job.description,
          fitAnalysis: latestPackage?.whyItMatches ?? null,
        },
      });

  await prisma.trackedApplicationEvent.create({
    data: {
      trackedApplicationId: tracked.id,
      type: statusToEventType(input.status),
      note: existing
        ? existing.status === input.status
          ? `Application refreshed from the jobs feed as ${TRACKED_STATUS_NOTE[input.status]}.`
          : `Status updated from the jobs feed to ${TRACKED_STATUS_NOTE[input.status]}.`
        : input.status === "WISHLIST"
          ? "Application added to tracker from the jobs feed."
          : `Application added to tracker from the jobs feed as ${TRACKED_STATUS_NOTE[input.status]}.`,
    },
  });

  const resumeDocumentId = latestPackage?.resumeVariant.documentId;
  await upsertTrackedApplicationResumeDocument({
    applicationId: tracked.id,
    profileId,
    documentId: resumeDocumentId,
  });

  await checkSingleTrackedApplicationReminder(tracked.id);
  return {
    applicationId: tracked.id,
    created: !existing,
    status: tracked.status,
  };
}

export async function updateTrackedApplicationField(input: {
  applicationId: string;
  field: "notes" | "jobDescription" | "fitAnalysis";
  value?: string | null;
}) {
  const userId = await requireCurrentAuthUserId();
  const result = await prisma.trackedApplication.updateMany({
    where: {
      id: input.applicationId,
      userId,
    },
    data: {
      [input.field]: input.value?.trim() || null,
      updatedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw new Error("Tracked application not found");
  }
}

export async function updateTrackedApplicationStatus(input: {
  applicationId: string;
  status: TrackedApplicationStatus;
}) {
  const userId = await requireCurrentAuthUserId();
  const existing = await prisma.trackedApplication.findFirst({
    where: {
      id: input.applicationId,
      userId,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!existing) {
    throw new Error("Tracked application not found");
  }

  if (existing.status === input.status) {
    return { changed: false };
  }

  await prisma.$transaction([
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: {
        status: input.status,
        updatedAt: new Date(),
      },
    }),
    prisma.trackedApplicationEvent.create({
      data: {
        trackedApplicationId: input.applicationId,
        type: statusToEventType(input.status),
        note: `Status updated to ${TRACKED_STATUS_NOTE[input.status]}.`,
      },
    }),
  ]);

  await checkSingleTrackedApplicationReminder(input.applicationId);
  return { changed: true };
}

export async function addTrackedApplicationEvent(input: {
  applicationId: string;
  type: TrackedApplicationEventType;
  note?: string | null;
  reminderAt?: Date | null;
}) {
  const userId = await requireCurrentAuthUserId();
  const application = await prisma.trackedApplication.findFirst({
    where: {
      id: input.applicationId,
      userId,
    },
    select: { id: true },
  });

  if (!application) {
    throw new Error("Tracked application not found");
  }

  const mappedStatus: Partial<Record<TrackedApplicationEventType, TrackedApplicationStatus>> = {
    APPLIED: "APPLIED",
    SCREEN: "SCREEN",
    INTERVIEW: "INTERVIEW",
    OFFER: "OFFER",
    REJECTED: "REJECTED",
  };

  await prisma.$transaction([
    prisma.trackedApplicationEvent.create({
      data: {
        trackedApplicationId: input.applicationId,
        type: input.type,
        note: input.note?.trim() || null,
        reminderAt: input.reminderAt ?? null,
      },
    }),
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: {
        updatedAt: new Date(),
        ...(mappedStatus[input.type] ? { status: mappedStatus[input.type] } : {}),
      },
    }),
  ]);
}

export async function deleteTrackedApplicationEvent(input: {
  applicationId: string;
  eventId: string;
}) {
  const userId = await requireCurrentAuthUserId();
  const event = await prisma.trackedApplicationEvent.findFirst({
    where: {
      id: input.eventId,
      trackedApplication: {
        id: input.applicationId,
        userId,
      },
    },
    select: { id: true },
  });

  if (!event) {
    throw new Error("Timeline event not found");
  }

  await prisma.$transaction([
    prisma.trackedApplicationEvent.delete({
      where: { id: input.eventId },
    }),
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: { updatedAt: new Date() },
    }),
  ]);
}

export async function addTrackedApplicationTag(input: {
  applicationId: string;
  name: string;
}) {
  const userId = await requireCurrentAuthUserId();
  const application = await prisma.trackedApplication.findFirst({
    where: {
      id: input.applicationId,
      userId,
    },
    select: {
      id: true,
    },
  });

  if (!application) {
    throw new Error("Tracked application not found");
  }

  const [name] = normalizeTagNames([input.name]);
  if (!name) {
    throw new Error("Tag name is required.");
  }

  const tag = await prisma.tag.upsert({
    where: {
      userId_name: {
        userId,
        name,
      },
    },
    update: {},
    create: {
      userId,
      name,
    },
    select: {
      id: true,
    },
  });

  await prisma.$transaction([
    prisma.trackedApplicationTag.createMany({
      data: [{ trackedApplicationId: input.applicationId, tagId: tag.id }],
      skipDuplicates: true,
    }),
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  return { name };
}

export async function removeTrackedApplicationTag(input: {
  applicationId: string;
  tagId: string;
}) {
  const userId = await requireCurrentAuthUserId();
  const application = await prisma.trackedApplication.findFirst({
    where: {
      id: input.applicationId,
      userId,
    },
    select: {
      id: true,
    },
  });

  if (!application) {
    throw new Error("Tracked application not found");
  }

  await prisma.$transaction([
    prisma.trackedApplicationTag.deleteMany({
      where: {
        trackedApplicationId: input.applicationId,
        tagId: input.tagId,
      },
    }),
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: { updatedAt: new Date() },
    }),
  ]);
}

export async function linkTrackedApplicationDocument(input: {
  applicationId: string;
  documentId: string;
  slot: TrackedApplicationDocumentSlot;
}) {
  const [authUserId, profileId] = await Promise.all([
    requireCurrentAuthUserId(),
    requireCurrentProfileId(),
  ]);

  const [application, document] = await Promise.all([
    prisma.trackedApplication.findFirst({
      where: { id: input.applicationId, userId: authUserId },
      select: { id: true },
    }),
    prisma.document.findFirst({
      where: { id: input.documentId, userId: profileId },
      select: { id: true, type: true },
    }),
  ]);

  if (!application) {
    throw new Error("Tracked application not found");
  }

  if (!document) {
    throw new Error("Document not found");
  }

  if (!isDocumentTypeCompatibleWithSlot(input.slot, document.type)) {
    throw new Error(getIncompatibleDocumentTypeMessage(input.slot));
  }

  await prisma.$transaction([
    prisma.trackedApplicationDocument.upsert({
      where: {
        trackedApplicationId_slot: {
          trackedApplicationId: input.applicationId,
          slot: input.slot,
        },
      },
      create: {
        trackedApplicationId: input.applicationId,
        documentId: input.documentId,
        slot: input.slot,
      },
      update: {
        documentId: input.documentId,
      },
    }),
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: { updatedAt: new Date() },
    }),
  ]);
}

export async function unlinkTrackedApplicationDocument(input: {
  applicationId: string;
  slot: TrackedApplicationDocumentSlot;
}) {
  const userId = await requireCurrentAuthUserId();
  const application = await prisma.trackedApplication.findFirst({
    where: {
      id: input.applicationId,
      userId,
    },
    select: { id: true },
  });

  if (!application) {
    throw new Error("Tracked application not found");
  }

  await prisma.$transaction([
    prisma.trackedApplicationDocument.deleteMany({
      where: {
        trackedApplicationId: input.applicationId,
        slot: input.slot,
      },
    }),
    prisma.trackedApplication.update({
      where: { id: input.applicationId },
      data: { updatedAt: new Date() },
    }),
  ]);
}

export async function markNotificationRead(notificationId: string) {
  const userId = await requireCurrentAuthUserId();
  await prisma.notification.updateMany({
    where: {
      id: notificationId,
      userId,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });
}

export async function markAllNotificationsRead() {
  const userId = await requireCurrentAuthUserId();
  await prisma.notification.updateMany({
    where: {
      userId,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });
}

export async function saveTrackerSettings(input: {
  emailNotificationsEnabled: boolean;
}) {
  const userId = await requireCurrentAuthUserId();
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailNotificationsEnabled: input.emailNotificationsEnabled,
    },
  });
}

export async function syncTrackedApplicationFromSubmission(canonicalJobId: string) {
  const [authUserId, profileId] = await Promise.all([
    requireCurrentAuthUserId(),
    requireCurrentProfileId(),
  ]);

  const [existing, job] = await Promise.all([
    prisma.trackedApplication.findUnique({
      where: {
        userId_canonicalJobId: {
          userId: authUserId,
          canonicalJobId,
        },
      },
      select: {
        id: true,
        status: true,
        notes: true,
        fitAnalysis: true,
        jobDescription: true,
      },
    }),
    prisma.jobCanonical.findUnique({
      where: { id: canonicalJobId },
      select: {
        id: true,
        company: true,
        title: true,
        applyUrl: true,
        deadline: true,
        description: true,
        applicationPackages: {
          where: { userId: profileId },
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            whyItMatches: true,
            resumeVariant: {
              select: {
                documentId: true,
              },
            },
          },
        },
      },
    }),
  ]);

  if (!job) {
    throw new Error("Job not found");
  }

  const latestPackage = job.applicationPackages[0] ?? null;
  const nextStatus: TrackedApplicationStatus =
    existing?.status === "WISHLIST" || !existing
      ? "APPLIED"
      : existing.status;

  const tracked = existing
    ? await prisma.trackedApplication.update({
        where: { id: existing.id },
        data: {
          company: job.company,
          roleTitle: job.title,
          roleUrl: job.applyUrl,
          deadline: job.deadline,
          status: nextStatus,
          jobDescription: existing.jobDescription ?? job.description,
          fitAnalysis: existing.fitAnalysis ?? latestPackage?.whyItMatches ?? null,
        },
      })
    : await prisma.trackedApplication.create({
        data: {
          userId: authUserId,
          canonicalJobId: job.id,
          company: job.company,
          roleTitle: job.title,
          roleUrl: job.applyUrl,
          status: "APPLIED",
          deadline: job.deadline,
          jobDescription: job.description,
          fitAnalysis: latestPackage?.whyItMatches ?? null,
        },
      });

  if (!existing || existing.status === "WISHLIST") {
    await prisma.trackedApplicationEvent.create({
      data: {
        trackedApplicationId: tracked.id,
        type: "APPLIED",
        note: !existing
          ? "Created automatically from the jobs apply flow."
          : "Marked applied from the jobs apply flow.",
      },
    });
  }

  const resumeDocumentId = latestPackage?.resumeVariant.documentId;
  await upsertTrackedApplicationResumeDocument({
    applicationId: tracked.id,
    profileId,
    documentId: resumeDocumentId,
  });

  await checkSingleTrackedApplicationReminder(tracked.id);
  return tracked;
}

export async function syncTrackedApplicationLifecycleFromSubmission(input: {
  canonicalJobId: string;
  submissionStatus: "CONFIRMED" | "FAILED" | "WITHDRAWN";
}) {
  const userId = await requireCurrentAuthUserId();
  const existing = await prisma.trackedApplication.findUnique({
    where: {
      userId_canonicalJobId: {
        userId,
        canonicalJobId: input.canonicalJobId,
      },
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!existing) {
    return null;
  }

  if (input.submissionStatus === "WITHDRAWN") {
    if (existing.status !== "WITHDRAWN") {
      await prisma.$transaction([
        prisma.trackedApplication.update({
          where: { id: existing.id },
          data: { status: "WITHDRAWN" },
        }),
        prisma.trackedApplicationEvent.create({
          data: {
            trackedApplicationId: existing.id,
            type: "NOTE",
            note: "Withdrawn from the jobs apply flow.",
          },
        }),
      ]);
    }
    return "WITHDRAWN";
  }

  if (input.submissionStatus === "FAILED") {
    await prisma.trackedApplicationEvent.create({
      data: {
        trackedApplicationId: existing.id,
        type: "NOTE",
        note: "Submission marked failed in the jobs apply flow.",
      },
    });
    return existing.status;
  }

  await prisma.trackedApplicationEvent.create({
    data: {
      trackedApplicationId: existing.id,
      type: "NOTE",
      note: "Submission confirmed in the jobs apply flow.",
    },
  });
  return existing.status;
}
