import { type NextRequest } from "next/server";
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
    const body = (await request.json()) as { intent?: "prepare" | "submit" };

    if (body.intent === "prepare") {
      const result = await prepareApplicationReview(id);
      return successResponse(result, 201);
    }

    if (body.intent === "submit") {
      const result = await submitApplicationReview(id);
      return successResponse(result, 201);
    }

    return errorResponse("Invalid application intent", 400);
  } catch (error) {
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
    const body = (await request.json()) as {
      intent?: "confirm" | "fail" | "withdraw";
    };

    const statusMap = {
      confirm: "CONFIRMED",
      fail: "FAILED",
      withdraw: "WITHDRAWN",
    } as const;

    const intent = body.intent;
    if (!intent || !(intent in statusMap)) {
      return errorResponse("Invalid intent — expected confirm, fail, or withdraw", 400);
    }

    const result = await updateApplicationSubmissionStatus(id, statusMap[intent]);
    return successResponse(result);
  } catch (error) {
    console.error("PATCH /api/jobs/[id]/apply error:", error);
    return errorResponse("Failed to update submission status", 500);
  }
}
