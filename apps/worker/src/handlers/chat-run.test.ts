import { AgentRuntimeError, defineTool } from "@starter/agent-runtime";
import type { ChatRunJobData } from "@starter/queue";
import type { Job } from "bullmq";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@starter/env/shared", () => ({
  env: {
    // The worker re-checks enablement too: a job can sit in the queue across the
    // deploy that flips the switch. Default here is the configured deployment.
    CHAT_ENABLED: true,
    CHAT_MODEL: "test-model",
    CHAT_MAX_ITERATIONS: 3,
    CHAT_RUN_TIMEOUT_MS: 300000,
    OPENROUTER_API_KEY: "test-key",
    RESULT_STORE_TTL_SECONDS: 600,
  },
}));
// `@starter/queue/jobs` is the side-effect-free half — so the job schema the
// handler validates with is the real one while the connection is a stub.
// `createRedisConnection` feeds the result store's dedicated untimed handle;
// the shared `redisConnection` stub below is only what pub/sub assertions read.
vi.mock("@starter/queue", async () => {
  const jobs = await import("@starter/queue/jobs");
  return {
    ...jobs,
    createRedisConnection: () => ({ set: vi.fn(), get: vi.fn(), disconnect: vi.fn() }),
    redisConnection: { publish: vi.fn().mockResolvedValue(1), set: vi.fn(), get: vi.fn() },
  };
});
vi.mock("@starter/agent-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("@starter/agent-runtime")>();
  return { ...original, runAgentLoop: vi.fn() };
});
vi.mock("../lib/chat-tools.js", () => ({
  buildChatTools: vi.fn(async () => ({
    tools: [
      defineTool({
        name: "current_time",
        description: "time",
        inputSchema: z.object({}),
        execute: () => ({ iso: "2026-01-01T00:00:00.000Z" }),
      }),
    ],
  })),
}));

const { default: prisma } = await import("@starter/db");
const { redisConnection } = await import("@starter/queue");
const { runAgentLoop } = await import("@starter/agent-runtime");
const { handleChatRunJob } = await import("./chat-run.js");

const db = prisma as unknown as {
  chatSession: {
    findUnique: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    count: MockInstance;
  };
  chatMessage: { upsert: MockInstance; deleteMany: MockInstance; updateMany: MockInstance };
};

/**
 * A stand-in for the `ChatSession.nextSeq` column, which is the seq ALLOCATOR:
 * the handler floors it with an `updateMany` and then takes values from it with
 * atomic `{ increment: 1 }` updates that read the new value back. Modelling it
 * (rather than returning a fixed row) is what lets these tests observe that a
 * deleted row never lowers it.
 */
type SessionUpdateArgs = { data?: { nextSeq?: number | { increment?: number } } };
let allocator = 0;
const trackAllocator = (initial: number) => {
  allocator = initial;
  db.chatSession.updateMany.mockImplementation(async (args: SessionUpdateArgs) => {
    const floor = args.data?.nextSeq;
    if (typeof floor === "number") allocator = Math.max(allocator, floor);
    return { count: 1 };
  });
  db.chatSession.update.mockImplementation(async (args: SessionUpdateArgs) => {
    const step = typeof args.data?.nextSeq === "object" ? args.data.nextSeq.increment : undefined;
    if (typeof step === "number") {
      allocator += step;
      return { nextSeq: allocator };
    }
    return {};
  });
};
const publish = vi.mocked(redisConnection.publish);
const runLoop = vi.mocked(runAgentLoop);

const baseSession = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  ownerId: "user-1",
  // "" is the stored "unset" title — the UI owns the placeholder wording.
  title: "",
  status: "IDLE",
  activeJobId: null,
  runGeneration: 1,
  nextSeq: 0,
  Messages: [
    {
      id: "message-1",
      seq: 1,
      role: "USER",
      parts: [{ type: "text", content: "How many rows?" }],
      createdAt: new Date("2026-01-01"),
    },
  ],
  ...overrides,
});

const fakeJob = () =>
  ({
    id: "job-1",
    data: { sessionId: "session-1", userMessageSeq: 1, runGeneration: 1 },
  }) as Job<ChatRunJobData>;

