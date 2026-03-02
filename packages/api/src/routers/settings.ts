import { z } from "zod";

import prisma from "@kctx/db";

import { adminProcedure, protectedProcedure, publicProcedure } from "../index";

/** Get or create the singleton settings row */
async function getOrCreateSettings() {
  return prisma.siteSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
}

export const settingsRouter = {
  sshEnabled: protectedProcedure.handler(async () => {
    const settings = await getOrCreateSettings();
    return { sshCloningEnabled: settings.sshCloningEnabled };
  }),

  signupsEnabled: publicProcedure.handler(async () => {
    const settings = await getOrCreateSettings();
    return { signupsEnabled: settings.signupsEnabled };
  }),

  get: adminProcedure.handler(async () => {
    return getOrCreateSettings();
  }),

  update: adminProcedure
    .input(
      z.object({
        sshCloningEnabled: z.boolean().optional(),
        signupsEnabled: z.boolean().optional(),
        opencodeUrl: z.string().optional(),
        opencodeTimeoutMs: z.number().int().positive().optional(),
      }),
    )
    .handler(async ({ input }) => {
      // Ensure settings row exists
      await getOrCreateSettings();

      return prisma.siteSettings.update({
        where: { id: "default" },
        data: input,
      });
    }),
};
