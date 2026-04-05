import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";
import type { Prisma, UserAction } from "@/generated/prisma/client";

export async function recordAction(
  canonicalJobId: string,
  action: UserAction,
  metadata?: Prisma.InputJsonValue
) {
  const userId = await requireCurrentProfileId();
  return prisma.userBehaviorSignal.create({
    data: {
      userId,
      canonicalJobId,
      action,
      metadata: metadata ?? undefined,
    },
  });
}
