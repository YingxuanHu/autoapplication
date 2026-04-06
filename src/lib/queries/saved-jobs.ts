import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";

export async function saveJob(
  canonicalJobId: string,
  status: "ACTIVE" | "APPLIED" | "EXPIRED" | "DISMISSED" = "ACTIVE"
) {
  const userId = await requireCurrentProfileId();
  return prisma.savedJob.upsert({
    where: {
      userId_canonicalJobId: {
        userId,
        canonicalJobId,
      },
    },
    create: {
      userId,
      canonicalJobId,
      status,
    },
    update: {
      status,
    },
  });
}

export async function unsaveJob(canonicalJobId: string) {
  const userId = await requireCurrentProfileId();
  return prisma.savedJob.delete({
    where: {
      userId_canonicalJobId: {
        userId,
        canonicalJobId,
      },
    },
  });
}
