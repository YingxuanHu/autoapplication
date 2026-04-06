import { type NextRequest } from "next/server";

import { UnauthorizedError } from "@/lib/current-user";
import { errorResponse, successResponse } from "@/lib/api-utils";
import { upsertTrackedApplicationFromJob } from "@/lib/queries/tracker";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tracked = await upsertTrackedApplicationFromJob({
      canonicalJobId: id,
      status: "PREPARING",
    });

    return successResponse(
      {
        applicationId: tracked.applicationId,
        created: tracked.created,
        status: tracked.status,
        workspaceUrl: `/applications/${tracked.applicationId}`,
      },
      tracked.created ? 201 : 200
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }

    console.error("POST /api/jobs/[id]/prepare error:", error);
    return errorResponse("Failed to prepare this job in applications", 500);
  }
}
