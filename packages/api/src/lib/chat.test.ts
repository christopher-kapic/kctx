import { describe, expect, it } from "vitest";

import {
  type ChatMessageRow,
  type ChatSessionRow,
  serializeChatMessage,
  serializeChatSession,
} from "./chat";

function chatSessionRow(overrides: Partial<ChatSessionRow> = {}): ChatSessionRow {
  return {
    id: "chat-1",
    title: "New chat",
    status: "RUNNING",
    ...overrides,
  } satisfies ChatSessionRow;
}

function chatMessageRow(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: "message-1",
    seq: 3,
    role: "ASSISTANT",
    state: "COMPLETE",
    parts: [{ type: "text", content: "hello" }],
    ...overrides,
  } satisfies ChatMessageRow;
}

describe("serializeChatSession", () => {
  it("returns the exact client allowlist and widens the Prisma enum", () => {
    const row = chatSessionRow();
    const result = serializeChatSession(row);
    const expected = {
      id: row.id,
      title: row.title,
      status: String(row.status),
    };

    expect(result).toStrictEqual(expected);
    expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());
  });
});

describe("serializeChatMessage", () => {
  it("returns the exact client allowlist, widens enums, and preserves parts", () => {
    const row = chatMessageRow();
    const result = serializeChatMessage(row);
    const expected = {
      id: row.id,
      seq: row.seq,
      role: String(row.role),
      state: String(row.state),
      parts: row.parts,
    };

    expect(result).toStrictEqual(expected);
    expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());
  });

  // `state` is not cosmetic: the client picks its SSE replay cursor from the
  // hydrated rows, and only a COMPLETE row is a valid one. A serializer that
  // dropped it would make every hydrated row look final and resume the stream
  // from a half-written answer, which never arrives again.
  it("carries the streaming state through, because the replay cursor depends on it", () => {
    expect(serializeChatMessage(chatMessageRow({ state: "STREAMING" })).state).toBe("STREAMING");
  });
});
