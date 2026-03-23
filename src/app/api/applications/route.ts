import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createApplicationSchema } from "@/lib/validators/application";
import type { ApplicationStatus, Prisma } from "@/generated/prisma";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get("status") as ApplicationStatus | null;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("limit") || "20", 10))
    );
    const skip = (page - 1) * limit;

    const where = {
      userId: session.user.id,
      ...(status ? { status } : {}),
    };

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: { job: true, resume: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.application.count({ where }),
    ]);

    return NextResponse.json({
      applications,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Failed to list applications:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const result = createApplicationSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten() },
        { status: 400 }
      );
    }

    const job = await prisma.job.findUnique({
      where: { id: result.data.jobId },
      select: { id: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (result.data.resumeId) {
      const resume = await prisma.resume.findFirst({
        where: {
          id: result.data.resumeId,
          userId: session.user.id,
        },
      });

      if (!resume) {
        return NextResponse.json(
          { error: "Resume not found" },
          { status: 400 }
        );
      }
    }

    const applicationUpdateData: Prisma.ApplicationUncheckedUpdateInput = {
      ...(result.data.resumeId ? { resumeId: result.data.resumeId } : {}),
      ...(result.data.coverLetter !== undefined
        ? { coverLetter: result.data.coverLetter }
        : {}),
      ...(result.data.portfolioUrls
        ? { portfolioUrls: result.data.portfolioUrls }
        : {}),
      ...(result.data.answers !== undefined
        ? {
            answers: result.data.answers as Prisma.InputJsonValue,
          }
        : {}),
    };

    const applicationCreateData: Prisma.ApplicationUncheckedCreateInput = {
      userId: session.user.id,
      jobId: result.data.jobId,
      resumeId: result.data.resumeId,
      coverLetter: result.data.coverLetter,
      portfolioUrls: result.data.portfolioUrls ?? [],
      answers: result.data.answers as Prisma.InputJsonValue | undefined,
    };

    const application = await prisma.application.upsert({
      where: {
        userId_jobId: {
          userId: session.user.id,
          jobId: result.data.jobId,
        },
      },
      update: applicationUpdateData,
      create: applicationCreateData,
      include: { job: true, resume: true },
    });

    return NextResponse.json(application);
  } catch (error) {
    console.error("Failed to create application:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
