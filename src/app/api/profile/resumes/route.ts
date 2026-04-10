import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api-utils";
import { requireCurrentUserProfile, UnauthorizedError } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { importUploadedResumeForProfile } from "@/lib/profile-resume-service";
import { getStorageReadiness } from "@/lib/storage";

function revalidateProfileViews() {
  revalidatePath("/profile");
  revalidatePath("/applications");
  revalidatePath("/applications/history");
  revalidatePath("/dashboard");
}

export async function GET() {
  try {
    const user = await requireCurrentUserProfile();
    const resumes = await prisma.document.findMany({
      where: {
        userId: user.id,
        type: "RESUME",
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        originalFileName: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
        isPrimary: true,
      },
    });

    return successResponse(resumes);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    return errorResponse("Failed to fetch resumes", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCurrentUserProfile();
    const storageReadiness = getStorageReadiness();
    if (!storageReadiness.configured) {
      return errorResponse(
        `Storage is not configured. Missing: ${storageReadiness.missingKeys.join(", ")}.`,
        500
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return errorResponse("Choose a supported resume file.", 400);
    }

    const result = await importUploadedResumeForProfile({
      user,
      file,
      titleRaw: String(formData.get("title") ?? "").trim(),
      makePrimary: formData.get("makePrimary") === "on",
    });

    revalidateProfileViews();
    return successResponse({ message: result.message }, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    return errorResponse(
      error instanceof Error ? error.message : "Resume upload failed.",
      400
    );
  }
}
