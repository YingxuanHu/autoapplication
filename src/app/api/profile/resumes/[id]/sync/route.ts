import { revalidatePath } from "next/cache";

import { errorResponse, successResponse } from "@/lib/api-utils";
import { requireCurrentUserProfile, UnauthorizedError } from "@/lib/current-user";
import { syncStoredResumeForProfile } from "@/lib/profile-resume-service";

function revalidateProfileViews() {
  revalidatePath("/profile");
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireCurrentUserProfile();
    const { id } = await params;

    const result = await syncStoredResumeForProfile({
      user,
      documentId: id,
    });

    revalidateProfileViews();
    return successResponse({ message: result.message });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    return errorResponse(
      error instanceof Error ? error.message : "Resume extraction failed.",
      400
    );
  }
}
