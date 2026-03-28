import { getResumes } from "@/lib/queries/profile";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function GET() {
  try {
    const resumes = await getResumes();
    return successResponse(resumes);
  } catch (error) {
    console.error("GET /api/profile/resumes error:", error);
    return errorResponse("Failed to fetch resumes", 500);
  }
}
