import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type {
  DiscoveryMode,
  PipelineQueueName,
  PipelineTask,
  PipelineTaskStatus,
} from "@/generated/prisma/client";

export type PipelineTaskPayload = Record<string, Prisma.InputJsonValue | null>;

const STALE_RUNNING_PIPELINE_TASK_WINDOW_MINUTES = 20;

export async function enqueuePipelineTask(input: {
  queueName: PipelineQueueName;
  mode?: DiscoveryMode | null;
  priorityScore?: number;
  idempotencyKey?: string | null;
  notBeforeAt?: Date;
  maxAttempts?: number;
  payloadJson?: PipelineTaskPayload | null;
}) {
  return prisma.pipelineTask.create({
    data: {
      queueName: input.queueName,
      mode: input.mode ?? null,
      priorityScore: input.priorityScore ?? 0,
      idempotencyKey: input.idempotencyKey ?? null,
      notBeforeAt: input.notBeforeAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 8,
      payloadJson:
        input.payloadJson != null
          ? (input.payloadJson as Prisma.InputJsonValue)
          : Prisma.DbNull,
    },
  });
}

export async function enqueueUniquePipelineTask(input: {
  queueName: PipelineQueueName;
  mode?: DiscoveryMode | null;
  priorityScore?: number;
  idempotencyKey: string;
  notBeforeAt?: Date;
  maxAttempts?: number;
  payloadJson?: PipelineTaskPayload | null;
  reactivateOnSuccess?: boolean;
}) {
  const existing = await prisma.pipelineTask.findUnique({
    where: {
      queueName_idempotencyKey: {
        queueName: input.queueName,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });

  if (!existing) {
    return enqueuePipelineTask(input);
  }

  if (existing.status === "RUNNING") {
    return existing;
  }

  if (existing.status === "SUCCESS" && !input.reactivateOnSuccess) {
    return existing;
  }

  return prisma.pipelineTask.update({
    where: { id: existing.id },
    data: {
      status: "PENDING",
      mode: input.mode ?? existing.mode,
      priorityScore: Math.max(existing.priorityScore, input.priorityScore ?? 0),
      notBeforeAt:
        input.notBeforeAt && input.notBeforeAt < existing.notBeforeAt
          ? input.notBeforeAt
          : existing.notBeforeAt,
      maxAttempts: Math.max(existing.maxAttempts, input.maxAttempts ?? 8),
      lastError: null,
      payloadJson:
        input.payloadJson != null
          ? (input.payloadJson as Prisma.InputJsonValue)
          : existing.payloadJson != null
            ? (existing.payloadJson as Prisma.InputJsonValue)
            : Prisma.DbNull,
    },
  });
}

async function recoverStaleRunningPipelineTasks(queueName: PipelineQueueName, now: Date) {
  const staleCutoff = new Date(
    now.getTime() - STALE_RUNNING_PIPELINE_TASK_WINDOW_MINUTES * 60 * 1000
  );

  const result = await prisma.pipelineTask.updateMany({
    where: {
      queueName,
      status: "RUNNING",
      startedAt: { lt: staleCutoff },
    },
    data: {
      status: "PENDING",
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      notBeforeAt: now,
      lastError: `Recovered stale RUNNING pipeline task after exceeding ${STALE_RUNNING_PIPELINE_TASK_WINDOW_MINUTES} minute lease window.`,
    },
  });

  return result.count;
}

export async function claimPipelineTasks(
  queueName: PipelineQueueName,
  limit: number,
  options: { now?: Date; mode?: DiscoveryMode | null } = {}
) {
  const now = options.now ?? new Date();
  await recoverStaleRunningPipelineTasks(queueName, now);

  const claimCandidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH next_tasks AS (
      SELECT pt."id"
      FROM "PipelineTask" pt
      WHERE
        pt."queueName" = ${queueName}::"PipelineQueueName"
        AND pt."status" = 'PENDING'::"PipelineTaskStatus"
        AND pt."notBeforeAt" <= ${now}
        ${options.mode ? Prisma.sql`AND pt."mode" = ${options.mode}::"DiscoveryMode"` : Prisma.empty}
      ORDER BY pt."priorityScore" DESC, pt."createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "PipelineTask" pt
    SET
      "status" = 'RUNNING'::"PipelineTaskStatus",
      "startedAt" = ${now},
      "leaseExpiresAt" = ${new Date(now.getTime() + STALE_RUNNING_PIPELINE_TASK_WINDOW_MINUTES * 60 * 1000)},
      "attemptCount" = pt."attemptCount" + 1
    FROM next_tasks
    WHERE pt."id" = next_tasks."id"
    RETURNING pt."id"
  `);

  if (claimCandidates.length === 0) {
    return [];
  }

  return prisma.pipelineTask.findMany({
    where: {
      id: { in: claimCandidates.map((task) => task.id) },
    },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "asc" }],
  });
}

export async function finishPipelineTask(
  taskId: string,
  status: Extract<PipelineTaskStatus, "SUCCESS" | "FAILED" | "SKIPPED">,
  options: {
    finishedAt?: Date;
    lastError?: string | null;
    retryAt?: Date | null;
  } = {}
) {
  const finishedAt = options.finishedAt ?? new Date();

  if (status === "FAILED" && options.retryAt) {
    return prisma.pipelineTask.update({
      where: { id: taskId },
      data: {
        status: "PENDING",
        startedAt: null,
        finishedAt: null,
        leaseExpiresAt: null,
        notBeforeAt: options.retryAt,
        lastError: options.lastError ?? null,
      },
    });
  }

  return prisma.pipelineTask.update({
    where: { id: taskId },
    data: {
      status,
      finishedAt,
      leaseExpiresAt: null,
      lastError: options.lastError ?? null,
    },
  });
}

export function readPipelinePayload(
  task: Pick<PipelineTask, "payloadJson">
): Record<string, Prisma.JsonValue | null> {
  const value = task.payloadJson;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, Prisma.JsonValue | null>;
}
