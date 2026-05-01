import { prisma } from "@/lib/db";
import {
  Prisma,
  SourceTask,
  SourceTaskKind,
  SourceTaskStatus,
} from "@/generated/prisma/client";

export type SourceTaskPayload = Record<string, Prisma.InputJsonValue | null>;

const STALE_RUNNING_TASK_WINDOW_MINUTES: Record<SourceTaskKind, number> = {
  COMPANY_DISCOVERY: 180,
  REDISCOVERY: 180,
  SOURCE_VALIDATION: 60,
  CONNECTOR_POLL: 20,
  URL_HEALTH: 45,
};

const ACTIVE_UNIQUE_SOURCE_TASK_STATUSES: SourceTaskStatus[] = [
  "PENDING",
  "RUNNING",
];

function buildSourceTaskUniquenessWhere(input: {
  kind: SourceTaskKind;
  companyId?: string | null;
  companySourceId?: string | null;
  canonicalJobId?: string | null;
}) {
  if (input.companySourceId) {
    return {
      kind: input.kind,
      companySourceId: input.companySourceId,
    } satisfies Prisma.SourceTaskWhereInput;
  }

  if (input.canonicalJobId) {
    return {
      kind: input.kind,
      canonicalJobId: input.canonicalJobId,
    } satisfies Prisma.SourceTaskWhereInput;
  }

  return {
    kind: input.kind,
    companyId: input.companyId ?? null,
    companySourceId: null,
    canonicalJobId: null,
  } satisfies Prisma.SourceTaskWhereInput;
}

function buildSourceTaskUniquenessKey(task: {
  kind: SourceTaskKind;
  companyId: string | null;
  companySourceId: string | null;
  canonicalJobId: string | null;
}) {
  if (task.companySourceId) {
    return [task.kind, "source", task.companySourceId].join("|");
  }

  if (task.canonicalJobId) {
    return [task.kind, "canonical", task.canonicalJobId].join("|");
  }

  return [task.kind, "company", task.companyId ?? "none"].join("|");
}

