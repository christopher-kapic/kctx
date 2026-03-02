import { ORPCError } from "@orpc/server";
import { z } from "zod";

import prisma from "@kctx/db";

import { adminProcedure } from "../index";

export const usersRouter = {
  list: adminProcedure.handler(async () => {
    return prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        banned: true,
      },
    });
  }),

  updateRole: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["admin", "user"]),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.userId === context.session.user.id) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Cannot change your own role",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: input.userId },
      });
      if (!user) {
        throw new ORPCError("NOT_FOUND", { message: "User not found" });
      }

      return prisma.user.update({
        where: { id: input.userId },
        data: { role: input.role },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          banned: true,
        },
      });
    }),

  delete: adminProcedure
    .input(z.object({ userId: z.string() }))
    .handler(async ({ input, context }) => {
      if (input.userId === context.session.user.id) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Cannot delete your own account",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: input.userId },
      });
      if (!user) {
        throw new ORPCError("NOT_FOUND", { message: "User not found" });
      }

      await prisma.user.delete({ where: { id: input.userId } });

      return { success: true };
    }),
};
