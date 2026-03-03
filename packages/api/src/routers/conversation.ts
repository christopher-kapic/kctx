import { z } from "zod";
import { ORPCError } from "@orpc/server";

import prisma from "@kctx/db";

import { protectedProcedure } from "../index";

export const conversationRouter = {
  list: protectedProcedure
    .input(
      z.object({
        packageIdentifier: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      let packageId: string | undefined;
      if (input.packageIdentifier) {
        const pkg = await prisma.package.findUnique({
          where: { identifier: input.packageIdentifier },
        });
        if (pkg) packageId = pkg.id;
      }

      const owned = await prisma.conversation.findMany({
        where: {
          ownerId: userId,
          ...(packageId ? { packageId } : {}),
        },
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          _count: { select: { messages: true } },
          Package: { select: { identifier: true } },
        },
        orderBy: { updatedAt: "desc" },
      });

      const shared = await prisma.conversation.findMany({
        where: {
          shares: { some: { sharedWithId: userId } },
          ...(packageId ? { packageId } : {}),
        },
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          _count: { select: { messages: true } },
          User: { select: { name: true } },
          Package: { select: { identifier: true } },
        },
        orderBy: { updatedAt: "desc" },
      });

      return { owned, shared };
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.id,
          OR: [
            { ownerId: userId },
            { shares: { some: { sharedWithId: userId } } },
          ],
        },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
          User: { select: { id: true, name: true } },
          Package: { select: { identifier: true } },
        },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found",
        });
      }

      return conversation;
    }),

  create: protectedProcedure
    .input(
      z.object({
        packageIdentifier: z.string(),
        title: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const pkg = await prisma.package.findUnique({
        where: { identifier: input.packageIdentifier },
      });
      if (!pkg) {
        throw new ORPCError("NOT_FOUND", {
          message: "Package not found",
        });
      }

      const conversation = await prisma.conversation.create({
        data: {
          title: input.title ?? "New Conversation",
          packageId: pkg.id,
          ownerId: context.session.user.id,
        },
      });

      return conversation;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.id },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found",
        });
      }

      if (conversation.ownerId !== context.session.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "Only the owner can delete a conversation",
        });
      }

      await prisma.conversation.delete({ where: { id: input.id } });
      return { success: true };
    }),

  updateTitle: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ input, context }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.id,
          ownerId: context.session.user.id,
        },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found",
        });
      }

      return prisma.conversation.update({
        where: { id: input.id },
        data: { title: input.title },
      });
    }),

  addMessage: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        role: z.enum(["user", "assistant"]),
        content: z.string(),
        thinking: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          OR: [
            { ownerId: userId },
            { shares: { some: { sharedWithId: userId } } },
          ],
        },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found",
        });
      }

      const message = await prisma.chatMessage.create({
        data: {
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          thinking: input.thinking,
        },
      });

      // Update conversation title from first user message
      const messageCount = await prisma.chatMessage.count({
        where: { conversationId: input.conversationId },
      });
      if (messageCount === 1 && input.role === "user") {
        await prisma.conversation.update({
          where: { id: input.conversationId },
          data: { title: input.content.substring(0, 100) },
        });
      }

      return message;
    }),

  searchUsers: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      const users = await prisma.user.findMany({
        where: {
          id: { not: userId },
          OR: [
            { email: { contains: input.query } },
            { name: { contains: input.query } },
          ],
        },
        select: { id: true, name: true, email: true, image: true },
        take: 50,
      });

      return users;
    }),

  share: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        userId: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          ownerId: context.session.user.id,
        },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found or not owned by you",
        });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: input.userId },
      });
      if (!targetUser) {
        throw new ORPCError("NOT_FOUND", {
          message: "User not found",
        });
      }

      const share = await prisma.conversationShare.create({
        data: {
          conversationId: input.conversationId,
          sharedWithId: input.userId,
        },
      });

      return share;
    }),

  unshare: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        userId: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          ownerId: context.session.user.id,
        },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found or not owned by you",
        });
      }

      await prisma.conversationShare.deleteMany({
        where: {
          conversationId: input.conversationId,
          sharedWithId: input.userId,
        },
      });

      return { success: true };
    }),

  getSharedWith: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .handler(async ({ input, context }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          OR: [
            { ownerId: context.session.user.id },
            { shares: { some: { sharedWithId: context.session.user.id } } },
          ],
        },
      });

      if (!conversation) {
        throw new ORPCError("NOT_FOUND", {
          message: "Conversation not found",
        });
      }

      const shares = await prisma.conversationShare.findMany({
        where: { conversationId: input.conversationId },
        include: {
          User: { select: { id: true, name: true, email: true, image: true } },
        },
      });

      return shares.map((s) => s.User);
    }),
};
