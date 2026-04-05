/**
 * Shared helpers to build JobContext and ProfileContext for AI modules.
 * Pulls from the DB so API routes stay thin.
 */
import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import { parseSkills, parseExperiences, parseEducations } from "@/types/profile";
import type { JobContext, ProfileContext } from "./job-fit";

export async function buildJobContext(jobId: string): Promise<JobContext | null> {
  const job = await prisma.jobCanonical.findUnique({
    where: { id: jobId },
    select: {
      title: true,
      company: true,
      location: true,
      workMode: true,
      experienceLevel: true,
      roleFamily: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      description: true,
    },
  });

  if (!job) return null;

  return {
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workMode,
    experienceLevel: job.experienceLevel,
    roleFamily: job.roleFamily,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    description: job.description,
  };
}

export async function buildProfileContext(): Promise<ProfileContext | null> {
  const profile = await prisma.userProfile.findUnique({
    where: { id: DEMO_USER_ID },
    select: {
      headline: true,
      summary: true,
      skillsJson: true,
      experiencesJson: true,
      educationsJson: true,
      experienceLevel: true,
      workAuthorization: true,
      preferredWorkMode: true,
    },
  });

  if (!profile) return null;

  return {
    headline: profile.headline,
    summary: profile.summary,
    skills: parseSkills(profile.skillsJson),
    experiences: parseExperiences(profile.experiencesJson),
    educations: parseEducations(profile.educationsJson),
    experienceLevel: profile.experienceLevel,
    workAuthorization: profile.workAuthorization,
    preferredWorkMode: profile.preferredWorkMode,
  };
}
