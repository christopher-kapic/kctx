import type { RouterClient } from "@orpc/server";
import { ADMIN_EMAILS, env, FORCE_SSO, SIGNUP_ENABLED, SSO_ENABLED } from "@starter/env/server";
import { isEmailConfigured } from "@starter/mailer";

import { protectedProcedure, publicProcedure } from "../index";
import { authRouter } from "./auth";
import { chatRouter } from "./chat";
import { projectsRouter } from "./projects";
import { pushRouter } from "./push";
import { queueRouter } from "./queue";
import { seedRouter } from "./seed";
import { settingsRouter } from "./settings";
import { usersRouter } from "./users";

export const appRouter = {
  health: {
    // No RPC readiness probe: a DB-touching `ready` procedure would be an
    // anonymous datastore-drain vector bounded only by the generic /rpc
    // limiter. Readiness is the HTTP /ready route, which has its own
    // readyLimiter bucket (apps/server/src/rate-limit.ts).
    check: publicProcedure.handler(() => {
      return "OK";
    }),
  },
  appConfig: publicProcedure.handler(() => {
    return {
      ssoEnabled: SSO_ENABLED,
      forceSso: FORCE_SSO,
      ssoProviderName: env.SSO_PROVIDER_NAME,
      signupEnabled: SIGNUP_ENABLED,
      adminBootstrapSignupEnabled: !SIGNUP_ENABLED && ADMIN_EMAILS.size > 0,
      // Gates the login challenge's "email me a code" affordance. The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight; this flag only reflects whether email is configured at all.
      emailEnabled: isEmailConfigured(),
    };
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.session?.user,
    };
  }),
  auth: authRouter,
  settings: settingsRouter,
  push: pushRouter,
  queue: queueRouter,
  seed: seedRouter,
  chat: chatRouter,
  users: usersRouter,
  // The golden-path example feature — patterns/golden-path.md.
  projects: projectsRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
