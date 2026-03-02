import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";
import { repositoryRouter } from "./repository";
import { packageRouter } from "./package";
import { settingsRouter } from "./settings";
import { usersRouter } from "./users";
import { statsRouter } from "./stats";
import { apiKeyRouter } from "./apiKey";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.session?.user,
    };
  }),
  repository: repositoryRouter,
  package: packageRouter,
  settings: settingsRouter,
  users: usersRouter,
  stats: statsRouter,
  apiKey: apiKeyRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
