import { type NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-utils";
import { runScheduledIngestion } from "@/lib/ingestion/scheduler";

export async function GET(request: NextRequest) {
  return handleScheduledIngestionRequest(request);
}

export async function POST(request: NextRequest) {
  return handleScheduledIngestionRequest(request);
}

async function handleScheduledIngestionRequest(request: NextRequest) {
  if (!isAuthorizedRequest(request)) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const force = parseBooleanFlag(request.nextUrl.searchParams.get("force"));
    const connectorKeys = parseConnectorKeys(
      request.nextUrl.searchParams.get("connectors")
    );

    const result = await runScheduledIngestion({
      force,
      connectorKeys,
      triggerLabel: "api.ingestion.schedule",
    });

    return successResponse(result);
  } catch (error) {
    console.error("Scheduled ingestion route failed:", error);
    return errorResponse("Failed to execute scheduled ingestion", 500);
  }
}

function isAuthorizedRequest(request: NextRequest) {
  const configuredSecret = process.env.INGESTION_CRON_SECRET;
  if (!configuredSecret) {
    return (
      process.env.NODE_ENV !== "production" ||
      ["localhost", "127.0.0.1", "::1"].includes(request.nextUrl.hostname)
    );
  }

  const bearerToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const directToken = request.headers.get("x-ingestion-secret")?.trim();

  return bearerToken === configuredSecret || directToken === configuredSecret;
}

function parseBooleanFlag(value: string | null) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseConnectorKeys(value: string | null) {
  if (!value) return undefined;

  const connectorKeys = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  return connectorKeys.length > 0 ? connectorKeys : undefined;
}
