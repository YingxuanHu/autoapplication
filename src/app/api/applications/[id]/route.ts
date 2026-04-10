import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api-utils";
import { UnauthorizedError } from "@/lib/current-user";
import { deleteTrackedApplication } from "@/lib/queries/tracker";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const deleted = await deleteTrackedApplication({ applicationId: id });

    revalidatePath("/applications");
    revalidatePath("/applications/history");
    revalidatePath("/dashboard");
    revalidatePath("/notifications");
    if (deleted.canonicalJobId) {
      revalidatePath("/jobs");
      revalidatePath(`/jobs/${deleted.canonicalJobId}`);
    }

    return successResponse({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }

    console.error("DELETE /api/applications/[id] error:", error);
    return errorResponse("Failed to delete application", 500);
  }
}
