import { successResponse, errorResponse } from "@/lib/api-utils";
import { buildJobContext, buildProfileContext } from "@/lib/ai/context-builders";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!process.env.ANTHROPIC_API_KEY) {
      return errorResponse("ANTHROPIC_API_KEY not configured", 503);
    }

    const [jobCtx, profileCtx] = await Promise.all([
      buildJobContext(id),
      buildProfileContext(),
    ]);

    if (!jobCtx) return errorResponse("Job not found", 404);
    if (!profileCtx) return errorResponse("Profile not found", 404);

    // Lazy-import to avoid bundling Anthropic SDK into other routes
    const { generateCoverLetter } = await import("@/lib/ai/cover-letter");
    const result = await generateCoverLetter(jobCtx, profileCtx);

    return successResponse(result);
  } catch (error) {
    console.error("POST /api/jobs/[id]/ai/cover-letter error:", error);
    const message = error instanceof Error ? error.message : "Cover letter generation failed";
    return errorResponse(message, 500);
  }
}
