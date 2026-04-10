import { type NextRequest } from "next/server";
import { UnauthorizedError } from "@/lib/current-user";
import {
  prepareApplicationReview,
  submitApplicationReview,
  updateApplicationSubmissionStatus,
} from "@/lib/queries/applications";
import { errorResponse, successResponse } from "@/lib/api-utils";

/** POST — prepare or submit */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const intent = typeof body?.intent === "string" ? body.intent : null;

    if (intent === "prepare") {
      const result = await prepareApplicationReview(id);
      return successResponse(result, 201);
    }

    if (intent === "submit") {
      const result = await submitApplicationReview(id);
      return successResponse(result, 201);
    }

    return errorResponse("Invalid application intent", 400);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("POST /api/jobs/[id]/apply error:", error);
    return errorResponse("Failed to update application review", 500);
  }
}

/** PATCH — update submission status after it has been recorded */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const patchIntent = typeof body?.intent === "string" ? body.intent : null;

    const statusMap = {
      confirm: "CONFIRMED",
      fail: "FAILED",
      withdraw: "WITHDRAWN",
    } as const;

    if (!patchIntent || !(patchIntent in statusMap)) {
      return errorResponse("Invalid intent — expected confirm, fail, or withdraw", 400);
    }

    const result = await updateApplicationSubmissionStatus(id, statusMap[patchIntent as keyof typeof statusMap]);
    return successResponse(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("Unauthorized", 401);
    }
    console.error("PATCH /api/jobs/[id]/apply error:", error);
    return errorResponse("Failed to update submission status", 500);
  }
}
