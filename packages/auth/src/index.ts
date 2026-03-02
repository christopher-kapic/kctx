import prisma from "@kctx/db";
import { env } from "@kctx/env/server";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins/admin";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "sqlite",
  }),

  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: env.CORS_ORIGIN ? [env.CORS_ORIGIN] : [],
  emailAndPassword: {
    enabled: true,
  },
  ...(env.CORS_ORIGIN
    ? {
        advanced: {
          defaultCookieAttributes: {
            sameSite: "none" as const,
            secure: true,
            httpOnly: true,
          },
        },
      }
    : {}),
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const existingUsers = await prisma.user.count();
          if (existingUsers === 0) {
            return { data: { ...user, role: "admin" } };
          }
          return { data: user };
        },
      },
    },
  },
  plugins: [admin()],
});
