import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every external boundary this module touches at import, mocked at module load:
// `@starter/queue` constructs BullMQ Queues (IORedis sockets) at import, and
// `@starter/env/server` validates the real process env.
vi.mock("@starter/queue", () => ({ redisConnection: {} }));
vi.mock("@starter/env/server", () => ({
  env: {
    // The five budget pairs ./rate-limit-families reads at module load.
    RATE_LIMIT_AUTH_POINTS: 30,
    RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
    RATE_LIMIT_UPLOAD_POINTS: 200,
    RATE_LIMIT_UPLOAD_WINDOW_SECONDS: 60,
    RATE_LIMIT_EMAIL_POINTS: 3,
    RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
    RATE_LIMIT_CHAT_POINTS: 20,
    RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,
  },
  ADMIN_EMAILS: new Set<string>(),
}));

const consume = vi.fn();
const limiterOptions: Array<Record<string, unknown>> = [];

// Only the Redis-backed limiter CLASS is faked. `RateLimiterRes` stays real:
// the fail-open/fail-closed split is decided by an `instanceof` against it, so
// a fake would test nothing.
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rate-limiter-flexible")>();
  return {
    ...actual,
    RateLimiterRedis: class {
      readonly points = 20;
      constructor(options: Record<string, unknown>) {
        limiterOptions.push(options);
      }
      consume = consume;
    },
  };
});

const { RateLimiterRes } = await import("rate-limiter-flexible");
const { consumeChatSendBudget } = await import("./chat-rate-limit");

const code = (error: unknown) => (error as ORPCError<string, unknown>).code;

beforeEach(() => {
  consume.mockReset();
  consume.mockResolvedValue(undefined);
});

describe("chat spend limiter", () => {
  it("keys on the authenticated user, in its own bucket", async () => {
    await consumeChatSendBudget("user-1");
    expect(consume).toHaveBeenCalledWith("uid:user-1");
    // The keyPrefix is what makes this budget independent of every other
    // limiter — sharing one would merge chat spend into another surface.
    expect(limiterOptions[0]).toMatchObject({ keyPrefix: "rl:chat-send", points: 20 });
    // No `insuranceLimiter`: an in-memory ceiling per replica is not a real
    // bound on spend across a fleet, and it would be exactly the thing quietly
    // letting turns through during the outage this limiter must refuse.
    expect(limiterOptions[0]).not.toHaveProperty("insuranceLimiter");
  });

  it("refuses a turn over budget with a retry hint", async () => {
    consume.mockRejectedValue(new RateLimiterRes(0, 12_000, 21, false));
    const error = await consumeChatSendBudget("user-1").catch((caught: unknown) => caught);
    expect(code(error)).toBe("TOO_MANY_REQUESTS");
    expect((error as ORPCError<string, { retryAfterSeconds: number }>).data).toEqual({
      retryAfterSeconds: 12,
    });
  });

  it("FAILS CLOSED when the store is unreachable", async () => {
    // A general surface fails open here. This one must not: an accepted turn
    // spends money that does not come back and occupies a worker slot until it
    // drains, and the send's very next step (enqueueChatRun) needs the same
    // Redis anyway — so refusing costs availability that was already gone.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    consume.mockRejectedValue(new Error("ECONNREFUSED"));
    const error = await consumeChatSendBudget("user-1").catch((caught: unknown) => caught);
    expect(code(error)).toBe("SERVICE_UNAVAILABLE");
    logged.mockRestore();
  });
});
