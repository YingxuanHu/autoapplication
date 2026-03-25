import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";

export async function getSavedJobs(status?: string) {
  const where: { userId: string; status?: "ACTIVE" | "APPLIED" | "EXPIRED" | "DISMISSED" } = {
    userId: DEMO_USER_ID,
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
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return savedJobs;
}

export async function saveJob(canonicalJobId: string) {
  return prisma.savedJob.upsert({
    where: {
      userId_canonicalJobId: {
        userId: DEMO_USER_ID,
        canonicalJobId,
      },
    },
    create: {
      userId: DEMO_USER_ID,
      canonicalJobId,
      status: "ACTIVE",
    },
    update: {
      status: "ACTIVE",
    },
  });
}

export async function unsaveJob(canonicalJobId: string) {
  return prisma.savedJob.delete({
    where: {
      userId_canonicalJobId: {
        userId: DEMO_USER_ID,
        canonicalJobId,
      },
    },
  });
}
