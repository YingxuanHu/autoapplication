import { z } from "zod/v4";
import { ApplicationStatus } from "@/generated/prisma";

export const createApplicationSchema = z.object({
  jobId: z.string().min(1),
  resumeId: z.string().optional(),
  coverLetter: z.string().optional(),
  portfolioUrls: z.array(z.url()).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const updateApplicationSchema = z.object({
  status: z.enum(ApplicationStatus),
  notes: z.string().optional(),
});

export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
