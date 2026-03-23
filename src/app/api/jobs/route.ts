import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureDiscoveryWorkerStarted } from "@/lib/discovery/bootstrap";
import type { WorkMode } from "@/generated/prisma";
import type { Prisma } from "@/generated/prisma";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    ensureDiscoveryWorkerStarted();

    const searchParams = request.nextUrl.searchParams;
    const q = searchParams.get("q");
    const location = searchParams.get("location");
    const workMode = searchParams.get("workMode") as WorkMode | null;
    const salaryMin = searchParams.get("salaryMin");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("limit") || "20", 10))
    );

    const where: Prisma.JobWhereInput = {
      isActive: true,
    };

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { company: { contains: q, mode: "insensitive" } },
      ];
    }

    if (location) {
      where.location = { contains: location, mode: "insensitive" };
    }

    if (workMode) {
      where.workMode = { equals: workMode };
    }

    if (salaryMin) {
      where.salaryMin = { gte: parseInt(salaryMin, 10) };
    }

    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy:
          q || location || workMode || salaryMin
            ? { createdAt: "desc" }
            : [
                { stemScore: "desc" },
                { sourceTrust: "desc" },
                { createdAt: "desc" },
              ],
        skip,
        take: limit,
      }),
      prisma.job.count({ where }),
    ]);

    return NextResponse.json({
      jobs,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Failed to list jobs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
