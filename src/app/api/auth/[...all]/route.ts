import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";
import { isPrismaConnectionClosedError, reconnectPrisma, withPrismaConnectionRetry } from "@/lib/db";

const authHandlers = toNextJsHandler(auth);

async function handleAuthRequest(
  handler: (request: Request) => Promise<Response>,
  request: Request
) {
  try {
    return await withPrismaConnectionRetry(() => handler(request));
  } catch (error) {
    if (!isPrismaConnectionClosedError(error)) {
      throw error;
    }

    await reconnectPrisma();
    return handler(request);
  }
}

export async function GET(request: Request) {
  return handleAuthRequest(authHandlers.GET, request);
}

export async function POST(request: Request) {
  return handleAuthRequest(authHandlers.POST, request);
}
