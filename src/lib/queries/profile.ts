import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";

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
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  workAuthorization?: string;
  salaryMin?: number;
  salaryMax?: number;
  preferredWorkMode?: "REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE";
  experienceLevel?: "ENTRY" | "MID" | "SENIOR" | "LEAD" | "EXECUTIVE";
  automationMode?:
    | "DISCOVERY_ONLY"
    | "ASSIST"
    | "REVIEW_BEFORE_SUBMIT"
    | "STRICT_AUTO_APPLY";
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
