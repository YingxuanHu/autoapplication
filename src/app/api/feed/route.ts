import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scoreJobs } from "@/lib/scoring/job-scorer";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(
      50,
      Math.max(1, parseInt(searchParams.get("limit") || "10", 10))
    );

    const profile = await prisma.userProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!profile) {
      return NextResponse.json(
        { error: "Profile not found. Please create a profile first." },
        { status: 404 }
      );
    }

    // Get job IDs the user has already acted on
    const actedJobIds = await prisma.feedAction.findMany({
      where: { userId: session.user.id },
      select: { jobId: true },
    });
    const actedIds = actedJobIds.map((a) => a.jobId);

    // Build where clause
    const jobs = await prisma.job.findMany({
      where: {
        isActive: true,
        id: actedIds.length > 0 ? { notIn: actedIds } : undefined,
        company:
          profile.excludeCompanies.length > 0
            ? { notIn: profile.excludeCompanies }
            : undefined,
      },
      take: 50,
      orderBy: { createdAt: "desc" },
    });

    const scored = await scoreJobs(jobs, profile);

    const topJobs = scored.slice(0, limit);

    return NextResponse.json(topJobs);
  } catch (error) {
    console.error("Failed to get feed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
