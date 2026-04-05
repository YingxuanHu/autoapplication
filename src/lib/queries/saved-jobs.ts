import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";

export async function getSavedJobs(status?: string) {
  const userId = await requireCurrentProfileId();
  const where: { userId: string; status?: "ACTIVE" | "APPLIED" | "EXPIRED" | "DISMISSED" } = {
    userId,
  };
  if (status) {
    where.status = status as "ACTIVE" | "APPLIED" | "EXPIRED" | "DISMISSED";
  }

  const savedJobs = await prisma.savedJob.findMany({
    where,
    include: {
      canonicalJob: {
        include: {
          eligibility: true,
          sourceMappings: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return savedJobs;
}

export async function saveJob(canonicalJobId: string) {
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
      status: "ACTIVE",
    },
    update: {
      status: "ACTIVE",
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

export async function dismissSavedJob(canonicalJobId: string) {
  const userId = await requireCurrentProfileId();
  const existing = await prisma.savedJob.findUnique({
    where: {
      userId_canonicalJobId: {
        userId,
        canonicalJobId,
      },
    },
    select: { id: true },
  });

  if (!existing) return null;

  return prisma.savedJob.update({
    where: {
      userId_canonicalJobId: {
        userId,
        canonicalJobId,
      },
    },
    data: {
      status: "DISMISSED",
    },
  });
}
