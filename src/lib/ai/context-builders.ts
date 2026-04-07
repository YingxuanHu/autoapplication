/**
 * Shared helpers to build JobContext and ProfileContext for AI modules.
 * Pulls from the DB so API routes stay thin.
 */
import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";
import {
  normalizeContact,
  normalizeEducations,
  normalizeExperiences,
  normalizeProjects,
  normalizeSkills,
} from "@/lib/profile";
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
  const userId = await requireCurrentProfileId();
  const profile = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: {
      headline: true,
      summary: true,
      contactJson: true,
      skillsJson: true,
      skillsText: true,
      experiencesJson: true,
      experienceText: true,
      educationsJson: true,
      educationText: true,
      projectsJson: true,
      projectsText: true,
      experienceLevel: true,
      workAuthorization: true,
      preferredWorkMode: true,
    },
  });

  if (!profile) return null;
  const contact = normalizeContact(profile.contactJson);
  const skills = normalizeSkills(profile.skillsJson).map((entry) => entry.name);
  const experiences = normalizeExperiences(profile.experiencesJson);
  const educations = normalizeEducations(profile.educationsJson);
  const projects = normalizeProjects(profile.projectsJson);

  return {
    headline: profile.headline,
    summary: profile.summary,
    fullName: contact.fullName || null,
    location: contact.location || null,
    linkedInUrl: contact.linkedInUrl || null,
    githubUrl: contact.githubUrl || null,
    portfolioUrl: contact.portfolioUrl || null,
    skills,
    skillsText: profile.skillsText ?? null,
    experiences,
    experienceText: profile.experienceText ?? null,
    educations,
    educationText: profile.educationText ?? null,
    projects,
    projectsText: profile.projectsText ?? null,
    experienceLevel: profile.experienceLevel,
    workAuthorization: profile.workAuthorization,
    preferredWorkMode: profile.preferredWorkMode,
  };
}
