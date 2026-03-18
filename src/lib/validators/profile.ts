import { z } from "zod/v4";
import { WorkMode, ExperienceLevel } from "@/generated/prisma";

export const updateProfileSchema = z.object({
  jobTitles: z.array(z.string()).optional(),
  jobAreas: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  workModes: z.array(z.enum(WorkMode)).optional(),
  experienceLevel: z.enum(ExperienceLevel).optional(),
  salaryMin: z.number().int().positive().optional(),
  salaryMax: z.number().int().positive().optional(),
  salaryCurrency: z.string().max(3).optional(),
  excludeCompanies: z.array(z.string()).optional(),
  excludeKeywords: z.array(z.string()).optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
