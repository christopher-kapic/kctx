import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/hooks/use-chat-stream";

import { chatActivityKey } from "./message-list";

const msg = (seq: number, content: string): ChatMessage => ({
  id: `m-${seq}`,
  seq,
  role: "ASSISTANT",
  parts: [{ type: "text", content }],
});

describe("chatActivityKey", () => {
  it("is empty for an empty transcript", () => {
    expect(chatActivityKey([])).toBe("");
  });

  it("is stable for identical content", () => {
    expect(chatActivityKey([msg(0, "hello")])).toBe(chatActivityKey([msg(0, "hello")]));
  });

  it("moves as streamed text grows in place within one part", () => {
    expect(chatActivityKey([msg(0, "hel")])).not.toBe(chatActivityKey([msg(0, "hello")]));
  });

  it("moves when a message is appended", () => {
    expect(chatActivityKey([msg(0, "hello")])).not.toBe(
      chatActivityKey([msg(0, "hello"), msg(1, "world")]),
    );
  });

  it("moves when a part is added", () => {
    const onePart = [msg(0, "hello")];
    const twoParts: ChatMessage[] = [
      {
        ...msg(0, "hello"),
        parts: [...msg(0, "hello").parts, { type: "text", content: "more" }],
      },
    ];
    expect(chatActivityKey(onePart)).not.toBe(chatActivityKey(twoParts));
  });
});
