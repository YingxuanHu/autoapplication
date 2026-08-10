import { headers } from "next/headers";

import { prisma, withPrismaConnectionRetry } from "@/lib/db";
import { auth } from "@/lib/auth";
import {
  getSensitiveActionSessionFailure,
  getVerifiedSessionTokenFromHeaders,
  isSessionUsableByPolicy,
  type SessionPolicyReason,
} from "@/lib/auth-session-policy";
import { syncProfileForAuthUser } from "@/lib/user-profile-sync";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ReauthenticationRequiredError extends Error {
  reason: SessionPolicyReason;

  constructor(reason: SessionPolicyReason = "not_fresh") {
    super("For security, sign in again before continuing.");
    this.name = "ReauthenticationRequiredError";
    this.reason = reason;
  }
}

export class AiAccessDeniedError extends Error {
  constructor(message = "AI features are not enabled for this account.") {
    super(message);
    this.name = "AiAccessDeniedError";
  }
}

type SessionUser = {
  id: string;
  email: string;
  name: string;
};

async function getPolicySession(requestHeaders: Headers) {
  const token = await getVerifiedSessionTokenFromHeaders(requestHeaders);
  if (!token) {
    return null;
  }

  return withPrismaConnectionRetry(() =>
    prisma.session.findUnique({
      where: { token },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        updatedAt: true,
        userId: true,
        user: {
          select: { status: true },
        },
      },
    })
  );
}

async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const requestHeaders = await headers();
    const policySession = await getPolicySession(requestHeaders);

    if (
      !policySession?.userId ||
      policySession.user.status !== "ACTIVE" ||
      !isSessionUsableByPolicy(policySession)
    ) {
      return null;
    }

    const session = await withPrismaConnectionRetry(() =>
      auth.api.getSession({
        headers: requestHeaders,
      })
    );

    if (!session?.user) {
      return null;
    }

    if (session.user.id !== policySession.userId) {
      return null;
    }

    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
  } catch {
    return null;
  }
}

export async function requireFreshSensitiveSession() {
  const requestHeaders = await headers();
  const policySession = await getPolicySession(requestHeaders);

  if (
    !policySession?.userId ||
    policySession.user.status !== "ACTIVE" ||
    !isSessionUsableByPolicy(policySession)
  ) {
    throw new UnauthorizedError();
  }

  const sensitiveFailure = getSensitiveActionSessionFailure(policySession);
  if (sensitiveFailure) {
    throw new ReauthenticationRequiredError(sensitiveFailure);
  }

  return {
    authUserId: policySession.userId,
    sessionId: policySession.id,
  };
}

async function ensureProfileForUser(user: SessionUser) {
  return syncProfileForAuthUser(user);
}

export async function getOptionalSessionUser() {
  return getSessionUser();
}

export async function getOptionalCurrentAuthUserId() {
  return (await getSessionUser())?.id ?? null;
}

export async function getOptionalCurrentUserProfile() {
  const sessionUser = await getSessionUser();

  if (sessionUser) {
    return ensureProfileForUser(sessionUser);
  }

  return null;
}

/**
 * Resolves both identifiers from one authenticated session/profile lookup.
 * Use this in server-rendered views that need user-scoped job data.
 */
export async function getOptionalCurrentUserIds() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return null;
  }

  const profile = await ensureProfileForUser(sessionUser);
  return {
    authUserId: sessionUser.id,
    profileId: profile.id,
  };
}

export async function requireCurrentUserProfile() {
  const profile = await getOptionalCurrentUserProfile();

  if (!profile) {
    throw new UnauthorizedError();
  }

  return profile;
}

export async function getOptionalCurrentProfileId() {
  return (await getOptionalCurrentUserProfile())?.id ?? null;
}

export async function requireCurrentProfileId() {
  return (await requireCurrentUserProfile()).id;
}

export async function requireCurrentUserIds() {
  const sessionUser = await getSessionUser();

  if (!sessionUser) {
    throw new UnauthorizedError();
  }

  const profile = await ensureProfileForUser(sessionUser);

  return {
    authUserId: sessionUser.id,
    profileId: profile.id,
  };
}

export async function requireCurrentAuthUserId() {
  const userId = await getOptionalCurrentAuthUserId();
  if (!userId) {
    throw new UnauthorizedError();
  }
  return userId;
}

export async function requireAiFeatureAccess() {
  const sessionUser = await getSessionUser();

  if (!sessionUser) {
    throw new UnauthorizedError();
  }

  return sessionUser;
}
