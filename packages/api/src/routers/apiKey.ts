import { randomBytes, createHash } from "node:crypto";

import { z } from "zod";

import prisma from "@kctx/db";

import { protectedProcedure } from "../index";

function generateApiKey(): { plain: string; hashed: string } {
  const raw = randomBytes(32).toString("hex");
  const plain = `kctx_${raw}`;
  const hashed = createHash("sha256").update(plain).digest("hex");
  return { plain, hashed };
}

export const apiKeyRouter = {
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ input, context }) => {
      const { plain, hashed } = generateApiKey();

      const apiKey = await prisma.apiKey.create({
        data: {
          name: input.name,
          hashedKey: hashed,
          userId: context.session.user.id,
        },
      });

      return {
        id: apiKey.id,
        name: apiKey.name,
        createdAt: apiKey.createdAt,
        key: plain,
      };
    }),

  list: protectedProcedure.handler(async ({ context }) => {
    return prisma.apiKey.findMany({
      where: { userId: context.session.user.id },
      select: {
        id: true,
        name: true,
        createdAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }),

  revoke: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      const apiKey = await prisma.apiKey.findFirst({
        where: {
          id: input.id,
          userId: context.session.user.id,
        },
      });

      if (!apiKey) {
        throw new Error("API key not found");
      }

      if (apiKey.revokedAt) {
        throw new Error("API key is already revoked");
      }

      return prisma.apiKey.update({
        where: { id: input.id },
        data: { revokedAt: new Date() },
        select: {
          id: true,
          name: true,
          createdAt: true,
          revokedAt: true,
        },
      });
    }),
};
