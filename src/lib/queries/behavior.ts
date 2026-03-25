import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import type { UserAction } from "@/generated/prisma";

export async function recordAction(
  canonicalJobId: string,
  action: UserAction,
  metadata?: Record<string, unknown>
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
