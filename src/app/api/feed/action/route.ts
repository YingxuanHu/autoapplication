import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";

const feedActionSchema = z.object({
  jobId: z.string().min(1),
  action: z.enum(["APPLY", "PASS", "SAVE"]),
  score: z.number().optional(),
  resumeId: z.string().min(1).optional(),
  coverLetter: z.string().optional(),
  portfolioUrls: z.array(z.url()).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await request.json();
    const result = feedActionSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten() },
        { status: 400 }
      );
    }

    const input = result.data;

    const job = await prisma.job.findUnique({
      where: { id: input.jobId },
      select: { id: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (input.resumeId) {
      const resume = await prisma.resume.findFirst({
        where: {
          id: input.resumeId,
          userId,
        },
      });

      if (!resume) {
        return NextResponse.json(
          { error: "Resume not found" },
          { status: 400 }
        );
      }
    }

    const response = await prisma.$transaction(async (tx) => {
      const feedAction = await tx.feedAction.upsert({
        where: {
          userId_jobId: {
            userId,
            jobId: input.jobId,
          },
        },
        update: {
          action: input.action,
          score: input.score,
        },
        create: {
          userId,
          jobId: input.jobId,
          action: input.action,
          score: input.score,
        },
      });

      let application = null;

      if (input.action === "SAVE") {
        await tx.savedJob.upsert({
          where: {
            userId_jobId: {
              userId,
              jobId: input.jobId,
            },
          },
          update: {},
          create: {
            userId,
            jobId: input.jobId,
          },
        });
      }

      if (input.action === "APPLY") {
        const applicationUpdateData: Prisma.ApplicationUncheckedUpdateInput = {
          status: "PREPARED",
          ...(input.resumeId ? { resumeId: input.resumeId } : {}),
          ...(input.coverLetter !== undefined
            ? { coverLetter: input.coverLetter }
            : {}),
          ...(input.portfolioUrls ? { portfolioUrls: input.portfolioUrls } : {}),
          ...(input.answers !== undefined
            ? {
                answers: input.answers as Prisma.InputJsonValue,
              }
            : {}),
        };

        const applicationCreateData: Prisma.ApplicationUncheckedCreateInput = {
          userId,
          jobId: input.jobId,
          status: "PREPARED",
          resumeId: input.resumeId,
          coverLetter: input.coverLetter,
          portfolioUrls: input.portfolioUrls ?? [],
          answers: input.answers as Prisma.InputJsonValue | undefined,
        };

        application = await tx.application.upsert({
          where: {
            userId_jobId: {
              userId,
              jobId: input.jobId,
            },
          },
          update: applicationUpdateData,
          create: applicationCreateData,
        });
      }

      return { feedAction, application };
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to record feed action:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
