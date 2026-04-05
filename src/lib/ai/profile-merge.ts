/**
 * Merge AI-extracted resume data into the user's profile.
 *
 * Strategy: fill-empty — only populate fields that are currently null/empty.
 * Structured arrays (experiences, educations, projects, skills) are APPENDED
 * to existing data, not replaced, with basic dedup by key fields.
 */
import { prisma } from "@/lib/db";
import { requireCurrentProfileId } from "@/lib/current-user";
import type { ParsedResumeData } from "./resume-parser";
import type { Prisma } from "@/generated/prisma/client";
import {
  parseSkills,
  parseExperiences,
  parseEducations,
  parseProjects,
} from "@/types/profile";
import type {
  ProfileExperience,
  ProfileEducation,
  ProfileProject,
} from "@/types/profile";

export type MergeResult = {
  fieldsUpdated: string[];
  experiencesAdded: number;
  educationsAdded: number;
  projectsAdded: number;
  skillsAdded: number;
};

/**
 * Merge parsed resume data into the user profile.
 * Returns a summary of what was changed.
 */
export async function mergeIntoProfile(
  data: ParsedResumeData
): Promise<MergeResult> {
  const userId = await requireCurrentProfileId();
  const profile = await prisma.userProfile.findUnique({
    where: { id: userId },
  });

  if (!profile) throw new Error("Profile not found");

  const updates: Record<string, unknown> = {};
  const fieldsUpdated: string[] = [];

  // ── Scalar fields: only fill if currently empty ──
  const scalarMap: Array<[string, keyof typeof profile, string | null]> = [
    ["name", "name", data.name],
    ["email", "email", data.email],
    ["phone", "phone", data.phone],
    ["location", "location", data.location],
    ["headline", "headline", data.headline],
    ["summary", "summary", data.summary],
    ["linkedinUrl", "linkedinUrl", data.linkedinUrl],
    ["githubUrl", "githubUrl", data.githubUrl],
    ["portfolioUrl", "portfolioUrl", data.portfolioUrl],
  ];

  for (const [label, key, newVal] of scalarMap) {
    const current = profile[key];
    if ((!current || (typeof current === "string" && !current.trim())) && newVal) {
      updates[key] = newVal;
      fieldsUpdated.push(label);
    }
  }

  // ── Skills: append new ones ──
  const existingSkills = new Set(
    parseSkills(profile.skillsJson).map((s) => s.toLowerCase())
  );
  const newSkills = data.skills.filter(
    (s) => !existingSkills.has(s.toLowerCase())
  );
  if (newSkills.length > 0) {
    const merged = [...parseSkills(profile.skillsJson), ...newSkills];
    updates.skillsJson = merged as unknown as Prisma.InputJsonValue;
  }

  // ── Experiences: append non-duplicate ──
  const existingExp = parseExperiences(profile.experiencesJson);
  const newExp = data.experiences.filter(
    (e) =>
      !existingExp.some(
        (x) =>
          x.title.toLowerCase() === e.title.toLowerCase() &&
          x.company.toLowerCase() === e.company.toLowerCase()
      )
  );
  if (newExp.length > 0) {
    const merged: ProfileExperience[] = [...existingExp, ...newExp];
    updates.experiencesJson = merged as unknown as Prisma.InputJsonValue;
  }

  // ── Educations: append non-duplicate ──
  const existingEdu = parseEducations(profile.educationsJson);
  const newEdu = data.educations.filter(
    (e) =>
      !existingEdu.some(
        (x) => x.school.toLowerCase() === e.school.toLowerCase() &&
               x.degree.toLowerCase() === e.degree.toLowerCase()
      )
  );
  if (newEdu.length > 0) {
    const merged: ProfileEducation[] = [...existingEdu, ...newEdu];
    updates.educationsJson = merged as unknown as Prisma.InputJsonValue;
  }

  // ── Projects: append non-duplicate ──
  const existingProj = parseProjects(profile.projectsJson);
  const newProj = data.projects.filter(
    (p) =>
      !existingProj.some(
        (x) => x.name.toLowerCase() === p.name.toLowerCase()
      )
  );
  if (newProj.length > 0) {
    const merged: ProfileProject[] = [...existingProj, ...newProj];
    updates.projectsJson = merged as unknown as Prisma.InputJsonValue;
  }

  // ── Apply updates ──
  if (Object.keys(updates).length > 0) {
    await prisma.userProfile.update({
      where: { id: userId },
      data: updates,
    });
  }

  return {
    fieldsUpdated,
    experiencesAdded: newExp.length,
    educationsAdded: newEdu.length,
    projectsAdded: newProj.length,
    skillsAdded: newSkills.length,
  };
}
