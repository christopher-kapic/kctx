import type { Prisma } from "@starter/db";

/**
 * Serializers for chat rows crossing the oRPC boundary.
 *
 * Prisma enum columns arrive as branded enum values. oRPC's JSON serializer
 * carries them fine, but the inferred client type is the Prisma enum, which
 * would drag `@starter/db`'s generated types into the browser bundle's type
 * graph. Widening to `string` at the edge keeps the client contract to plain
 * JSON — the same reason enums are stringified.
 */

export const chatSessionSelect = {
  id: true,
  title: true,
  status: true,
} satisfies Prisma.ChatSessionSelect;

export type ChatSessionRow = Prisma.ChatSessionGetPayload<{
  select: typeof chatSessionSelect;
}>;

export function serializeChatSession(session: ChatSessionRow) {
  return {
    id: session.id,
    title: session.title,
    status: String(session.status),
  };
}

/**
 * `state` is widened alongside `role`, and it is not decoration: it is how the
 * client knows which hydrated rows are valid replay cursors. A row still marked
 * STREAMING is rewritten in place by the worker, so resuming the SSE stream from
 * its `seq` would ask for `seq > N` and never deliver the final version of N.
 * See `apps/web/src/hooks/use-chat-stream.ts` and patterns/durable-streaming.md.
 */
export const chatMessageSelect = {
  id: true,
  seq: true,
  role: true,
  state: true,
  parts: true,
} satisfies Prisma.ChatMessageSelect;

export type ChatMessageRow = Prisma.ChatMessageGetPayload<{
  select: typeof chatMessageSelect;
}>;

export function serializeChatMessage(message: ChatMessageRow) {
  return {
    id: message.id,
    seq: message.seq,
    role: String(message.role),
    state: String(message.state),
    parts: message.parts,
  };
}
