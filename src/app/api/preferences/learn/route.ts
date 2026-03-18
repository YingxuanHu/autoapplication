import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const recentActions = await prisma.feedAction.findMany({
      where: { userId: session.user.id },
      include: { job: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    if (recentActions.length === 0) {
      return NextResponse.json(
        { error: "Not enough data to learn from" },
        { status: 400 }
      );
    }

    // Analyze patterns
    const patterns: {
      workMode: Record<string, { apply: number; pass: number }>;
      salaryRanges: Record<string, { apply: number; pass: number }>;
      companies: Record<string, { apply: number; pass: number }>;
    } = {
      workMode: {},
      salaryRanges: {},
      companies: {},
    };

    for (const feedAction of recentActions) {
      const job = feedAction.job;
      const isApply = feedAction.action === "APPLY" || feedAction.action === "SAVE";
      const isPass = feedAction.action === "PASS";

      // Work mode patterns
      if (job.workMode) {
        if (!patterns.workMode[job.workMode]) {
          patterns.workMode[job.workMode] = { apply: 0, pass: 0 };
        }
        if (isApply) patterns.workMode[job.workMode].apply++;
        if (isPass) patterns.workMode[job.workMode].pass++;
      }

      // Salary range patterns
      if (job.salaryMin != null) {
        const range =
          job.salaryMin < 50000
            ? "under_50k"
            : job.salaryMin < 100000
              ? "50k_100k"
              : job.salaryMin < 150000
                ? "100k_150k"
                : "over_150k";
        if (!patterns.salaryRanges[range]) {
          patterns.salaryRanges[range] = { apply: 0, pass: 0 };
        }
        if (isApply) patterns.salaryRanges[range].apply++;
        if (isPass) patterns.salaryRanges[range].pass++;
      }

      // Company patterns
      if (job.company) {
        if (!patterns.companies[job.company]) {
          patterns.companies[job.company] = { apply: 0, pass: 0 };
        }
        if (isApply) patterns.companies[job.company].apply++;
        if (isPass) patterns.companies[job.company].pass++;
      }
    }

    // Generate weight adjustments
    const weights: Record<string, number> = {};

    for (const [mode, counts] of Object.entries(patterns.workMode)) {
      const total = counts.apply + counts.pass;
      if (total > 0) {
        weights[`workMode_${mode}`] = counts.apply / total;
      }
    }

    for (const [range, counts] of Object.entries(patterns.salaryRanges)) {
      const total = counts.apply + counts.pass;
      if (total > 0) {
        weights[`salary_${range}`] = counts.apply / total;
      }
    }

    for (const [company, counts] of Object.entries(patterns.companies)) {
      const total = counts.apply + counts.pass;
      if (total >= 2) {
        weights[`company_${company}`] = counts.apply / total;
      }
    }

    await prisma.userProfile.update({
      where: { userId: session.user.id },
      data: { learnedWeights: weights },
    });

    return NextResponse.json({
      updated: true,
      patterns: {
        workMode: patterns.workMode,
        salaryRanges: patterns.salaryRanges,
        totalActions: recentActions.length,
        weightsGenerated: Object.keys(weights).length,
      },
    });
  } catch (error) {
    console.error("Failed to learn preferences:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
