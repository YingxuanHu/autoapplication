import { type NextRequest } from "next/server";
import { runAutoApply } from "@/lib/automation/engine";
import { resolveATSFiller } from "@/lib/automation/fillers";
import { errorResponse, successResponse } from "@/lib/api-utils";
import type { AutomationRunMode } from "@/lib/automation/types";

const VALID_MODES: AutomationRunMode[] = ["dry_run", "fill_only", "fill_and_submit"];

/**
 * POST /api/jobs/[id]/auto-apply
 *
 * Trigger automation for a single job.
 *
 * Body: { mode?: "dry_run" | "fill_only" | "fill_and_submit" }
 *
 * Default mode is determined by the job's eligibility + user automation settings.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Parse optional mode from body
    let mode: AutomationRunMode | undefined;
    try {
      const body = await request.json();
      if (body?.mode && typeof body.mode === "string") {
        if (!VALID_MODES.includes(body.mode as AutomationRunMode)) {
          return errorResponse(
            `Invalid mode: ${body.mode}. Use: ${VALID_MODES.join(", ")}`,
            400
          );
        }
        mode = body.mode as AutomationRunMode;
      }
    } catch {
      // No body or invalid JSON — use default mode
    }

    // Run automation for this single job
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