describe("handleChatRunJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.chatSession.findUnique.mockResolvedValue(baseSession());
    // 0 is the additive column default, so every test also covers a session
    // that predates the allocator: the handler floors it past the existing rows.
    trackAllocator(0);
    // The mid-stream ownership re-check: this run still owns the session unless
    // a test says otherwise. See the supersede case below.
    db.chatSession.count.mockResolvedValue(1);
    db.chatMessage.upsert.mockResolvedValue({});
    db.chatMessage.deleteMany.mockResolvedValue({ count: 0 });
    db.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    publish.mockResolvedValue(1);
  });

  it("persists an assistant turn before publishing it, and titles the session once", async () => {
    const order: string[] = [];
    db.chatMessage.upsert.mockImplementation(async () => {
      order.push("upsert");
      return {};
    });
    publish.mockImplementation(async (_channel, payload) => {
      if (String(payload).includes('"type":"message"')) order.push("publish");
      return 1;
    });

    runLoop.mockImplementationOnce(async (options) => {
      expect(options.messages[0]?.parts).toEqual([{ type: "text", content: "How many rows?" }]);
      expect(options.cacheKey).toBe("session-1");
      await options.onChunk?.({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant-1",
        delta: "12",
      });
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "12 rows" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "completed",
      };
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });

    // THE durability invariant: Postgres first, Redis second. The trailing
    // publish is the finalization frame — the only one carrying
    // `state: "COMPLETE"`, and so the only one the reader may stamp an `id:` on.
    // See the dedicated test below.
    expect(order).toEqual(["upsert", "publish", "publish"]);
    expect(db.chatMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId_seq: { sessionId: "session-1", seq: 2 } } }),
    );
    // The chunk and the durable message share a seq, so a client can replace
    // streamed text with the persisted row instead of rendering it twice.
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"type":"chunk","seq":2'),
    );
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"idle"'),
    );
    // The auto-title is its OWN compare-and-set — the claim predicate PLUS
    // `title: ""`, so "was this untitled?" is answered by the database at the
    // moment of the write and not by the snapshot this run loaded. See the
    // mid-run rename test below.
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1", title: "" },
      data: { title: "How many rows?" },
    });
    // The terminal write is a compare-and-set on the SAME predicate as the
    // claim, and carries status only — see the superseded-run test.
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
      data: { status: "IDLE", activeJobId: null },
    });
  });

  // THE FINALITY INVARIANT. A streaming turn is upserted under ONE seq over and
  // over, so a `message` frame published mid-answer describes a row that is
  // durable but will change. The server may only stamp an SSE `id:` on a final
  // row, and it is a different PROCESS — so finality has to be state on the row,
  // not something this handler knows in memory. Publishing every frame as final
  // (or writing the row COMPLETE from the first token) is the bug: a client that
  // dropped mid-answer would resume at `seq > N` and never receive the finished
  // row N.
  it("streams a message as non-final and marks the row COMPLETE only when the turn ends", async () => {
    const order: string[] = [];
    db.chatMessage.upsert.mockImplementation(async () => {
      order.push("upsert");
      return {};
    });
    db.chatMessage.updateMany.mockImplementation(async () => {
      order.push("complete");
      return { count: 1 };
    });
    publish.mockImplementation(async (_channel, payload) => {
      const text = String(payload);
      if (text.includes('"type":"message"')) {
        order.push(text.includes('"state":"COMPLETE"') ? "publish:final" : "publish:partial");
      }
      return 1;
    });

    runLoop.mockImplementationOnce(async (options) => {
      const grow = async (content: string) =>
        options.onMessagesChange?.([
          ...options.messages,
          { id: "assistant-1", role: "assistant", parts: [{ type: "text", content }] },
        ]);
      await grow("12 ro");
      await grow("12 rows");
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "completed",
      };
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });

    // Every in-flight write and frame is STREAMING; the promotion happens once,
    // after the loop, and is durable BEFORE the frame that announces it.
    expect(order).toEqual([
      "upsert",
      "publish:partial",
      "upsert",
      "publish:partial",
      "complete",
      "publish:final",
    ]);
    for (const call of db.chatMessage.upsert.mock.calls as [
      { create: { state: string }; update: { state: string } },
    ][]) {
      expect(call[0].create.state).toBe("STREAMING");
      expect(call[0].update.state).toBe("STREAMING");
    }
    expect(db.chatMessage.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1", seq: { in: [2] } },
      data: { state: "COMPLETE" },
    });
    // The final frame is the only one a reader may resume from, so it has to
    // carry the seq the partials were written under — not a new one.
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"type":"message","seq":2,"state":"COMPLETE"'),
    );
    // ...and it is published before the terminal status frame, so a client that
    // acts on `idle` already holds the finished answer.
    const published = publish.mock.calls.map((call) => String(call[1]));
    expect(published.findIndex((payload) => payload.includes('"state":"COMPLETE"'))).toBeLessThan(
      published.findIndex((payload) => payload.includes('"data":"idle"')),
    );
  });

  // The other half: a run that fails leaves its partial STREAMING. That parks
  // every client's cursor BELOW the partial, which is exactly what makes the
  // retry's replacement — deleted row, fresh higher seq — reach them through the
  // replay alone. Marking it final here would strand those clients above a row
  // that is about to disappear, and would add a write to a path that is already
  // failing.
  it("leaves a failed run's partial row STREAMING so no cursor can settle on it", async () => {
    runLoop.mockImplementationOnce(async (options) => {
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "12 ro" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "timeout",
      };
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });
    expect(db.chatMessage.updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"state":"COMPLETE"'),
    );
  });

  it("keeps a user-set title instead of overwriting it", async () => {
    db.chatSession.findUnique.mockResolvedValue(baseSession({ title: "Quarterly numbers" }));
    runLoop.mockResolvedValueOnce({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "completed",
    });
    await handleChatRunJob(fakeJob());
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
      data: { status: "IDLE", activeJobId: null },
    });
  });

  // Regression guard. The auto-title's trigger — "this session has no name yet"
  // — used to be read off `session.title` in the snapshot loaded at the START of
  // the run. A run is a long `await`, and `renameSession` is callable
  // throughout it: a user who names the conversation while its very first answer
  // is still streaming had that name silently replaced by the derived one the
  // moment the turn completed. The condition has to be part of the WRITE
  // PREDICATE, so it is evaluated against the row as it stands at that instant.
  //
  // And it has to be a SEPARATE statement: folding `title: ""` into the terminal
  // compare-and-set would make a rename swallow the release too, leaving the
  // session at RUNNING with a live `activeJobId` — wedged behind a run that had
  // already finished. Renaming must cost the session nothing.
  it("does not overwrite a rename that landed while the first answer was streaming", async () => {
    // Loaded untitled…
    db.chatSession.findUnique.mockResolvedValue(baseSession({ title: "" }));
    /** The row's title as the database holds it, right now. */
    let storedTitle = "";
    let released: { status?: string; activeJobId?: string | null } | undefined;
    db.chatSession.updateMany.mockImplementation(
      async (args: {
        where?: { OR?: unknown; title?: string };
        data?: { nextSeq?: unknown; title?: string; status?: string; activeJobId?: string | null };
      }) => {
        // The claim and the monotonic allocator floor always match.
        if (args.where?.OR !== undefined || args.data?.nextSeq !== undefined) return { count: 1 };
        // The auto-title: a compare-and-set on the CURRENT stored title.
        if (args.where?.title !== undefined) {
          if (args.where.title !== storedTitle) return { count: 0 };
          storedTitle = String(args.data?.title);
          return { count: 1 };
        }
        // Any other write matching the claim lands unconditionally — including
        // a title carried along inside it, which is the bug this test is about.
        if (args.data?.title !== undefined) storedTitle = String(args.data.title);
        released = args.data ?? {};
        return { count: 1 };
      },
    );

    runLoop.mockImplementationOnce(async (options) => {
      // The user renames the session mid-run, from another request.
      storedTitle = "Quarterly numbers";
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "12 rows" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "completed",
      };
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });

    // The chosen name survives: the write asked for `title: ""` and matched
    // nothing.
    expect(storedTitle).toBe("Quarterly numbers");
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1", title: "" },
      data: { title: "How many rows?" },
    });
    // …and the run still ends normally. A rename is not a supersede.
    expect(released).toEqual({ status: "IDLE", activeJobId: null });
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"idle"'),
    );
  });

  it("treats any non-completed stop reason as an error rather than a partial answer", async () => {
    runLoop.mockResolvedValueOnce({
      messages: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "max-iterations",
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
      data: { status: "ERROR", activeJobId: null },
    });
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"error"'),
    );
  });

  // Regression guard. CHAT_MAX_ITERATIONS counts COMPLETED dispatches, so a
  // provider request or a tool call that never resolves never trips it: without
  // a wall-clock bound the job — and the session claim it holds — stays RUNNING
  // forever and every later message in that conversation is blocked behind it.
  it("bounds the loop with a wall-clock deadline as well as an iteration cap", async () => {
    runLoop.mockResolvedValueOnce({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "completed",
    });
    await handleChatRunJob(fakeJob());
    expect(runLoop).toHaveBeenCalledWith(
      expect.objectContaining({ maxIterations: 3, timeoutMs: 300000 }),
    );
  });

  // ...and the expiry needs no handling of its own: `timeout` is simply not
  // `completed`, so it lands on the existing recoverable-ERROR path, which
  // clears `activeJobId` and releases the session for the next turn.
  it("routes an expired deadline through the recoverable error path", async () => {
    runLoop.mockResolvedValueOnce({
      messages: [],
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: "timeout",
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
      data: { status: "ERROR", activeJobId: null },
    });
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"error"'),
    );
  });

  it("passes the registered tool set through to the loop", async () => {
    runLoop.mockImplementationOnce(async (options) => {
      expect(options.tools.map((tool) => tool.name)).toEqual(["current_time"]);
      expect(options.resultStore).toBeDefined();
      return {
        messages: options.messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "completed",
      };
    });
    await handleChatRunJob(fakeJob());
    expect(runLoop).toHaveBeenCalledOnce();
  });

  // THE MASTER SWITCH HAS TO REACH THE QUEUE. The procedures refuse new turns
  // the moment `CHAT_ENABLED` flips, but a job committed a second earlier sits
  // in BullMQ across the whole deploy — so without a check here the switch stops
  // new work and pays for the backlog anyway.
  it("releases a queued turn without dispatching when chat has been disabled", async () => {
    const { env } = await import("@starter/env/shared");
    (env as { CHAT_ENABLED: boolean }).CHAT_ENABLED = false;
    try {
      await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
      expect(runLoop).not.toHaveBeenCalled();
      // ERROR, not a wedge at RUNNING: that is the state `chat.retry` accepts,
      // so the turn becomes recoverable the moment chat is switched back on
      // rather than waiting for the stale-run reaper to notice.
      expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
        where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
        data: { status: "ERROR", activeJobId: null },
      });
      expect(publish).toHaveBeenCalledWith(
        "chat:session-1",
        expect.stringContaining('"data":"error"'),
      );
    } finally {
      (env as { CHAT_ENABLED: boolean }).CHAT_ENABLED = true;
    }
  });

  it("skips a redundant retry after the turn was already answered", async () => {
    db.chatSession.findUnique.mockResolvedValue(
      baseSession({
        Messages: [
          ...baseSession().Messages,
          { id: "a", seq: 2, role: "ASSISTANT", parts: [], createdAt: new Date() },
        ],
      }),
    );
    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("claims the turn with a compare-and-set and skips when another job holds it", async () => {
    // A BullMQ attempt 2 and a user-driven `chat.retry` can reach the handler at
    // the same moment; the row update decides which one runs. The loser must
    // exit cleanly — throwing would queue yet another attempt at a turn that is
    // already being answered.
    db.chatSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-1",
        runGeneration: 1,
        OR: [{ activeJobId: null }, { activeJobId: "job-1" }],
      },
      data: { status: "RUNNING", activeJobId: "job-1" },
    });
    expect(runLoop).not.toHaveBeenCalled();
    // Losing the claim must not touch the winner's rows.
    expect(db.chatMessage.deleteMany).not.toHaveBeenCalled();
    expect(db.chatSession.update).not.toHaveBeenCalled();
    expect(db.chatSession.updateMany).toHaveBeenCalledOnce();
  });

  // THE MIDDLE OF THE RUN NEEDS THE OWNERSHIP PREDICATE TOO. Winning the claim
  // is a fact about one instant, not a lease: the reaper can release this
  // session while the loop is parked in an `await`, and the user's next
  // `send`/`retry` then hands the turn to a different job. The terminal writes
  // already refuse to land in that case — but nothing stopped the STREAMING
  // writes, so this run kept upserting rows into a session it no longer owned
  // and then promoted them to COMPLETE, leaving a stale duplicate answer
  // stamped final in the transcript plus every paid dispatch it took.
  it("stops writing as soon as the run is superseded mid-stream", async () => {
    // Owned on the first check, gone by the second — the reaper (or a newer
    // send) took the session while the answer was still growing.
    let ownershipChecks = 0;
    db.chatSession.count.mockImplementation(async () => (ownershipChecks++ === 0 ? 1 : 0));
    // …and the database agrees on the way out: the terminal compare-and-set
    // carries `activeJobId`, which no longer names this job, so it matches zero
    // rows. Layered over the allocator stub, which must keep working — the
    // `nextSeq` floor is deliberately NOT ownership-gated.
    // The RELEASE, not the claim: both carry a `status`, and only the release
    // clears `activeJobId`. Matching on `status` alone would fail the claim and
    // the run would never start, which is a different code path entirely.
    const trackedUpdateMany = db.chatSession.updateMany.getMockImplementation();
    db.chatSession.updateMany.mockImplementation(
      async (args: SessionUpdateArgs & { data?: { status?: string; activeJobId?: unknown } }) => {
        if (args.data?.status && args.data.activeJobId === null) return { count: 0 };
        return trackedUpdateMany?.(args) ?? { count: 1 };
      },
    );

    runLoop.mockImplementationOnce(async (options) => {
      const grow = async (content: string) => {
        // The handler throttles its re-check, so the clock has to move for the
        // second call to reach the database at all.
        vi.setSystemTime(Date.now() + 10_000);
        await options.onMessagesChange?.([
          ...options.messages,
          { id: "assistant-1", role: "assistant", parts: [{ type: "text", content }] },
        ]);
      };
      await grow("12 ro");
      await grow("12 rows");
      // The supersede aborts the loop; a real runtime reports that rather than
      // completing normally.
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: options.abortSignal?.aborted ? "aborted" : "completed",
      };
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    } finally {
      vi.useRealTimers();
    }

    // Only the first growth step was written. The second found the session gone
    // and returned before touching it.
    expect(db.chatMessage.upsert).toHaveBeenCalledOnce();
    // And the row was never promoted: a superseded run must not stamp `COMPLETE`
    // on content the conversation has moved past, because COMPLETE is what makes
    // a row a valid SSE resume point.
    expect(db.chatMessage.updateMany).not.toHaveBeenCalled();
    // No terminal frame either — a client is waiting on the NEWER run, and an
    // "error"/"idle" frame here would tell it to stop waiting.
    for (const [, payload] of publish.mock.calls) {
      expect(String(payload)).not.toContain('"type":"status"');
    }
  });

  // THE WRITE PATH IS NOT A HEARTBEAT. Hanging the ownership check off
  // `onMessagesChange` means it only fires while the answer is GROWING — and the
  // expensive parts of a turn grow nothing: a provider request in flight, a slow
  // tool call, a retry backoff. Delete a session during one of those and the run
  // kept its worker slot and kept spending until it happened to emit a message
  // or hit `CHAT_RUN_TIMEOUT_MS` — five minutes by default. So the check also
  // runs on its own timer.
  it("aborts a run whose session is deleted while the dispatch writes nothing", async () => {
    // The session is gone from the first poll onward. No `onMessagesChange` is
    // ever called here — that is the whole point of this test.
    db.chatSession.count.mockResolvedValue(0);
    const trackedUpdateMany = db.chatSession.updateMany.getMockImplementation();
    db.chatSession.updateMany.mockImplementation(
      async (args: SessionUpdateArgs & { data?: { status?: string; activeJobId?: unknown } }) => {
        if (args.data?.status && args.data.activeJobId === null) return { count: 0 };
        return trackedUpdateMany?.(args) ?? { count: 1 };
      },
    );

    runLoop.mockImplementationOnce(async (options) => {
      // A dispatch that emits nothing and resolves only once it is ABORTED —
      // the shape of a long provider call or a slow tool. It waits on the
      // signal, never on a clock, so nothing but the poller can end this run.
      await new Promise<void>((resolve) => {
        if (options.abortSignal?.aborted) return resolve();
        options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        messages: options.messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "aborted",
      };
    });

    // Drive the watchdog's interval by hand rather than waiting out five real
    // seconds. If the poller did not exist this would hang on the promise above
    // until vitest killed the test — which is exactly the production symptom.
    vi.useFakeTimers();
    const run = handleChatRunJob(fakeJob());
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(run).resolves.toEqual({ skipped: true });
    vi.useRealTimers();
    // The poller — not a write — is what noticed.
    expect(db.chatSession.count).toHaveBeenCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
    });
    expect(db.chatMessage.upsert).not.toHaveBeenCalled();
    expect(db.chatMessage.updateMany).not.toHaveBeenCalled();
  });

  // THE cursor invariant, and the reason `ChatSession.nextSeq` exists. A client
  // that watched the failed attempt holds `Last-Event-ID: 2` for the partial;
  // its reconnect replays `seq > 2`. Re-deriving the answer's seq from
  // `MAX(seq) + 1` after deleting the partial hands the replacement seq 2 again,
  // so that client never receives it and its transcript stays partial forever —
  // the best-effort Redis publish being its only delivery path. Seqs are
  // monotonic per session and never recycled; gaps are fine.
  it("replaces a previous attempt's partial answer on a FRESH seq, never the deleted one", async () => {
    db.chatSession.findUnique.mockResolvedValue(
      baseSession({
        status: "ERROR",
        Messages: [
          ...baseSession().Messages,
          {
            id: "partial",
            seq: 2,
            role: "ASSISTANT",
            parts: [{ type: "text", content: "12 ro" }],
            createdAt: new Date("2026-01-02"),
          },
        ],
      }),
    );
    runLoop.mockImplementationOnce(async (options) => {
      // The half-finished turn is not replayed to the model as a prior answer.
      expect(options.messages.map((message) => message.id)).toEqual(["message-1"]);
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-2", role: "assistant", parts: [{ type: "text", content: "12 rows" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "completed",
      };
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });
    expect(db.chatMessage.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "session-1", seq: { gt: 1 }, role: "ASSISTANT" },
    });
    // The partial at seq 2 is gone and the replacement lands at 3 — strictly
    // above anything any client can already have seen.
    expect(db.chatMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId_seq: { sessionId: "session-1", seq: 3 } } }),
    );
    const upsertCalls = db.chatMessage.upsert.mock.calls as [
      { where: { sessionId_seq: { seq: number } } },
    ][];
    const writtenSeqs = upsertCalls.map((call) => call[0].where.sessionId_seq.seq);
    expect(writtenSeqs).not.toContain(2);
  });

  // The delete must not lower the allocator either: a session whose allocator
  // already ran ahead of its rows (an earlier attempt that published chunks and
  // then failed before any upsert landed) must keep counting up from where it
  // was, not restart from `MAX(seq) + 1`.
  it("never lowers the seq allocator to fit the rows a retry deleted", async () => {
    db.chatSession.findUnique.mockResolvedValue(
      baseSession({
        status: "ERROR",
        nextSeq: 9,
        Messages: [
          ...baseSession().Messages,
          {
            id: "partial",
            seq: 2,
            role: "ASSISTANT",
            parts: [],
            createdAt: new Date("2026-01-02"),
          },
        ],
      }),
    );
    trackAllocator(9);
    runLoop.mockImplementationOnce(async (options) => {
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-2", role: "assistant", parts: [{ type: "text", content: "12 rows" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "completed",
      };
    });

    await handleChatRunJob(fakeJob());
    // The floor is a floor, never an assignment: 9 stands, so the answer is 9.
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1", nextSeq: { lt: 3 } },
      data: { nextSeq: 3 },
    });
    expect(db.chatMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId_seq: { sessionId: "session-1", seq: 9 } } }),
    );
  });

  // A stale job — one enqueued for a claim the session has since moved past —
  // must not be able to answer an old snapshot of the conversation. Its guards
  // above all read the snapshot it loaded, so the claim is the only place that
  // sees current state: without `runGeneration` in the predicate it finds
  // `activeJobId: null` (the new turn's claim leaves it null), wins, answers the
  // superseded question, locks the legitimate job out, and then sets the session
  // IDLE — the user's newest message is never answered.
  it("skips a job whose run generation the session has moved past", async () => {
    // Loaded before the new turn landed: the snapshot looks answerable.
    db.chatSession.findUnique.mockResolvedValue(baseSession({ status: "ERROR", runGeneration: 1 }));
    // The row as it is NOW: a newer `send` bumped the generation to 2 and left
    // `activeJobId` null.
    db.chatSession.updateMany.mockImplementation(
      async (args: { where?: { runGeneration?: number } }) => ({
        count: (args.where?.runGeneration ?? 2) === 2 ? 1 : 0,
      }),
    );

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(runLoop).not.toHaveBeenCalled();
    // Nothing of the current turn is touched — no rows cleared, no IDLE flip.
    expect(db.chatMessage.deleteMany).not.toHaveBeenCalled();
    expect(db.chatSession.update).not.toHaveBeenCalled();
    expect(db.chatSession.updateMany).toHaveBeenCalledOnce();
  });

  // ── EXITS ARE COMPARE-AND-SET TOO, NOT JUST ENTRIES ──────────────────────
  //
  // Winning the claim is a fact about one moment, not a lease. The stale-run
  // reaper can release this session while this job sits in a long `await`, and
  // the user can then `send` or `retry` — which bumps `runGeneration` and hands
  // the turn to a different job. An unconditional terminal `update` on the
  // session id at that point stamps THIS run's outcome onto the NEWER one: it
  // clears an `activeJobId` this job does not own (freeing the session for a
  // second concurrent run, which is the one-active-job invariant broken) and
  // leaves the newest turn showing a status that belongs to a dead run.
  //
  // So the terminal writes carry the same `runGeneration` + `activeJobId`
  // predicate as the claim, and a zero-row match is a NORMAL exit.

  /**
   * Let the claim (and the allocator floor) through, then fail every terminal
   * write — the row as it stands now belongs to a newer generation.
   */
  const supersedeAfterClaim = () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.chatSession.updateMany.mockImplementation(
      async (args: { where?: { OR?: unknown }; data?: { nextSeq?: unknown } }) => {
        // The claim (`OR: [{activeJobId: null}, …]`) and the monotonic nextSeq
        // floor still match; only the terminal write is superseded.
        if (args.where?.OR !== undefined || args.data?.nextSeq !== undefined) return { count: 1 };
        return { count: 0 };
      },
    );
  };

  /** Every session-row write that sets a terminal status, with its predicate. */
  const terminalWrites = () =>
    (
      db.chatSession.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: { status?: string } },
      ][]
    )
      .map((call) => call[0])
      .filter((args) => args.data.status === "IDLE" || args.data.status === "ERROR");

  it("does not stamp IDLE over a newer run when its own was superseded", async () => {
    supersedeAfterClaim();
    runLoop.mockImplementationOnce(async (options) => {
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "12 rows" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "completed",
      };
    });

    // Superseded is a clean exit, not a failure — nothing to retry.
    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });

    // The only terminal write is scoped to THIS job's generation and job id, so
    // it matched zero rows and the newer run's row is untouched.
    expect(terminalWrites()).toEqual([
      {
        where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
        data: { status: "IDLE", activeJobId: null },
      },
    ]);
    // The auto-title is guarded by the same claim predicate, so it matched zero
    // rows too — a superseded run does not rename the session either.
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1", title: "" },
      data: { title: "How many rows?" },
    });
    // …and no plain `update` slipped past the predicate. (`update` is the
    // allocator's atomic increment, which is monotonic and safe by construction;
    // what must never appear is a status/activeJobId write through it.)
    for (const call of db.chatSession.update.mock.calls as [{ data: Record<string, unknown> }][]) {
      expect(call[0].data).toEqual({ nextSeq: { increment: 1 } });
    }
    // A terminal `status` frame would tell a connected client to stop waiting
    // for the answer the NEWER run is still producing.
    expect(publish).not.toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"type":"status"'),
    );
  });

  it("does not stamp ERROR over a newer run when its own was superseded", async () => {
    supersedeAfterClaim();
    runLoop.mockResolvedValueOnce({
      messages: [],
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: "timeout",
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(terminalWrites()).toEqual([
      {
        where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
        data: { status: "ERROR", activeJobId: null },
      },
    ]);
    expect(publish).not.toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"error"'),
    );
  });

  // The failure path is the sharpest one: it both writes ERROR and rethrows to
  // buy a BullMQ attempt 2. A superseded job must do neither — attempt 2 would
  // only lose the claim and skip, and the ERROR belongs to a run nobody is
  // waiting on.
  it("neither reports nor retries a superseded run that failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    supersedeAfterClaim();
    runLoop.mockRejectedValueOnce(
      new AgentRuntimeError("rate limited", { retryable: true, status: 429 }),
    );

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(terminalWrites()).toEqual([
      {
        where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
        data: { status: "ERROR", activeJobId: null },
      },
    ]);
    expect(publish).not.toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"error"'),
    );
  });

  it("skips a turn a newer user message has superseded, without deleting it", async () => {
    db.chatSession.findUnique.mockResolvedValue(
      baseSession({
        status: "RUNNING",
        Messages: [
          ...baseSession().Messages,
          {
            id: "partial",
            seq: 2,
            role: "ASSISTANT",
            parts: [],
            createdAt: new Date("2026-01-02"),
          },
          {
            id: "message-3",
            seq: 3,
            role: "USER",
            parts: [{ type: "text", content: "never mind" }],
            createdAt: new Date("2026-01-03"),
          },
        ],
      }),
    );

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(runLoop).not.toHaveBeenCalled();
    expect(db.chatMessage.deleteMany).not.toHaveBeenCalled();
    // Skipped BEFORE the claim, so the job answering the current turn can take it.
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
  });

  it("skips a session deleted between enqueue and pickup", async () => {
    db.chatSession.findUnique.mockResolvedValue(null);
    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: true });
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("rejects an off-schema payload loudly instead of answering a half-identified turn", async () => {
    // Missing `runGeneration` — the payload drift an older deploy (or a
    // hand-added job) could carry. The parse must fail before any DB work: a
    // wrong generation would let this job claim a run that is not its own.
    await expect(
      handleChatRunJob({
        id: "job-1",
        data: { sessionId: "session-1", userMessageSeq: 1 },
      } as never),
    ).rejects.toThrow(ZodError);
    expect(db.chatSession.findUnique).not.toHaveBeenCalled();
  });

  it("marks ERROR and rethrows a retryable runtime error so BullMQ retries it", async () => {
    runLoop.mockRejectedValueOnce(
      new AgentRuntimeError("rate limited", { retryable: true, status: 429 }),
    );
    await expect(handleChatRunJob(fakeJob())).rejects.toMatchObject({ retryable: true });
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
      data: { status: "ERROR", activeJobId: null },
    });
    expect(publish).toHaveBeenCalledWith(
      "chat:session-1",
      expect.stringContaining('"data":"error"'),
    );
  });

  it("records but does not rethrow a non-retryable failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runLoop.mockRejectedValueOnce(new Error("tool blew up"));
    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "session-1", runGeneration: 1, activeJobId: "job-1" },
      data: { status: "ERROR", activeJobId: null },
    });
  });

  it("survives a failed publish because Postgres is authoritative", async () => {
    publish.mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runLoop.mockImplementationOnce(async (options) => {
      await options.onMessagesChange?.([
        ...options.messages,
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "answer" }] },
      ]);
      return {
        messages: options.messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "completed",
      };
    });

    await expect(handleChatRunJob(fakeJob())).resolves.toEqual({ skipped: false });
    expect(db.chatMessage.upsert).toHaveBeenCalledOnce();
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IDLE" }) }),
    );
  });
});
