import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";
import type { Prisma } from "@/generated/prisma/client";

export async function getProfile() {
  const userId = await requireCurrentProfileId();
  return prisma.userProfile.findUnique({
    where: { id: userId },
    include: {
      resumeVariants: { orderBy: { createdAt: "desc" } },
      preferences: true,
    },
  });
}

export async function updateProfile(data: {
  name?: string;
  email?: string;
  phone?: string | null;
  location?: string | null;
  headline?: string | null;
  summary?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  portfolioUrl?: string | null;
  workAuthorization?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  preferredWorkMode?: "REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE";
  experienceLevel?: "ENTRY" | "MID" | "SENIOR" | "LEAD" | "EXECUTIVE";
  automationMode?:
    | "DISCOVERY_ONLY"
    | "ASSIST"
    | "REVIEW_BEFORE_SUBMIT"
    | "STRICT_AUTO_APPLY";
  skillsJson?: Prisma.InputJsonValue;
  experiencesJson?: Prisma.InputJsonValue;
  educationsJson?: Prisma.InputJsonValue;
  projectsJson?: Prisma.InputJsonValue;
}) {
  const userId = await requireCurrentProfileId();
  return prisma.userProfile.update({
    where: { id: userId },
    data,
  });
}

export async function getResumes() {
  const userId = await requireCurrentProfileId();
  return prisma.resumeVariant.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}
