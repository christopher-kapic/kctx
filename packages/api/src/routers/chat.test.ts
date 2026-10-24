import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@starter/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// `@starter/queue` must be mocked: its real module constructs BullMQ Queues at
// import, which open IORedis sockets and hang in CI.
vi.mock("@starter/queue", async () => {
  // `chatRunJobId` is the Redis-free half of the package, so the router gets the
  // real derivation — a stub here would let a cancel target the wrong job id and
  // still pass.
  const { chatRunJobId } = await import("@starter/queue/jobs");
  return {
    enqueueChatRun: vi.fn().mockResolvedValue(undefined),
    cancelChatRun: vi.fn().mockResolvedValue(true),
    chatRunJobId,
    // `send` / `retry` announce an accepted claim to the OTHER clients watching
    // the same conversation. Best-effort, so a missing stub would be swallowed
    // and the assertions below would silently prove nothing.
    redisConnection: { publish: vi.fn().mockResolvedValue(1) },
  };
});
vi.mock("@starter/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));
// Chat is gated on BOTH of these — see `lib/chat-enabled.ts`. The default here
// is the configured deployment; the gate itself is covered below.
vi.mock("@starter/env/shared", () => ({
  env: { CHAT_ENABLED: true, OPENROUTER_API_KEY: "test-key" },
}));
// The spend limiter builds a Redis-backed limiter at module load; its own
// behaviour is covered in `lib/chat-rate-limit.test.ts`. Here it is the seam
// the router must actually go through.
vi.mock("../lib/chat-rate-limit", () => ({
  consumeChatSendBudget: vi.fn().mockResolvedValue(undefined),
  consumeChatSessionBudget: vi.fn().mockResolvedValue(undefined),
}));

const { default: db } = await import("@starter/db");
const { consumeChatSendBudget, consumeChatSessionBudget } = await import("../lib/chat-rate-limit");
const { enqueueChatRun, cancelChatRun, redisConnection } = await import("@starter/queue");
const publish = vi.mocked(redisConnection.publish);
// NOT mocked: `@starter/queue/jobs` is the Redis-free half of the package, so
// the real job-id derivation is available to assert against.
const { chatRunJobId } = await import("@starter/queue/jobs");
const { chatRouter } = await import("./chat");

const now = new Date("2026-07-12T00:00:00Z");
const chatSession = (overrides: Record<string, unknown> = {}) => ({
  id: "chat-1",
  createdAt: now,
  updatedAt: now,
  ownerId: "test-user-id",
  // "" is the stored "unset" title — locale-neutral, never an English string.
  title: "",
  status: "IDLE",
  activeJobId: null,
  runGeneration: 0,
  nextSeq: 0,
  ...overrides,
});

function client() {
  const context: Context = {
    session: {
      user: {
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: "auth-session",
        userId: "test-user-id",
        token: "token",
        expiresAt: new Date("2027-01-01"),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
        updatedAt: now,
      },
    } as Session,
  };
  return createRouterClient(chatRouter, { context });
}

async function expectNotFound(action: () => Promise<unknown>) {
  await expect(action()).rejects.toSatisfy((error: ORPCError) => error.code === "NOT_FOUND");
}

describe("chatRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `protectedProcedure` runs the forced-2FA policy, which reads AppSetting.
    db.appSetting.findMany.mockResolvedValue([]);
  });

  // The gate is enforced at the PROCEDURE boundary, not only in the UI. Without
  // it a misconfigured deployment accepts a whole turn — a session row, a user
  // message, a RUNNING claim, a queued job — and only fails minutes later inside
  // the worker, where the user sees an unexplained "Response interrupted" and a
  // Retry that can never succeed.
  // Only the tab that submitted the turn flips its own state. Without this frame
  // every OTHER tab or device on the same conversation keeps an IDLE status and
  // an enabled composer for the whole answer, and its next send fails with the
  // server's "wait for the current response" conflict — an error the server
  // could have stopped them from ever attempting.
  it("announces an accepted turn to the other clients watching the session", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 1 }));
    db.chatMessage.aggregate.mockResolvedValue({ _max: { seq: 4 } });
    db.chatMessage.create.mockResolvedValue({
      id: "message-5",
      createdAt: now,
      updatedAt: now,
      sessionId: "chat-1",
      seq: 5,
      role: "USER",
      parts: [],
    });

    await client().send({ sessionId: "chat-1", text: "hello" });

    expect(publish).toHaveBeenCalledWith(
      "chat:chat-1",
      expect.stringContaining('"data":"running"'),
    );
    // AFTER the enqueue: an enqueue that throws releases the claim back to
    // ERROR, and a frame published before that would leave every other tab
    // waiting on an answer that was never going to come.
    const publishOrder = publish.mock.invocationCallOrder[0] ?? 0;
    const enqueueOrder = vi.mocked(enqueueChatRun).mock.invocationCallOrder[0] ?? 0;
    expect(publishOrder).toBeGreaterThan(enqueueOrder);
  });

  it("refuses every spending procedure when chat is not enabled", async () => {
    const { env } = await import("@starter/env/shared");
    (env as { CHAT_ENABLED: boolean }).CHAT_ENABLED = false;
    try {
      const api = client();
      for (const action of [
        () => api.createSession(),
        () => api.send({ sessionId: "chat-1", text: "hi" }),
        () => api.retry({ sessionId: "chat-1" }),
      ]) {
        await expect(action()).rejects.toSatisfy(
          (error: ORPCError) => error.code === "SERVICE_UNAVAILABLE",
        );
      }
      // Nothing committed and nothing queued — the refusal is at the edge.
      expect(db.chatSession.create).not.toHaveBeenCalled();
      expect(enqueueChatRun).not.toHaveBeenCalled();
      await expect(api.config()).resolves.toEqual({ enabled: false });
    } finally {
      (env as { CHAT_ENABLED: boolean }).CHAT_ENABLED = true;
    }
  });

  it("reports itself enabled when configured", async () => {
    await expect(client().config()).resolves.toEqual({ enabled: true });
  });

  it("creates an owner-scoped session with a serialized status", async () => {
    db.chatSession.create.mockResolvedValue(chatSession());

    await expect(client().createSession()).resolves.toMatchObject({
      id: "chat-1",
      status: "IDLE",
    });
    // The title is stored as the locale-neutral "unset" sentinel. Persisting
    // the literal "New chat" renders that English string for every locale — in
    // the page header and the session rail — and it stays there indefinitely if
    // the first run fails before the worker ever auto-titles. The words belong
    // to the locale bundle (`chat:sessions.untitled`), not the database.
    expect(db.chatSession.create).toHaveBeenCalledWith({
      data: { ownerId: "test-user-id", title: "", status: "IDLE" },
      select: {
        id: true,
        title: true,
        status: true,
      },
    });
  });

  // Sessions are metered on their OWN bucket. Creating one costs a row and no
  // model call, so the spend budget never sees it — leaving row creation
  // bounded by nothing at all for a client that never sends a message.
  it("charges the session budget before writing the row", async () => {
    const order: string[] = [];
    vi.mocked(consumeChatSessionBudget).mockImplementationOnce(async () => {
      order.push("budget");
    });
    db.chatSession.create.mockImplementation(async () => {
      order.push("create");
      return chatSession();
    });

    await client().createSession();
    expect(order).toEqual(["budget", "create"]);
  });

  it("does not write a row the session budget refused", async () => {
    vi.mocked(consumeChatSessionBudget).mockRejectedValueOnce(new Error("over budget"));

    await expect(client().createSession()).rejects.toThrow();
    expect(db.chatSession.create).not.toHaveBeenCalled();
  });

  // Deleting is allowed while RUNNING — an unanswerable conversation is exactly
  // the one a user most wants gone, and a wedged session would otherwise become
  // undeletable. So the queued work is withdrawn beneath it instead: a job still
  // WAITING has dispatched nothing, and removing it saves the whole run.
  it("cancels the queued run before deleting a session", async () => {
    const order: string[] = [];
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "RUNNING" }));
    db.chatSession.findUnique.mockResolvedValue({ activeJobId: null, runGeneration: 3 });
    db.chatMessage.findFirst.mockResolvedValue({ seq: 7 });
    vi.mocked(cancelChatRun).mockImplementation(async (id: string) => {
      order.push(`cancel:${id}`);
      return true;
    });
    db.chatSession.delete.mockImplementation(async () => {
      order.push("delete");
      return chatSession();
    });

    await expect(client().deleteSession({ sessionId: "chat-1" })).resolves.toEqual({
      success: true,
    });
    // The id is DERIVED, not stubbed: `activeJobId` is null for the whole window
    // between the claim and a worker picking the job up, which is precisely when
    // cancelling is worth the most.
    expect(order).toEqual([
      `cancel:${chatRunJobId({ sessionId: "chat-1", userMessageSeq: 7, runGeneration: 3 })}`,
      "delete",
    ]);
  });

  it("still deletes the session when the run could not be cancelled", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "RUNNING" }));
    db.chatSession.findUnique.mockResolvedValue({ activeJobId: "job-x", runGeneration: 1 });
    db.chatMessage.findFirst.mockResolvedValue(null);
    // BullMQ refuses to remove a locked (ACTIVE) job. The user's actual request
    // is to delete the conversation; failing that over queue bookkeeping would
    // leave them stuck. The handler's own ownership re-check ends the run.
    vi.mocked(cancelChatRun).mockResolvedValueOnce(false);
    db.chatSession.delete.mockResolvedValue(chatSession());

    await expect(client().deleteSession({ sessionId: "chat-1" })).resolves.toEqual({
      success: true,
    });
    expect(cancelChatRun).toHaveBeenCalledWith("job-x");
    expect(db.chatSession.delete).toHaveBeenCalled();
  });

  it("scopes session listing to the caller and paginates on a total order", async () => {
    db.chatSession.findMany.mockResolvedValue([chatSession({ futureSecret: "must-not-leak" })]);
    const result = await client().listSessions({ limit: 20 });
    // `updatedAt` is fetched to anchor the cursor but must not reach the client.
    expect(result.items).toEqual([{ id: "chat-1", title: "", status: "IDLE" }]);
    expect(result.nextCursor).toBeNull();
    expect(db.chatSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ ownerId: "test-user-id" }] },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
        },
      }),
    );
    expect(db.chatSession.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ cursor: expect.anything() }),
    );
  });

  // A Prisma `cursor: { id }` needs the cursor row to still exist. Deleting the
  // session that anchored page 1 used to make page 2 come back empty, which the
  // client reads as "end of list". The keyset compares (updatedAt, id) values,
  // so the boundary survives the row.
  it("keeps the owner scope and pages past a cursor row that was deleted", async () => {
    db.chatSession.findMany.mockResolvedValue([
      chatSession({ id: "chat-2" }),
      chatSession({ id: "chat-1" }),
    ]);
    const first = await client().listSessions({ limit: 1 });
    expect(first.items.map(({ id }) => id)).toEqual(["chat-2"]);
    expect(first.nextCursor).toBeTruthy();

    db.chatSession.findMany.mockResolvedValue([chatSession({ id: "chat-1" })]);
    const second = await client().listSessions({ limit: 1, cursor: first.nextCursor as string });
    expect(second.items.map(({ id }) => id)).toEqual(["chat-1"]);
    expect(db.chatSession.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { ownerId: "test-user-id" },
            { OR: [{ updatedAt: { lt: now } }, { updatedAt: now, id: { lt: "chat-2" } }] },
          ],
        },
      }),
    );
  });

  it("rejects a malformed pagination cursor as input validation, not a 500", async () => {
    await expect(client().listSessions({ limit: 20, cursor: "not-a-token" })).rejects.toThrow();
  });

  it("hides foreign sessions across every procedure and never enqueues", async () => {
    db.chatSession.findFirst.mockResolvedValue(null);
    const api = client();
    const actions = [
      () => api.getSession({ id: "foreign" }),
      () => api.listMessages({ sessionId: "foreign" }),
      () => api.renameSession({ sessionId: "foreign", title: "Title" }),
      () => api.deleteSession({ sessionId: "foreign" }),
      () => api.send({ sessionId: "foreign", text: "hello" }),
      () => api.retry({ sessionId: "foreign" }),
    ];
    for (const action of actions) await expectNotFound(action);
    expect(enqueueChatRun).not.toHaveBeenCalled();
  });

  const chatMessage = (seq: number, overrides: Record<string, unknown> = {}) => ({
    id: `message-${seq}`,
    createdAt: now,
    updatedAt: now,
    sessionId: "chat-1",
    seq,
    role: "USER",
    state: "COMPLETE",
    parts: [],
    ...overrides,
  });

  it("pages older messages from an exclusive seq cursor, returning them ascending", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    // Selected newest-first by the query…
    db.chatMessage.findMany.mockResolvedValue([
      chatMessage(9, { futureSecret: "must-not-leak" }),
      chatMessage(8),
    ]);
    const result = await client().listMessages({ sessionId: "chat-1", cursor: 10, limit: 50 });
    // …and handed back oldest-first, which is the order a transcript renders in.
    expect(result.items.map((item) => item.seq)).toEqual([8, 9]);
    expect(result.items[0]?.role).toBe("USER");
    // The client picks its SSE replay cursor from these rows and may only
    // resume from a FINAL one, so the state has to survive the boundary.
    expect(result.items[0]?.state).toBe("COMPLETE");
    expect(result.items[1]).toEqual({
      id: "message-9",
      seq: 9,
      role: "USER",
      state: "COMPLETE",
      parts: [],
    });
    // `lt`, not `gt`: the cursor is the oldest seq the client already holds and
    // paging walks BACKWARDS toward the start of the conversation.
    expect(db.chatMessage.findMany).toHaveBeenCalledWith({
      where: { sessionId: "chat-1", seq: { lt: 10 } },
      orderBy: { seq: "desc" },
      take: 51,
      select: {
        id: true,
        seq: true,
        role: true,
        state: true,
        parts: true,
      },
    });
  });

  // THE REGRESSION. `listMessages` used to page FORWARD from seq 0, so the
  // single page a client fetches was the OLDEST `limit` rows and everything
  // after them was reachable only by walking every intervening page — which the
  // transcript never did. Past the first page the newest turns simply never
  // rendered, and the user's OWN messages are the ones that never came back:
  // nothing publishes them on the SSE stream, so this query (or a reconnect's
  // replay, whose cursor has long since moved past them) is their only route to
  // the browser. The first page must be the END of the conversation.
  it("returns the NEWEST page when no cursor is supplied, and points at the older one", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    // A session of 120 messages, limit 2: the rows the DB returns are the two
    // newest plus the lookahead that proves there is more below them.
    db.chatMessage.findMany.mockResolvedValue([
      chatMessage(119),
      chatMessage(118),
      chatMessage(117),
    ]);

    const result = await client().listMessages({ sessionId: "chat-1", limit: 2 });

    expect(result.items.map((item) => item.seq)).toEqual([118, 119]);
    // The next page is everything strictly BELOW this page's lowest seq, so the
    // pages tile the transcript without a gap and without a repeat.
    expect(result.nextCursor).toBe(118);
    expect(db.chatMessage.findMany).toHaveBeenCalledWith({
      where: { sessionId: "chat-1" },
      orderBy: { seq: "desc" },
      take: 3,
      select: {
        id: true,
        seq: true,
        role: true,
        state: true,
        parts: true,
      },
    });
  });

  it("stops paging at the start of the conversation", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.chatMessage.findMany.mockResolvedValue([chatMessage(1), chatMessage(0)]);

    const result = await client().listMessages({ sessionId: "chat-1", cursor: 2, limit: 50 });
    expect(result.items.map((item) => item.seq)).toEqual([0, 1]);
    // No lookahead row: seq 0 is the first message of the session, so there is
    // nothing older and the client stops asking.
    expect(result.nextCursor).toBeUndefined();
  });

  it("persists a send with the AgentMessagePart shape and a deterministic enqueue", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 1 }));
    db.chatMessage.aggregate.mockResolvedValue({ _max: { seq: 4 } });
    db.chatMessage.create.mockResolvedValue({
      id: "message-5",
      createdAt: now,
      updatedAt: now,
      sessionId: "chat-1",
      seq: 5,
      role: "USER",
      parts: [],
    });

    await expect(client().send({ sessionId: "chat-1", text: "hello" })).resolves.toEqual({
      userMessageSeq: 5,
    });
    // The conditional claim IS the one-active-job invariant.
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: "chat-1", ownerId: "test-user-id", status: { not: "RUNNING" } },
      // `activeJobId: null` — claiming means no job owns the session yet, which
      // is exactly what the worker's compare-and-set claims against. The
      // generation bump rides along in the same statement so one claim can only
      // ever hand out one job id.
      data: { status: "RUNNING", activeJobId: null, runGeneration: { increment: 1 } },
    });
    // `content`, not `text` — the worker feeds these parts straight to the model.
    expect(db.chatMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: "chat-1",
        seq: 5,
        role: "USER",
        parts: [{ type: "text", content: "hello" }],
      },
    });
    expect(enqueueChatRun).toHaveBeenCalledWith({
      sessionId: "chat-1",
      userMessageSeq: 5,
      runGeneration: 1,
    });
    // The allocator moves with the row it handed out, in the same transaction.
    expect(db.chatSession.update).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { nextSeq: 6 },
    });
  });

  // Cursors are monotonic per session and are NEVER recycled. The worker clears
  // a failed attempt's partial assistant rows, so `MAX(seq) + 1` can point back
  // at a seq a client already holds as its `Last-Event-ID` — and its replay
  // (`seq > cursor`) would then skip this message forever. The persisted
  // allocator is the floor that makes that impossible; `MAX(seq) + 1` survives
  // only as the fallback for sessions that predate the column.
  it("allocates a user seq from the session allocator, above any deleted rows", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    // The allocator ran ahead: seqs 5..8 were handed out and their rows deleted.
    db.chatSession.findUniqueOrThrow.mockResolvedValue(
      chatSession({ runGeneration: 1, nextSeq: 9 }),
    );
    db.chatMessage.aggregate.mockResolvedValue({ _max: { seq: 4 } });
    db.chatMessage.create.mockResolvedValue({
      id: "message-9",
      createdAt: now,
      updatedAt: now,
      sessionId: "chat-1",
      seq: 9,
      role: "USER",
      parts: [],
    });

    await expect(client().send({ sessionId: "chat-1", text: "hello" })).resolves.toEqual({
      userMessageSeq: 9,
    });
    expect(db.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seq: 9 }) }),
    );
    expect(db.chatSession.update).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { nextSeq: 10 },
    });
  });

  it("hands the session back as ERROR when the enqueue fails, so the user can retry", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 1 }));
    db.chatMessage.aggregate.mockResolvedValue({ _max: { seq: 4 } });
    db.chatMessage.create.mockResolvedValue({
      id: "message-5",
      createdAt: now,
      updatedAt: now,
      sessionId: "chat-1",
      seq: 5,
      role: "USER",
      parts: [],
    });
    vi.mocked(enqueueChatRun).mockRejectedValueOnce(new Error("redis unreachable"));

    // The original failure still reaches the caller — it is never swallowed.
    await expect(client().send({ sessionId: "chat-1", text: "hello" })).rejects.toThrow(
      "redis unreachable",
    );
    // …and the claim taken by the (already committed) transaction is released to
    // ERROR, the only status `retry` accepts. Left RUNNING, the session would be
    // unrecoverable: the composer stays disabled and `retry` refuses.
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "chat-1", ownerId: "test-user-id", status: "RUNNING", activeJobId: null },
      data: { status: "ERROR", activeJobId: null },
    });
  });

  it("releases the claim when a retry's enqueue fails too", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "ERROR" }));
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatMessage.findFirst.mockResolvedValue({ seq: 7 });
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 1 }));
    vi.mocked(enqueueChatRun).mockRejectedValueOnce(new Error("redis unreachable"));

    await expect(client().retry({ sessionId: "chat-1" })).rejects.toThrow("redis unreachable");
    expect(db.chatSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: "chat-1", ownerId: "test-user-id", status: "RUNNING", activeJobId: null },
      data: { status: "ERROR", activeJobId: null },
    });
  });

  it("rejects a concurrent send without persisting or enqueueing", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "RUNNING" }));
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(client().send({ sessionId: "chat-1", text: "hello" })).rejects.toSatisfy(
      (error: ORPCError) => error.code === "CONFLICT",
    );
    expect(db.chatMessage.create).not.toHaveBeenCalled();
    expect(enqueueChatRun).not.toHaveBeenCalled();
  });

  it("retries only failed runs, claiming atomically with a generation bump", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "ERROR" }));
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatMessage.findFirst.mockResolvedValue({ seq: 7 });
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 3 }));

    await expect(client().retry({ sessionId: "chat-1" })).resolves.toEqual({ userMessageSeq: 7 });
    // Conditional on ERROR: the status check before the transaction is a
    // read-then-write, so this is what stops two Retry clicks both claiming.
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: "chat-1", ownerId: "test-user-id", status: "ERROR" },
      data: { status: "RUNNING", activeJobId: null, runGeneration: { increment: 1 } },
    });
    expect(enqueueChatRun).toHaveBeenCalledWith({
      sessionId: "chat-1",
      userMessageSeq: 7,
      runGeneration: 3,
    });

    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "IDLE" }));
    await expect(client().retry({ sessionId: "chat-1" })).rejects.toSatisfy(
      (error: ORPCError) => error.code === "CONFLICT",
    );
  });

  it("rejects a retry that loses the claim race, without enqueueing", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "ERROR" }));
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatMessage.findFirst.mockResolvedValue({ seq: 7 });
    // The rival retry got there first: the row is no longer ERROR.
    db.chatSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(client().retry({ sessionId: "chat-1" })).rejects.toSatisfy(
      (error: ORPCError) => error.code === "CONFLICT",
    );
    expect(enqueueChatRun).not.toHaveBeenCalled();
  });

  // The regression this whole generation counter exists for. A run that fails
  // BEFORE persisting any assistant row — missing OPENROUTER_API_KEY, an auth
  // rejection, a network failure on the first dispatch — leaves the transcript
  // exactly as the previous attempt did. Anything derived from those rows
  // therefore repeats itself, BullMQ's `add()` silently dedupes against the
  // failed job it retains for 24h, and the session is left RUNNING with nothing
  // queued to answer it: wedged, with the enqueue-failure release path never
  // firing because `add()` did not throw.
  it("mints a distinct job id for every retry of a run that persisted nothing", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "ERROR" }));
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatMessage.findFirst.mockResolvedValue({ seq: 7 });
    // Zero assistant rows, before and after each failed attempt.
    db.chatMessage.count.mockResolvedValue(0);
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    // Postgres increments the counter on each claim; nothing else about the
    // session changes between the two retries.
    let runGeneration = 0;
    db.chatSession.findUniqueOrThrow.mockImplementation(async () => {
      runGeneration += 1;
      return chatSession({ status: "RUNNING", runGeneration });
    });

    await client().retry({ sessionId: "chat-1" });
    await client().retry({ sessionId: "chat-1" });

    // The real id derivation, not a copy of it — a re-`add()` under an id that
    // already exists is exactly what BullMQ swallows.
    const jobIds = vi.mocked(enqueueChatRun).mock.calls.map(([data]) => chatRunJobId(data));
    expect(jobIds).toHaveLength(2);
    expect(new Set(jobIds).size).toBe(2);
  });

  // THE SPEND CEILING. `send` and `retry` each queue a run worth up to
  // CHAT_MAX_ITERATIONS paid model dispatches, and the worker's concurrency
  // limit only QUEUES the excess — it never sheds it. The generic 100/min
  // `/rpc/*` limiter counts requests, cannot see a batched POST carrying many
  // sends, and cannot tell a send from a `listMessages`, so on its own one
  // signed-in client can build an indefinitely growing, expensive backlog.
  // These two procedures are the only ones here that spend, so they are the
  // only ones metered.
  it("charges the per-user spend budget for every accepted turn", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 1 }));
    db.chatMessage.aggregate.mockResolvedValue({ _max: { seq: 4 } });
    db.chatMessage.create.mockResolvedValue(chatMessage(5));

    await client().send({ sessionId: "chat-1", text: "hello" });
    expect(consumeChatSendBudget).toHaveBeenCalledWith("test-user-id");

    vi.mocked(consumeChatSendBudget).mockClear();
    db.chatSession.findFirst.mockResolvedValue(chatSession({ status: "ERROR" }));
    db.chatMessage.findFirst.mockResolvedValue(chatMessage(7));
    await client().retry({ sessionId: "chat-1" });
    // Same bucket as `send`: a retry queues the identical run.
    expect(consumeChatSendBudget).toHaveBeenCalledWith("test-user-id");
  });

  it("does not claim, persist, or enqueue a turn the spend budget refused", async () => {
    db.chatSession.findFirst.mockResolvedValue(chatSession());
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUniqueOrThrow.mockResolvedValue(chatSession({ runGeneration: 1 }));
    db.chatMessage.aggregate.mockResolvedValue({ _max: { seq: 4 } });
    vi.mocked(consumeChatSendBudget).mockRejectedValueOnce(
      new ORPCError("TOO_MANY_REQUESTS", { message: "slow down" }),
    );

    await expect(client().send({ sessionId: "chat-1", text: "hello" })).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "TOO_MANY_REQUESTS",
    );
    // Refused BEFORE the claim, so there is no RUNNING session to release and
    // no user message written for a run that will never happen.
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
    expect(db.chatMessage.create).not.toHaveBeenCalled();
    expect(enqueueChatRun).not.toHaveBeenCalled();
  });
});
