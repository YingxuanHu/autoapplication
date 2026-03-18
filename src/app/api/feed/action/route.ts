import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { FeedActionType } from "@/generated/prisma";

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { jobId, action, score } = body as {
      jobId: string;
      action: FeedActionType;
      score?: number;
    };

    if (!jobId || !action) {
      return NextResponse.json(
        { error: "jobId and action are required" },
        { status: 400 }
      );
    }

    const feedAction = await prisma.feedAction.create({
      data: {
        userId: session.user.id,
        jobId,
        action,
        score,
      },
    });

    if (action === "SAVE") {
      await prisma.savedJob.create({
        data: {
          userId: session.user.id,
          jobId,
        },
      });
    }

    if (action === "APPLY") {
      await prisma.application.create({
        data: {
          userId: session.user.id,
          jobId,
          status: "PREPARED",
        },
      });
    }

    return NextResponse.json(feedAction, { status: 201 });
  } catch (error) {
    console.error("Failed to record feed action:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
