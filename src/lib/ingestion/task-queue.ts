import { prisma } from "@/lib/db";
import {
  Prisma,
  SourceTaskKind,
  SourceTaskStatus,
} from "@/generated/prisma/client";

export type SourceTaskPayload = Record<string, Prisma.InputJsonValue | null>;

const STALE_RUNNING_TASK_WINDOW_MINUTES: Record<SourceTaskKind, number> = {
  COMPANY_DISCOVERY: 180,
  REDISCOVERY: 180,
  SOURCE_VALIDATION: 60,
  CONNECTOR_POLL: 120,
  URL_HEALTH: 45,
};

async function recoverStaleRunningSourceTasks(
  kind: SourceTaskKind,
  now: Date
) {
  const staleAfterMinutes = STALE_RUNNING_TASK_WINDOW_MINUTES[kind] ?? 120;
  const staleCutoff = new Date(now.getTime() - staleAfterMinutes * 60 * 1000);

  return prisma.sourceTask.updateMany({
    where: {
      kind,
      status: "RUNNING",
      startedAt: { lt: staleCutoff },
    },
    data: {
      status: "PENDING",
      startedAt: null,
      finishedAt: null,
      notBeforeAt: now,
      lastError: `Recovered stale RUNNING task after exceeding ${staleAfterMinutes} minute lease window.`,
    },
  });
}

export async function enqueueSourceTask(input: {
  kind: SourceTaskKind;
  priorityScore?: number;
  notBeforeAt?: Date;
  companyId?: string | null;
  companySourceId?: string | null;
  canonicalJobId?: string | null;
  payloadJson?: SourceTaskPayload | null;
}) {
  return prisma.sourceTask.create({
    data: {
      kind: input.kind,
      priorityScore: input.priorityScore ?? 0,
      notBeforeAt: input.notBeforeAt ?? new Date(),
      companyId: input.companyId ?? null,
      companySourceId: input.companySourceId ?? null,
      canonicalJobId: input.canonicalJobId ?? null,
      payloadJson:
        input.payloadJson != null
          ? (input.payloadJson as Prisma.InputJsonValue)
          : Prisma.DbNull,
    },
  });
}

export async function enqueueUniqueSourceTask(input: {
  kind: SourceTaskKind;
  companyId?: string | null;
  companySourceId?: string | null;
  canonicalJobId?: string | null;
  priorityScore?: number;
  notBeforeAt?: Date;
  payloadJson?: SourceTaskPayload | null;
}) {
  const existing = await prisma.sourceTask.findFirst({
    where: {
      kind: input.kind,
      status: "PENDING",
      companyId: input.companyId ?? null,
      companySourceId: input.companySourceId ?? null,
      canonicalJobId: input.canonicalJobId ?? null,
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
  });

  if (existing) {
    return prisma.sourceTask.update({
      where: { id: existing.id },
      data: {
        priorityScore: Math.max(existing.priorityScore, input.priorityScore ?? 0),
        notBeforeAt:
          input.notBeforeAt && input.notBeforeAt < existing.notBeforeAt
            ? input.notBeforeAt
            : existing.notBeforeAt,
        payloadJson:
          input.payloadJson != null
            ? (input.payloadJson as Prisma.InputJsonValue)
            : existing.payloadJson != null
              ? (existing.payloadJson as Prisma.InputJsonValue)
              : Prisma.DbNull,
      },
    });
  }

  return enqueueSourceTask(input);
}

export async function claimSourceTasks(
  kind: SourceTaskKind,
  limit: number,
  now: Date = new Date()
) {
  await recoverStaleRunningSourceTasks(kind, now);

  const tasks = await prisma.sourceTask.findMany({
    where: {
      kind,
      status: "PENDING",
      notBeforeAt: { lte: now },
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
    take: limit,
  });

  const claimed = [];
  for (const task of tasks) {
    const updated = await prisma.sourceTask.updateMany({
      where: {
        id: task.id,
        status: "PENDING",
      },
      data: {
        status: "RUNNING",
        startedAt: now,
        attemptCount: task.attemptCount + 1,
      },
    });

    if (updated.count === 1) {
      claimed.push(task);
    }
  }

  return prisma.sourceTask.findMany({
    where: {
      id: { in: claimed.map((task) => task.id) },
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
  });
}

export async function finishSourceTask(
  taskId: string,
  status: Extract<SourceTaskStatus, "SUCCESS" | "FAILED" | "SKIPPED">,
  options: {
    finishedAt?: Date;
    lastError?: string | null;
    retryAt?: Date | null;
  } = {}
) {
  const finishedAt = options.finishedAt ?? new Date();

  if (status === "FAILED" && options.retryAt) {
    return prisma.sourceTask.update({
      where: { id: taskId },
      data: {
        status: "PENDING",
        startedAt: null,
        finishedAt: null,
        notBeforeAt: options.retryAt,
        lastError: options.lastError ?? null,
      },
    });
  }

  return prisma.sourceTask.update({
    where: { id: taskId },
    data: {
      status,
      finishedAt,
      lastError: options.lastError ?? null,
    },
  });
}
