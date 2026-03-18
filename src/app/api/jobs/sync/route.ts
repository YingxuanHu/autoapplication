import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncJobsToDb } from "@/lib/job-sources/aggregator";
import { jobSyncSchema } from "@/lib/validators/job";

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const result = jobSyncSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten() },
        { status: 400 }
      );
    }

    let query = result.data.query;

    if (!query) {
      const profile = await prisma.userProfile.findUnique({
        where: { userId: session.user.id },
      });
      query = profile?.jobTitles?.join(", ") || "";
    }

    if (!query) {
      return NextResponse.json(
        { error: "No query provided and no job titles in profile" },
        { status: 400 }
      );
    }

    const count = await syncJobsToDb(
      session.user.id,
      { query },
      result.data.sources,
    );

    return NextResponse.json({ synced: count });
  } catch (error) {
    console.error("Failed to sync jobs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
