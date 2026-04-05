import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";

import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { buildRuntimeTrustedOrigins } from "@/lib/runtime-origin";
import { deleteFile } from "@/lib/storage";
import { syncProfileForAuthUser } from "@/lib/user-profile-sync";

const authSecret =
  process.env.BETTER_AUTH_SECRET ??
  (process.env.NODE_ENV !== "production"
    ? "autoapplication-local-dev-auth-secret-2026"
    : undefined);

const authBaseUrl =
  process.env.BETTER_AUTH_URL?.trim() ||
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim() ||
  (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined);

export const auth = betterAuth({
  secret: authSecret,
  baseURL: authBaseUrl,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await syncProfileForAuthUser(user);
        },
      },
      update: {
        after: async (user) => {
          await syncProfileForAuthUser(user);
        },
      },
      delete: {
        before: async (user) => {
          const profile = await prisma.userProfile.findUnique({
            where: { authUserId: user.id },
            select: {
              id: true,
              documents: {
                select: { storageKey: true },
              },
            },
          });

          if (profile) {
            await Promise.allSettled(
              profile.documents.map((doc) => deleteFile(doc.storageKey))
            );
          }

          return true;
        },
      },
    },
  },
  user: {
    additionalFields: {
      emailNotificationsEnabled: {
        type: "boolean",
        required: false,
        defaultValue: true,
      },
    },
    deleteUser: {
      enabled: true,
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: false,
    async sendVerificationEmail({ user, url }) {
      const safeUrl = url.replace(/&/g, "&amp;");
      const text = `Verify your AutoApplication email by opening this link:\n\n${url}`;
      const html = `
        <p>Hello${user.name ? ` ${user.name}` : ""},</p>
        <p>Verify your AutoApplication email address.</p>
        <p><a href="${safeUrl}">Verify email</a></p>
        <p style="word-break:break-all;font-size:12px;color:#888;">
          Or copy this link: ${safeUrl}
        </p>
        <p>If you did not request this, you can ignore this email.</p>
      `;

      const sent = await sendEmail({
        to: user.email,
        subject: "Verify your email",
        text,
        html,
      });

      if (!sent) {
        console.log(`[auth] Verification email link for ${user.email}: ${url}`);
      }
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    autoSignIn: false,
    async sendResetPassword({ user, url }) {
      const text = `Reset your AutoApplication password by opening this link:\n\n${url}`;
      const html = `
        <p>Hello${user.name ? ` ${user.name}` : ""},</p>
        <p>Reset your AutoApplication password.</p>
        <p><a href="${url}">Reset password</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `;

      const sent = await sendEmail({
        to: user.email,
        subject: "Reset your password",
        text,
        html,
      });

      if (!sent) {
        console.log(`[auth] Password reset link for ${user.email}: ${url}`);
      }
    },
  },
  trustedOrigins: async (request) => buildRuntimeTrustedOrigins(request?.headers),
});
