import { successResponse, errorResponse } from "@/lib/api-utils";
import { getDocument } from "@/lib/queries/documents";
import { prisma } from "@/lib/db";

/**
 * POST /api/profile/documents/[id]/parse
 *
 * Parse a document's extracted text with AI and merge results into profile.
 * AI modules are imported lazily to avoid bloating the webpack bundle for
 * other routes in this route group.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!process.env.ANTHROPIC_API_KEY) {
      return errorResponse(
        "AI features are not configured. Set ANTHROPIC_API_KEY in .env to enable resume parsing.",
        503
      );
    }

    const doc = await getDocument(id);
    if (!doc) {
      return errorResponse("Document not found", 404);
    }

    if (!doc.extractedText) {
      return errorResponse(
        "No extracted text available for this document. The file may not have been processed correctly.",
        422
      );
    }

    // Lazy-import AI modules to keep the Anthropic SDK out of the shared bundle
    const { parseResumeText } = await import("@/lib/ai/resume-parser");
    const { mergeIntoProfile } = await import("@/lib/ai/profile-merge");

    // Parse with AI
    const parsed = await parseResumeText(doc.extractedText);

    // Merge into profile
    const mergeResult = await mergeIntoProfile(parsed);

    // Update document to record that it was parsed
    await prisma.document.update({
      where: { id },
      data: { extractedAt: new Date() },
    });

    return successResponse({
      parsed,
      merge: mergeResult,
    });
  } catch (error) {
    console.error("POST /api/profile/documents/[id]/parse error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to parse document";
    return errorResponse(message, 500);
  }
}
