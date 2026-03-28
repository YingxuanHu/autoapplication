import { type NextRequest } from "next/server";
import { getProfile, updateProfile } from "@/lib/queries/profile";
import { successResponse, errorResponse } from "@/lib/api-utils";

export async function GET() {
  try {
    const profile = await getProfile();
    if (!profile) return errorResponse("Profile not found", 404);
    return successResponse(profile);
  } catch (error) {
    console.error("GET /api/profile error:", error);
    return errorResponse("Failed to fetch profile", 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const updated = await updateProfile(body);
    return successResponse(updated);
  } catch (error) {
    console.error("PATCH /api/profile error:", error);
    return errorResponse("Failed to update profile", 500);
  }
}
