import { z } from "zod/v4";
import { WorkMode, JobSource } from "@/generated/prisma";

export const jobSearchSchema = z.object({
  query: z.string().min(1),
  location: z.string().optional(),
  workMode: z.enum(WorkMode).optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
});

export type JobSearchInput = z.infer<typeof jobSearchSchema>;

export const jobSyncSchema = z.object({
  query: z.string().optional(),
  location: z.string().optional(),
  workMode: z.enum(WorkMode).optional(),
  sources: z.array(z.enum(JobSource)).optional(),
});

export type JobSyncInput = z.infer<typeof jobSyncSchema>;
