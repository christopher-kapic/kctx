import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable, so both halves of the gate can be flipped between tests. Mocked
// because `@starter/env/shared` validates process.env at module load and throws
// in CI — the module-load boundary rule from patterns/testing.md.
const envMock = { CHAT_ENABLED: true, OPENROUTER_API_KEY: "sk-test" as string | undefined };
vi.mock("@starter/env/shared", () => ({ env: envMock }));

const { assertChatEnabled, chatEnabled } = await import("./chat-enabled");

describe("chatEnabled", () => {
  beforeEach(() => {
    envMock.CHAT_ENABLED = true;
    envMock.OPENROUTER_API_KEY = "sk-test";
  });

  it("is on when the flag is set and a key is configured", () => {
    expect(chatEnabled()).toBe(true);
  });

  // The key is the REAL dependency — without it the worker throws on its first
  // dispatch. Deriving enablement from the credential is the same opt-in idiom
  // `S3_BUCKET` gives assets.
  it("is off without an API key, however the flag is set", () => {
    envMock.OPENROUTER_API_KEY = undefined;
    expect(chatEnabled()).toBe(false);
  });

  // And the explicit switch, which exists because the key alone is ambiguous in
  // the one direction that costs money: it is SHARED with the translation provider, so
  // a deployment that set it purely to translate content would otherwise expose
  // a paid tool-calling loop to every signed-in user.
  it("is off when the flag is false even with a key present", () => {
    envMock.CHAT_ENABLED = false;
    expect(chatEnabled()).toBe(false);
  });
});

describe("assertChatEnabled", () => {
  beforeEach(() => {
    envMock.CHAT_ENABLED = true;
    envMock.OPENROUTER_API_KEY = "sk-test";
  });

  it("passes when chat is configured", () => {
    expect(() => assertChatEnabled()).not.toThrow();
  });

  // SERVICE_UNAVAILABLE, not NOT_FOUND: the route exists and the caller is
  // allowed to be here — the server is not configured to serve it. Same shape
  // `/api/assets/*` returns when `S3_BUCKET` is unset.
  it("refuses with SERVICE_UNAVAILABLE when it is not", () => {
    envMock.CHAT_ENABLED = false;
    expect(() => assertChatEnabled()).toThrowError(
      expect.objectContaining({ code: "SERVICE_UNAVAILABLE" }) as unknown as ORPCError,
    );
  });
});
