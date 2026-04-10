import { errorResponse, successResponse } from "@/lib/api-utils";
import { checkCustomReminders, runDeadlineReminders } from "@/lib/reminders";

function isAuthorized(request: Request) {
  const secret =
    process.env.TRACKER_CRON_SECRET?.trim() ||
    process.env.JOB_SECRET?.trim() ||
    process.env.INGESTION_CRON_SECRET?.trim();

  if (!secret) {
    const url = new URL(request.url);
    return (
      process.env.NODE_ENV !== "production" ||
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  }

  const directToken = request.headers.get("x-tracker-secret")?.trim();
  const authToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  return directToken === secret || authToken === secret;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const [deadlineResult] = await Promise.all([
      runDeadlineReminders(),
      checkCustomReminders(),
    ]);

    return successResponse({
      ok: true,
      ...deadlineResult,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Tracker reminder route failed:", error);
    return errorResponse("Failed to run tracker reminders", 500);
  }
}
