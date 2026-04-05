import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import type { Prisma } from "@/generated/prisma/client";

export async function getProfile() {
  return prisma.userProfile.findUnique({
    where: { id: DEMO_USER_ID },
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
  return prisma.userProfile.update({
    where: { id: DEMO_USER_ID },
    data,
  });
}

export async function getResumes() {
  return prisma.resumeVariant.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: { createdAt: "desc" },
  });
}
