import { type NextRequest } from "next/server";
import { runAutoApply } from "@/lib/automation/engine";
import { resolveATSFiller } from "@/lib/automation/fillers";
import { errorResponse, successResponse } from "@/lib/api-utils";
import { prepareAutoApplyPackage } from "@/lib/queries/applications";
import { UnauthorizedError } from "@/lib/current-user";
import type { AutomationRunMode } from "@/lib/automation/types";

const VALID_MODES: AutomationRunMode[] = ["dry_run", "fill_only", "fill_and_submit"];

/**
 * POST /api/jobs/[id]/auto-apply
 *
 * Trigger automation for a single job.
 *
 * Body (all optional — if `resumeVariantId` is provided, we upsert an
 * ApplicationPackage with the user's selections *before* running the
 * engine so the correct materials are picked up):
 *
 *   {
 *     resumeVariantId?: string;        // from AutoApplyWorkspace picker
 *     coverLetterContent?: string;     // optional cover letter text
 *     answers?: Record<string, string>;// per-job screening question answers
 *     mode?: "dry_run" | "fill_only" | "fill_and_submit";
 *   }
 *
 * If no body is provided, this endpoint still works the legacy way: it
 * runs the engine against whatever package already exists (or none) and
 * returns the filler result.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // ─── Parse body ─────────────────────────────────────────────────
    let mode: AutomationRunMode | undefined;
    let resumeVariantId: string | undefined;
    let coverLetterContent: string | null | undefined;
    let answers: Record<string, string> | undefined;

    try {
      const body = (await request.json()) as {
        mode?: string;
        resumeVariantId?: string;
        coverLetterContent?: string | null;
        answers?: Record<string, string>;
      };

      if (body?.mode && typeof body.mode === "string") {
        if (!VALID_MODES.includes(body.mode as AutomationRunMode)) {
          return errorResponse(
            `Invalid mode: ${body.mode}. Use: ${VALID_MODES.join(", ")}`,
            400
          );
        }
        mode = body.mode as AutomationRunMode;
      }
      if (typeof body?.resumeVariantId === "string" && body.resumeVariantId.length > 0) {
        resumeVariantId = body.resumeVariantId;
      }
      if (typeof body?.coverLetterContent === "string") {
        coverLetterContent = body.coverLetterContent;
      }
      if (body?.answers && typeof body.answers === "object" && !Array.isArray(body.answers)) {
        const entries = Object.entries(body.answers).filter(
          ([, value]) => typeof value === "string"
        ) as Array<[string, string]>;
        answers = Object.fromEntries(entries);
      }
    } catch {
      // No body or invalid JSON — use legacy path.
    }

    // ─── Upsert the ApplicationPackage with the user's chosen materials ─
    // This happens BEFORE runAutoApply so the engine, which reads the
    // package via candidate.packageId, picks up the correct resume.
    if (resumeVariantId) {
      try {
        await prepareAutoApplyPackage(id, {
          resumeVariantId,
          coverLetterContent: coverLetterContent ?? null,
          savedAnswers: answers,
        });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          return errorResponse("Unauthorized", 401);
        }
        const msg = error instanceof Error ? error.message : "Could not prepare package";
        return errorResponse(msg, 400);
      }
    }

    // ─── Run the automation engine ─────────────────────────────────
    const results = await runAutoApply({
      jobId: id,
      mode,
      maxPerRun: 1,
      delayBetweenMs: 0,
      log: () => {}, // Suppress logging in API context
    });

    const result = results[0];
    if (!result) {
      return errorResponse("Job not found or not eligible for automation", 404);
    }

    if (result.error) {
      return successResponse(
        {
          jobId: id,
          status: "error",
          error: result.error,
          atsSupported: resolveATSFiller(result.error) !== null,
        },
        500
      );
    }

    const filler = result.fillerResult!;
    return successResponse({
      jobId: id,
      status: filler.status,
      atsName: filler.atsName,
      mode: mode ?? "auto",
      filledFieldCount: filler.filledFields.length,
      unfillableFieldCount: filler.unfillableFields.length,
      blockers: filler.blockers,
      screenshots: filler.screenshots,
      submittedAt: filler.submittedAt?.toISOString() ?? null,
      notes: filler.notes,
      durationMs: filler.durationMs,
    });
  } catch (error) {
    console.error("POST /api/jobs/[id]/auto-apply error:", error);
    return errorResponse("Automation failed", 500);
  }
}
