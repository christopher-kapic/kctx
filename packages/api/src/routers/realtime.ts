import { z } from "zod";
import { ORPCError, eventIterator } from "@orpc/server";

import prisma from "@kctx/db";

import { protectedProcedure } from "../index";

// Simple in-memory pub/sub for conversation events
type ConversationEvent =
  | {
      type: "typing";
      userId: string;
      userName: string;
      isTyping: boolean;
      text: string;
    }
  | {
      type: "message";
      message: { id: string; role: string; content: string };
    };

type Listener = (event: ConversationEvent) => void;

class ConversationBroker {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(conversationId: string, listener: Listener): () => void {
    if (!this.listeners.has(conversationId)) {
      this.listeners.set(conversationId, new Set());
    }
    this.listeners.get(conversationId)!.add(listener);

    return () => {
      const set = this.listeners.get(conversationId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(conversationId);
      }
    };
  }

  publish(conversationId: string, event: ConversationEvent) {
    const set = this.listeners.get(conversationId);
    if (set) {
      for (const listener of set) {
        listener(event);
      }
    }
  }
}

export const broker = new ConversationBroker();

const eventSchema = z.union([
  z.object({
    type: z.literal("typing"),
    userId: z.string(),
    userName: z.string(),
    isTyping: z.boolean(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("message"),
    message: z.object({
      id: z.string(),
      role: z.string(),
      content: z.string(),
    }),
  }),
]);

export const realtimeRouter = {
  stream: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .output(eventIterator(eventSchema))
    .handler(async function* ({ input, context }) {
      const userId = context.session.user.id;

      // Verify access
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

      const queue: ConversationEvent[] = [];
      let resolve: (() => void) | null = null;

      const unsubscribe = broker.subscribe(
        input.conversationId,
        (event) => {
          // Don't echo typing events back to the sender
          if (event.type === "typing" && event.userId === userId) return;
          queue.push(event);
          if (resolve) {
            resolve();
            resolve = null;
          }
        },
      );

      try {
        while (true) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
          while (queue.length > 0) {
            yield queue.shift()!;
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  broadcastTyping: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        text: z.string(),
        isTyping: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      broker.publish(input.conversationId, {
        type: "typing",
        userId: context.session.user.id,
        userName: context.session.user.name,
        isTyping: input.isTyping,
        text: input.text,
      });
      return { success: true };
    }),

  broadcastMessage: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        message: z.object({
          id: z.string(),
          role: z.string(),
          content: z.string(),
        }),
      }),
    )
    .handler(async ({ input }) => {
      broker.publish(input.conversationId, {
        type: "message",
        message: input.message,
      });
      return { success: true };
    }),
};
