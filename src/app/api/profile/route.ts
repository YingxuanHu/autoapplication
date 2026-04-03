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

const ALLOWED_PROFILE_FIELDS = new Set([
  "name",
  "email",
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
  "workAuthorization",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "preferredWorkMode",
  "experienceLevel",
  "automationMode",
]);

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Request body must be a JSON object", 400);
    }

    // Strip unknown fields to prevent unexpected data from reaching Prisma
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_PROFILE_FIELDS.has(key)) {
        sanitized[key] = value;
      }
    }

    if (Object.keys(sanitized).length === 0) {
      return errorResponse("No valid fields provided", 400);
    }

    const updated = await updateProfile(sanitized);
    return successResponse(updated);
  } catch (error) {
    console.error("PATCH /api/profile error:", error);
    return errorResponse("Failed to update profile", 500);
  }
}
