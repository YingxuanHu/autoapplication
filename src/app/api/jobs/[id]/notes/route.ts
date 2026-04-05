import { successResponse, errorResponse } from "@/lib/api-utils";
import { prisma } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";

/**
 * PATCH /api/jobs/[id]/notes
 * Body: { notes: string }
 *
 * Upserts a personal note on the job's ApplicationPackage.
 * Creates a minimal package record if one doesn't exist yet.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    const body = await request.json().catch(() => null);
    const notes: string = typeof body?.notes === "string" ? body.notes.slice(0, 4000) : "";

    // Find existing package or create a stub
    const existing = await prisma.applicationPackage.findFirst({
      where: { canonicalJobId: jobId, userId: DEMO_USER_ID },
      orderBy: { updatedAt: "desc" },
    });

    if (existing) {
      await prisma.applicationPackage.update({
        where: { id: existing.id },
        data: { userNotes: notes || null },
      });
    } else {
      // Need a resumeVariant to create a package — use the default one
      const defaultVariant = await prisma.resumeVariant.findFirst({
        where: { userId: DEMO_USER_ID },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      });

      if (!defaultVariant) {
        // No resume variant yet — store nothing, return success
        return successResponse({ saved: false, reason: "no_resume_variant" });
      }

      await prisma.applicationPackage.create({
        data: {
          userId: DEMO_USER_ID,
          canonicalJobId: jobId,
          resumeVariantId: defaultVariant.id,
          userNotes: notes || null,
        },
      });
    }

    return successResponse({ saved: true });
  } catch (error) {
    console.error("PATCH /api/jobs/[id]/notes error:", error);
    return errorResponse("Failed to save notes", 500);
  }
}