async function collapseDuplicatePendingSourceTasks(
  kind: SourceTaskKind,
  now: Date
) {
  const pendingTasks = await prisma.sourceTask.findMany({
    where: { kind, status: "PENDING" },
    select: {
      id: true,
      kind: true,
      companyId: true,
      companySourceId: true,
      canonicalJobId: true,
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
  });

  const seen = new Set<string>();
  const duplicateIds: string[] = [];

  for (const task of pendingTasks) {
    const key = buildSourceTaskUniquenessKey(task);
    if (seen.has(key)) {
      duplicateIds.push(task.id);
      continue;
    }

    seen.add(key);
  }

  if (duplicateIds.length === 0) {
    return 0;
  }

  const result = await prisma.sourceTask.updateMany({
    where: {
      id: { in: duplicateIds },
      status: "PENDING",
    },
    data: {
      status: "SKIPPED",
      finishedAt: now,
      lastError:
        "Skipped duplicate pending source task because an equivalent task was already queued.",
    },
  });

  return result.count;
}

async function recoverStaleRunningSourceTasks(
  kind: SourceTaskKind,
  now: Date
) {
  const staleAfterMinutes = STALE_RUNNING_TASK_WINDOW_MINUTES[kind] ?? 120;
  const staleCutoff = new Date(now.getTime() - staleAfterMinutes * 60 * 1000);
  const staleTasks = await prisma.sourceTask.findMany({
    where: {
      kind,
      status: "RUNNING",
      startedAt: { lt: staleCutoff },
    },
    select: {
      id: true,
      kind: true,
      companyId: true,
      companySourceId: true,
      canonicalJobId: true,
    },
  });

  let recoveredCount = 0;

  for (const task of staleTasks) {
    const activeDuplicate = await prisma.sourceTask.findFirst({
      where: {
        ...buildSourceTaskUniquenessWhere(task),
        id: { not: task.id },
        status: { in: ACTIVE_UNIQUE_SOURCE_TASK_STATUSES },
      },
      select: { id: true },
    });

    if (activeDuplicate) {
      await prisma.sourceTask.updateMany({
        where: {
          id: task.id,
          status: "RUNNING",
        },
        data: {
          status: "SKIPPED",
          finishedAt: now,
          lastError:
            "Skipped stale RUNNING task because an equivalent source task was already active.",
        },
      });
      continue;
    }

    const updated = await prisma.sourceTask.updateMany({
      where: {
        id: task.id,
        status: "RUNNING",
      },
      data: {
        status: "PENDING",
        startedAt: null,
        finishedAt: null,
        notBeforeAt: now,
        lastError: `Recovered stale RUNNING task after exceeding ${staleAfterMinutes} minute lease window.`,
      },
    });

    recoveredCount += updated.count;
  }

  return recoveredCount;
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
      ...buildSourceTaskUniquenessWhere(input),
      status: { in: ACTIVE_UNIQUE_SOURCE_TASK_STATUSES },
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
  });

  if (existing) {
    if (existing.status === "RUNNING") {
      return existing;
    }

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
  now: Date = new Date(),
  filters: {
    companySourceIds?: string[];
  } = {}
) {
  const companySourceIds =
    filters.companySourceIds?.filter((value) => value.trim().length > 0) ?? [];
  if (companySourceIds.length === 0 && filters.companySourceIds) {
    return [];
  }

  await recoverStaleRunningSourceTasks(kind, now);
  await collapseDuplicatePendingSourceTasks(kind, now);

  const companySourceFilter =
    companySourceIds.length > 0
      ? Prisma.sql`AND st."companySourceId" IN (${Prisma.join(companySourceIds)})`
      : Prisma.empty;

  const claimCandidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH next_tasks AS (
      SELECT st."id"
      FROM "SourceTask" st
      WHERE
        st."kind" = ${kind}::"SourceTaskKind"
        AND st."status" = 'PENDING'::"SourceTaskStatus"
        AND st."notBeforeAt" <= ${now}
        ${companySourceFilter}
      ORDER BY st."priorityScore" DESC, st."createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SourceTask" st
    SET
      "status" = 'RUNNING'::"SourceTaskStatus",
      "startedAt" = ${now},
      "attemptCount" = st."attemptCount" + 1
    FROM next_tasks
    WHERE st."id" = next_tasks."id"
    RETURNING st."id"
  `);

  if (claimCandidates.length === 0) {
    return [];
  }

  const tasks = await prisma.sourceTask.findMany({
    where: {
      id: { in: claimCandidates.map((task) => task.id) },
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
  });

  const claimed: SourceTask[] = [];
  const claimedKeys = new Set<string>();
  for (const task of tasks) {
    const taskKey = buildSourceTaskUniquenessKey(task);
    if (claimedKeys.has(taskKey)) {
      await prisma.sourceTask.updateMany({
        where: {
          id: task.id,
          status: "PENDING",
        },
        data: {
          status: "SKIPPED",
          finishedAt: now,
          lastError:
            "Skipped duplicate source task because an equivalent task was already claimed in this batch.",
        },
      });
      continue;
    }

    const runningDuplicate = await prisma.sourceTask.findFirst({
      where: {
        ...buildSourceTaskUniquenessWhere(task),
        id: { not: task.id },
        status: "RUNNING",
      },
      select: { id: true },
    });

    if (runningDuplicate) {
      await prisma.sourceTask.updateMany({
        where: {
          id: task.id,
          status: "PENDING",
        },
        data: {
          status: "SKIPPED",
          finishedAt: now,
          lastError:
            "Skipped duplicate source task because an equivalent task is already running.",
        },
      });
      continue;
    }

    const updated = await prisma.sourceTask.updateMany({
      where: {
        id: task.id,
        status: "RUNNING",
        startedAt: now,
      },
      data: {
        status: "RUNNING",
      },
    });

    if (updated.count === 1) {
      claimed.push(task);
      claimedKeys.add(taskKey);
    }
  }

  return claimed;
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
