import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import type { Prisma, UserAction } from "@/generated/prisma/client";

export async function recordAction(
  canonicalJobId: string,
  action: UserAction,
  metadata?: Prisma.InputJsonValue
) {
  return prisma.userBehaviorSignal.create({
    data: {
      userId: DEMO_USER_ID,
      canonicalJobId,
      action,
      metadata: metadata ?? undefined,
    },
  });
}
