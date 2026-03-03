import { ORPCError } from "@orpc/server";
import { z } from "zod";

import prisma from "@kctx/db";

import { protectedProcedure } from "../index";

export const packageRouter = {
  list: protectedProcedure.handler(async () => {
    return prisma.package.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        Repository: {
          select: {
            id: true,
            gitProvider: true,
            orgOrUser: true,
            repoName: true,
            cloneStatus: true,
          },
        },
      },
    });
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const pkg = await prisma.package.findUnique({
        where: { id: input.id },
        include: {
          Repository: true,
        },
      });
      if (!pkg) {
        throw new ORPCError("NOT_FOUND", { message: "Package not found" });
      }
      return pkg;
    }),

  create: protectedProcedure
    .input(
      z.object({
        identifier: z.string().min(1),
        displayName: z.string().min(1),
        packageManager: z.string().min(1),
        defaultTag: z.string().min(1),
        kctxHelper: z.string().optional(),
        urls: z.record(z.string(), z.string()).default({}),
        repositoryId: z.string(),
      }),
    )
    .handler(async ({ input }) => {
      // Verify repository exists
      const repo = await prisma.repository.findUnique({
        where: { id: input.repositoryId },
      });
      if (!repo) {
        throw new ORPCError("NOT_FOUND", {
          message: "Repository not found",
        });
      }

      // Check for duplicate identifier
      const existing = await prisma.package.findUnique({
        where: { identifier: input.identifier },
      });
      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: "A package with this identifier already exists",
        });
      }

      return prisma.package.create({
        data: {
          identifier: input.identifier,
          displayName: input.displayName,
          packageManager: input.packageManager,
          defaultTag: input.defaultTag,
          kctxHelper: input.kctxHelper,
          urls: input.urls as Record<string, string>,
          repositoryId: input.repositoryId,
        },
        include: {
          Repository: {
            select: {
              id: true,
              gitProvider: true,
              orgOrUser: true,
              repoName: true,
            },
          },
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        displayName: z.string().min(1).optional(),
        packageManager: z.string().min(1).optional(),
        defaultTag: z.string().min(1).optional(),
        kctxHelper: z.string().nullable().optional(),
        urls: z.record(z.string(), z.string()).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, urls, ...rest } = input;

      const existing = await prisma.package.findUnique({
        where: { id },
      });
      if (!existing) {
        throw new ORPCError("NOT_FOUND", { message: "Package not found" });
      }

      return prisma.package.update({
        where: { id },
        data: {
          ...rest,
          ...(urls !== undefined ? { urls: urls as Record<string, string> } : {}),
        },
        include: {
          Repository: {
            select: {
              id: true,
              gitProvider: true,
              orgOrUser: true,
              repoName: true,
            },
          },
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const existing = await prisma.package.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new ORPCError("NOT_FOUND", { message: "Package not found" });
      }

      await prisma.package.delete({ where: { id: input.id } });

      return { success: true };
    }),
};
