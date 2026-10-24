# Durable server→client streaming (SSE + replay)

Stream events from a background process to a browser so that a refresh, a sleeping laptop, a proxy killing an idle connection, a Redis blip, or a server restart costs **nothing**. The client reconnects with a cursor and receives exactly what it missed.

The template's first consumer is chat (`apps/server/src/chat-routes.ts`, `apps/server/src/chat-subscriber.ts`, `apps/worker/src/handlers/chat-run.ts`), but nothing about the shape is chat-specific — it is the answer to "a long job needs to show a browser what it is doing, live, without losing anything". Read this before you write a second one; the last section is about generalizing it.

## The one invariant

**Postgres is authoritative; Redis pub/sub is best-effort.**

Every event a client can receive is written to a durable row, under a monotonically increasing per-stream cursor, **before** it is published. Nothing rides on Redis alone. Consequences worth stating out loud, because each one is a decision people get backwards:

> **And its sharper half, which costs three separate bugs to learn:** a cursor the client can resume from must name a row that is **final**, not merely durable. See [An `id:` promises finality, not merely durability](#an-id-promises-finality-not-merely-durability) — read it before you write the producer, not after.

- A failed publish is a **non-event**. Log it, swallow it, carry on — the next reconnect's replay repairs the gap.
- A failed **write** takes the producer down. Never invert those two.
- The published frame is never the source of truth. It is a latency optimization over "poll the table".
- Delivery is therefore **at-most-once live, exactly-once after replay**. The system is lossless because the reader re-reads, not because the transport is reliable.

```
producer (worker)                  server                       browser
──────────────────                 ──────────────────           ──────────────
1. INSERT/UPSERT row (seq N)  ──▶  Postgres
2. PUBLISH chat:<id> {seq N}  ──▶  Redis  ──▶  psubscribe  ──▶  SSE  (no id yet)
3. row N is final             ──▶  Postgres (state=COMPLETE)
4. PUBLISH {seq N, COMPLETE}  ──▶  Redis  ──▶  psubscribe  ──▶  SSE  id: N
                                   ▲
   reconnect: GET /stream ─────────┘  replay WHERE seq > Last-Event-ID
                                      (id: only on rows that are COMPLETE)
```

## The three moving parts

| Part | File (chat) | Job |
| --- | --- | --- |
| Producer | `apps/worker/src/handlers/chat-run.ts` | Persist, then publish. Never the other order. |
| Fan-out | `apps/server/src/chat-subscriber.ts` | One process-wide `psubscribe`, demultiplexed in memory. |
| Reader | `apps/server/src/chat-routes.ts` | Auth, replay from the cursor, then switch to live. |

## Producer: persist, then publish

```ts
// apps/worker/src/handlers/chat-run.ts
const publish = async (sessionId: string, event: StreamEvent): Promise<void> => {
  try {
    await redisConnection.publish(`chat:${sessionId}`, JSON.stringify(event));
  } catch (error) {
    console.warn("[chat-run] Redis publish failed; persistence remains authoritative", error);
  }
};

// …inside the run:
await prisma.chatMessage.upsert({
  where: { sessionId_seq: { sessionId, seq } },   // ← the unique constraint
  //                    STREAMING: durable, but NOT final. ↓
  create: { sessionId, seq, role: "ASSISTANT", state: "STREAMING", parts },
  update: { state: "STREAMING", parts },
});
// Published only AFTER the write. A subscriber can never see an event that is
// not already recoverable from Postgres. The frame carries the row's state,
// which is what tells the reader it may NOT stamp an `id:` on this one.
await publish(sessionId, { type: "message", seq, state: "STREAMING", data: message });

// …and once the turn is over, in one pass: the rows stop moving, so now — and
// only now — they may become resume points.
await prisma.chatMessage.updateMany({
  where: { sessionId, seq: { in: writtenSeqs } },
  data: { state: "COMPLETE" },
});
for (const [seq, message] of streamedRows) {
  await publish(sessionId, { type: "message", seq, state: "COMPLETE", data: message });
}
```

Three things carry weight here.

**`upsert`, not `create`.** A streaming producer reports the same logical item repeatedly as it grows, so every report after the first lands on a row that already exists; it must converge on one row rather than appending a duplicate per token. `@@unique([sessionId, seq])` is what enforces that, and it is also the backstop that keeps a claim-losing straggler from writing a second copy (see [queue § Adding a new job](./queue.md#adding-a-new-job)). Note what it is *not*: a retried job does **not** reuse its predecessor's cursor — it allocates fresh ones, strictly above everything already emitted. See [Deleting a row must not lower the allocator](#deleting-a-row-must-not-lower-the-allocator).

**The publish is wrapped and swallowed.** The `try/catch` is the durability contract expressed in code: Redis being down degrades liveness, never correctness.

**Completeness is state on the row, not a fact in the producer's memory.** The process that serves a replay is not the process that did the streaming — it may be a different replica, or the same one an hour after a crash. A `mid-stream?` flag held in the worker cannot be consulted by the reader, so a partial left by a dead producer would replay as though it were finished. One additive enum column with a default (`STREAMING` / `COMPLETE`) is the whole mechanism, and it is compatible under a `prisma db push` model precisely because every row that predates it *is* finished — so the default is `COMPLETE`, and the streaming producer is the only writer that opts out of it. Note this is an **enum, not a Boolean**: it is app-owned state that plausibly grows a third member, which is the repo's standing rule (see [schema-guidelines](./schema-guidelines.md)).

## The cursor

```prisma
model ChatMessage {
  sessionId String
  /// Monotonic per-session cursor. LOAD-BEARING: it is the SSE `id:` field, the
  /// `Last-Event-ID` replay cursor, and the upsert key the worker writes
  /// streaming assistant turns under.
  seq   Int
  /// Is this row FINAL? Only a COMPLETE row may carry an `id:` — the same seq is
  /// rewritten repeatedly while the answer streams. Additive, defaulted to
  /// COMPLETE (every row that predates the column is a finished message).
  state ChatMessageState @default(COMPLETE)
  @@unique([sessionId, seq])
}
```

The cursor must be:

- **Monotonic per stream, and never recycled** — the replay is `WHERE seq > cursor ORDER BY seq ASC`. Ordering that ties (a `createdAt` timestamp when several producers append inside one millisecond) silently drops rows on the second connect. See [Deleting a row must not lower the allocator](#deleting-a-row-must-not-lower-the-allocator) — the sharper half of this rule.
- **Scoped to the stream, not global** — the client's `Last-Event-ID` means "the last thing I saw *in this stream*".
- **Unique with the stream id** — that constraint is the idempotency mechanism, not a nicety. Without it a retried job appends a second copy of work it already did.
- **Allocated from a committed row**, never invented by the publisher — and only handed to the client as a resume point once that row is **final**. See [An `id:` promises finality, not merely durability](#an-id-promises-finality-not-merely-durability) below — this is the sharpest edge in the whole pattern.

In chat, `seq` comes from a **persisted allocator on the stream row** — `ChatSession.nextSeq`, a high-water mark that only ever increments:

```ts
// packages/api/src/routers/chat.ts — the user turn, inside the claim transaction
const nextSeq = Math.max(claimedSession.nextSeq, (aggregate._max.seq ?? -1) + 1);
await tx.chatMessage.create({ data: { sessionId, seq: nextSeq, role: "USER", parts } });
await tx.chatSession.update({ where: { id: sessionId }, data: { nextSeq: nextSeq + 1 } });

// apps/worker/src/handlers/chat-run.ts — every assistant turn, one atomic bump
const { nextSeq } = await prisma.chatSession.update({
  where: { id: sessionId },
  data: { nextSeq: { increment: 1 } },
  select: { nextSeq: true },
});
const seq = nextSeq - 1;
```

The `MAX(seq) + 1` term survives only as a **floor** — it is what makes an additively-defaulted allocator column correct for streams that predate it, and the worker applies the same floor (`updateMany({ where: { nextSeq: { lt: max + 1 } }, data: { nextSeq: max + 1 } })`) before it allocates. Reading `MAX(seq) + 1` *as the allocator* is fine only while nothing is ever deleted, which is the next section.

A read-then-write allocator is safe here because chat serializes writers by construction — the `send` procedure atomically claims the session with `updateMany({ where: { status: { not: "RUNNING" } } })`, and the worker claims the turn with `activeJobId` + `runGeneration`, so exactly one producer is appending at a time. **If your stream can have concurrent appenders, use the atomic `{ increment: 1 }` form everywhere** (as the worker does), a database `SERIAL`, or a time-ordered id (see the UUIDv7 variation below).

### Deleting a row must not lower the allocator

The bug this section exists to prevent, because it is invisible in every test that does not reconnect:

A producer writes a partial item at `seq N` and fails. It retries, deletes the partial, and re-derives its cursor from `MAX(seq) + 1` — which is `N` again. A client that watched the first attempt already holds `Last-Event-ID: N`; its reconnect asks for `seq > N` and **never receives the replacement**. Its transcript stays permanently truncated, and the only thing that ever delivered the new answer was the live pub/sub frame — which is explicitly best-effort. That is the invariant of this whole pattern inverted: the stream alone must be sufficient to reconstruct the record.

Three rules, in order of how often they are gotten wrong:

- **The allocator is a separate, monotonic piece of state.** Derive it from the stream row, never from an aggregate over rows a delete can remove. Deleting is a normal operation; lowering a cursor is not.
- **Gaps are fine.** The cursor has to be *ordered*, not dense. A retry that lands at `N+1`, `N+7`, or `N+400` is correct; `N` again is not. Nothing in the replay, the client, or the SSE contract cares about the missing numbers.
- **Do not "fix it up" from a second source.** "The list query will correct the transcript on the next refetch" is a weakening of the contract, not a mitigation — it makes the durable stream insufficient on its own, which is the one thing it must never be.

The client half has a matching consequence, and it is easy to miss: if the server can delete a row, a client that keys live state by `seq` will hold that entry forever, because nothing ever arrives at that `seq` again to replace it. Chat's answer is to treat the hydrated (query-fetched) transcript as authoritative for the range it covers and render only the live entries **above its highest FINAL `seq`** — the genuinely in-flight tail (`mergeTranscript` in `apps/web/src/hooks/use-chat-stream.ts`). Deleted rows then disappear on their own, with no reconciliation pass. Cutting at the highest `seq` *of any state* instead is a subtle second bug: opening the page mid-run hydrates the in-flight row itself, and the cut would then suppress the very live frames that finish it — the transcript freezes on whatever the query happened to catch.

## Reader: the replay seam

This is the part that is easy to get subtly, unreproducibly wrong. The full endpoint is in `apps/server/src/chat-routes.ts`; here is the skeleton with the reasoning attached.

```ts
app.get("/api/chat/:sessionId/stream", async (c) => {
  const sessionId = c.req.param("sessionId");
  const authSession = c.get("session");
  // 404, not 401/403, for anonymous *and* foreign sessions: a stream id must not
  // be probeable for existence by anyone but its owner.
  if (!authSession?.user) return c.json({ error: "Not found" }, 404);
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, ownerId: authSession.user.id },
    select: { id: true },
  });
  if (!chatSession) return c.json({ error: "Not found" }, 404);

  const cursor = parseCursor(c.req.header("Last-Event-ID") ?? c.req.query("lastEventId"));
  c.header("X-Accel-Buffering", "no");

  const response = streamSSE(c, async (stream) => {
    let replaying = true;
    let highWaterMark = cursor;
    const buffered: ChatLiveEvent[] = [];
    let writeChain = Promise.resolve();
    // The `.catch` keeps a dead-socket rejection from poisoning the rest of the
    // chain (and from surfacing as an unhandled rejection).
    const enqueueWrite = (write: () => Promise<void>) => {
      writeChain = writeChain.then(write).catch(() => {});
    };
    const writeLive = (event: ChatLiveEvent) => {
      enqueueWrite(async () => {
        await stream.writeSSE({
          event: event.type,
          // Only FINAL rows get an `id:` — see "Three rules follow" below.
          ...(event.type === "message" && event.state === "COMPLETE"
            ? { id: String(event.seq) }
            : {}),
          // Everything else still ships its seq in the payload: it places the
          // content, it just is not a resume point.
          data: JSON.stringify(
            event.type === "chunk" ? { seq: event.seq, data: event.data } : event.data,
          ),
        });
      });
    };

    // 1. Subscribe BEFORE the replay query.
    const unsubscribe = await subscribeToChat(sessionId, (event) => {
      if (replaying) buffered.push(event);   // 2. buffer, do not write
      else writeLive(event);
    });

    const heartbeat = setInterval(() => {
      enqueueWrite(() => stream.write(": heartbeat\n\n"));
    }, 15_000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    stream.onAbort(cleanup);

    try {
      // 3. Replay everything past the cursor, tracking a high-water mark.
      // (The real endpoint pages this with `take: REPLAY_PAGE_SIZE`, exhausting
      // every page on this response — see "A very long replay" below.)
      const messages = await prisma.chatMessage.findMany({
        where: { sessionId, seq: { gt: cursor } },
        orderBy: { seq: "asc" },
      });
      for (const message of messages) {
        // The SAME rule on the replay path, read off the ROW — this process is
        // not the one that streamed it. A row still mid-stream is delivered (the
        // reader wants to render it) but carries no `id:` and does NOT raise the
        // mark, because the reader does not yet hold its final form.
        const final = message.state === "COMPLETE";
        // Raised synchronously, as the loop walks the rows — not inside the
        // queued write, so it is current by the time the flush below reads it.
        if (final) highWaterMark = Math.max(highWaterMark, message.seq);
        // ON THE CHAIN, like everything else. See "One serialized write chain".
        enqueueWrite(async () => {
          await stream.writeSSE({
            event: "message",
            ...(final ? { id: String(message.seq) } : {}),
            data: …,
          });
        });
      }
      // 4. Flush only what the replay did not already deliver, then go live.
      replaying = false;
      for (const event of buffered) if (event.seq > highWaterMark) writeLive(event);
      await writeChain;
      // 5. Hold the connection open until the client leaves.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    } finally {
      cleanup();
    }
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
```

**Subscribe before you query.** An event published between the replay query and the subscription falls into a gap: too new to be in the query's result set, too early to be delivered live. It is lost with no reader-visible symptom. Subscribing first turns that race into a duplicate, which step 4 discards.

**Buffer live events during the replay; never write them.** Writing a live `seq: 40` while the replay is still emitting `seq: 12` hands the client events out of order and, worse, advances its `Last-Event-ID` to 40 — so a disconnect at that moment permanently skips 13–39.

**Discard at or below the high-water mark.** Anything buffered that the replay already emitted *in its final form* is a duplicate. `>` not `>=`, and the mark is tracked as the replay runs, not read once at the start. Read the mark as **"the highest cursor whose final form this reader now holds"** rather than "the highest thing I sent": a row replayed mid-stream must not raise it, or the buffered frames that finish that row are dropped as duplicates and the client sits on a partial until it reconnects.

**Hold the stream open.** Hono's `streamSSE` closes the response the moment its callback resolves. The `await new Promise(resolve => stream.onAbort(resolve))` is what makes it a stream rather than a very elaborate one-shot response.

## Mechanics that are not optional

### `Last-Event-ID`, and the query-param fallback

Native `EventSource` remembers the last `id:` it received and resends it as the `Last-Event-ID` **header** on every automatic reconnect, with no client code at all. That is the whole reason to prefer it. But `EventSource` cannot set headers on the *first* connection, and `fetch`-based clients (needed for POST bodies or custom auth headers) may not have one to resend — hence `?lastEventId=`:

```ts
c.req.header("Last-Event-ID") ?? c.req.query("lastEventId")
```

Header first: on a reconnect `EventSource` reuses the original query string verbatim, so a stale `?lastEventId=` from page load arrives alongside the fresh header, and the header is the one that is current.

### A bad cursor replays; it never errors — and "no cursor" is not zero

```ts
/** Pre-sequence sentinel: below every real `seq`, and unreachable as input. */
const NO_CURSOR = -1;

function parseCursor(value: string | undefined) {
  if (!value) return NO_CURSOR;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : NO_CURSOR;
}
```

`Last-Event-ID` is attacker-controllable — any client can send any header. Garbage must degrade to "replay from the beginning", not 400 and certainly not 500. **Replaying too much is a no-op for a client that keys by event id; replaying too little is a hole in the record.** Always fail toward the duplicate.

**"Nothing seen yet" must not collide with a real cursor value.** Sequences here start at 0 (`(MAX(seq) ?? -1) + 1`) and the replay is `seq > cursor`, so returning `0` for a missing header quietly skips the stream's *first* event — for a fresh subscriber, on every connect, with no error anywhere. The sentinel has to sit strictly below the first allocated cursor, and it must be unrepresentable as a supplied value (`-1` fails the `>= 0` check and falls back to itself), so one number never means two things. **The client half has to agree**: a client with no cursor omits `?lastEventId=` entirely rather than sending `0` — see `apps/web/src/hooks/use-chat-stream.ts`. If your cursor is a UUIDv7 instead, the sentinel is simply the absence of a value; do not substitute the zero UUID.

### An `id:` promises finality, not merely durability

An SSE `id:` line is a promise: *"if you resume from here, everything at or before this point is already yours, and none of it will change."* The client stores it, and on the next connect the server hands back only `cursor < seq`. So **anything the `id:` steps over is gone for good** — not delayed, not repaired by a later frame, gone, because the live transport is explicitly best-effort and the replay is the only guaranteed delivery path.

This template has now shipped the same bug three times, in three disguises. They are worth reading as one family, because the next stream will find a fourth disguise:

1. **The id ran ahead of the write.** `chunk` frames (raw token deltas) carried an `id:`, and a chunk's `seq` is allocated at the first token — *before* the row exists. A disconnect mid-answer moved the resume point past a row that had not been written yet. *Fixed by never stamping an id on a transient frame.*
2. **The cursor was recycled.** A retry deleted its predecessor's partial and re-derived its seq from `MAX(seq) + 1` — the same number the client already held. *Fixed by a monotonic allocator on the stream row (`ChatSession.nextSeq`); see [Deleting a row must not lower the allocator](#deleting-a-row-must-not-lower-the-allocator).*
3. **The row was durable but not finished.** A streaming producer upserts the *same* row at the *same* cursor on every growth step. Every one of those was published as a `message` frame with an `id:`, so a client that received an early, partial one advanced to `N`, and its reconnect (`seq > N`) never delivered the finished row `N`. The transcript stayed permanently truncated. *Fixed by `ChatMessage.state`: durable completeness on the row, and an `id:` only for `COMPLETE`.*

All three are the same mistake — **the cursor was allowed to name something that was not yet the reader's final answer** — and the third is the one people find last, because unlike the first two it passes every test where the producer runs to completion.

The fourth disguise arrived exactly as predicted, one level up from the row, and is written up in [Terminal state must be replayable, not just published](#terminal-state-must-be-replayable-not-just-published): a frame the client acts on that the replay could not produce at all.

Three rules follow:

- **Session-level events carry no `id:`.** Chat's `status` events (`idle` / `error`) are state, not points in the sequence, so `writeLive` deliberately omits the id for them. Emitting one would advance `Last-Event-ID` past real messages and the next reconnect would skip them.
- **Transient frames carry no `id:` either.** Chat publishes `chunk` events (raw token deltas) whose durable form arrives later via the message upsert, and a chunk's `seq` is allocated in the worker at the first token — *before* the row exists. Losing a chunk costs a flicker, not a message. But a chunk's `id:` reaching a native `EventSource` ahead of its commit would move the resume point past that row, and the next reconnect (`seq > N`) would never deliver row `N` — a silently lost message, which is precisely the failure this whole pattern exists to prevent. So only `message` frames are stamped. A chunk's `seq` still ships, inside the JSON payload (`{"seq":3,"data":…}`), where it is a **correlation key** for coalescing tokens into the right message rather than a resume cursor. `apps/server/src/chat-routes.test.ts` guards this with a dedicated regression test.

- **A mutable row carries no `id:` until it stops mutating.** This is the one that survives the first two fixes. Chat's producer reports a growing message repeatedly and `upsert`s it under one `seq`, so most `message` frames of a turn describe a row that is committed *and* about to be rewritten. `ChatMessage.state` (`STREAMING` → `COMPLETE`, flipped once when the turn finalizes) is what separates the two, and it is **durable state on the row rather than a fact in the producer's memory** for one decisive reason: the process replaying is not the process streaming. Both emission paths must honour it:

  - the **live** path stamps an id only for `state === "COMPLETE"`, and
  - the **replay** path reads the state off the row — a run still in progress, or a partial abandoned by a crashed worker, replays *without* an id and without raising the high-water mark. Fix only the live path and the bug returns on the next reconnect, which is exactly where it is hardest to see.

  The partial itself is still sent, because rendering a frame and resuming from it are different decisions. Its `seq` rides in the payload, like a chunk's — the client needs it to place the content, and there is no `id:` to read it from any more.

  What happens to a partial when the run *fails* is worth stating: it stays `STREAMING` forever. That parks every client's cursor **below** it, which is precisely what makes the retry's replacement — the partial deleted, the answer re-emitted on a fresh, higher cursor — reach every reader through the replay alone. Marking it final on the way out would strand readers above a row that is about to disappear, and would add a write to a path that is already failing. The cost is a slightly longer replay for a session that was abandoned mid-answer, which is the safe direction: **replaying too much is a no-op; replaying too little is a hole in the record.**

  The general rule, and the one to carry to a new stream: **an `id:` is a promise that everything up to it is durable *and final*.** Emit one only for a value already committed and no longer changing — or, better, allocate the cursor by reading it back from the committed row so the publisher cannot invent one. web2sqlite's second implementation takes that route and says so in the type: the cursor "is READ BACK FROM THE DURABLE ROW, never invented by the publisher". If your rows are append-only, "durable" and "final" coincide and there is nothing more to do; the moment a row can be updated in place, they part company and you need this column.

  The client half has to agree, and it is a second place to get it wrong: a client keeps its cursor from the SSE `id:` (`event.lastEventId`) and from persisted rows it knows are final — **never from a `seq` it read out of a payload**, which is how it renders partials in the first place. `hydratedCursor` / `messageFrameCursor` in `apps/web/src/hooks/use-chat-stream.ts` are those two decisions, each with its own unit test.

### State changes need an opening frame, not only a closing one

It is natural to publish a stream's TERMINAL states — the run finished, the run failed — because those are the interesting events. The transition *into* the busy state feels like it needs no frame: the client that caused it already knows.

That last clause is the mistake. **The client that caused it is not the only client.** The same conversation is open in a second tab, on a phone, on a laptop left running — and none of them submitted the mutation, so none of them learn. They hold the stale idle status and an enabled input for the entire length of the answer, and their next submission fails with the conflict the server raises to protect the single-active-run invariant. The user experiences a correct rejection as a bug, because nothing ever told them a run was underway.

So publish on the claim as well as on the release. Two details make it worth more than a status bit:

- **Carry the transcript with it.** The message that *started* the run is a persisted row, and rows arrive by refetch, not by frame. A watching client that learned only the status renders a busy indicator above a question it cannot see.
- **Publish after the work is committed to.** If the enqueue can still fail and release the claim, a frame sent before it leaves every other client waiting on an answer that is never coming.

The frame stays best-effort like every other publish: the database already holds the claim, so losing it costs those clients a stale input until their next reconnect, never correctness.

### The stream cannot retract a row, so the query must

Every frame this design emits is an *addition* or a *replacement*: a `message` frame names a `seq` and gives its content. There is deliberately no delete frame, and adding one would not help — a client that was offline when it went out would never learn, which is the same reasoning that makes publishes best-effort everywhere else.

So a row the producer **removed** has exactly one path back to a connected client: refetching the persisted transcript. That is not a corner case. It is the normal retry: a failed run leaves a partial, the retry deletes it and answers on a fresh higher cursor ([The cursor](#the-cursor)), and the two are *different* rows. Without a refetch the orphan sits in the client's cache forever, rendered directly above its own replacement.

The trap is assuming the mutation that triggered the retry already covered it. It cannot: that invalidation fires when the turn is *accepted*, before the producer has even claimed it, so it refetches the partial rather than its absence. **The refetch has to hang off the terminal frame — the one event that means "the producer is done mutating rows."**

One thing makes this cheaper than it sounds: if the merge rule keeps live rows only *above* the highest final persisted row (as [The cursor](#the-cursor) already requires), the refetch cleans up the live half too. The deleted seq falls below the cut and disappears from both halves at once — no second mechanism, no per-row reconciliation.

> Ask of any stream: **can the producer remove something?** If yes, the stream alone is not sufficient to reconstruct state, no matter how good its replay is, and something else must carry retraction.

`refreshFromStatusFrame` in `apps/web/src/hooks/use-chat-stream.ts`.

### Terminal state must be replayable, not just published

The same family as everything above, one level up from the row: **if a client acts on a frame, the replay has to be able to produce that frame too.** A `message` frame has a durable counterpart by construction — it *is* a row. A session-level `status` frame does not, and that is exactly where the fourth disguise of this bug lives.

Chat's route read the session (seeing `RUNNING`), subscribed, and then replayed **messages only**. A worker that finished in the window between that read and the subscription being established published its terminal `status` frame into a channel nobody was listening on yet — and Redis is best-effort, so the frame was simply gone. The client refreshes session state on a `status` frame and on nothing else, so the UI sat on `RUNNING`, the composer stayed disabled, and only a manual reload recovered. Every message had arrived; the *state* had not.

The fix is one read, in one specific place:

```ts
// …after the replay loop and after the buffered flush…
const current = await prisma.chatSession.findUnique({
  where: { id: sessionId },
  select: { status: true },
});
const terminal = terminalStatusFrame(String(current?.status));   // "idle" | "error" | undefined
// No `id:` — a status frame is state, not a point in the sequence.
if (terminal) enqueueWrite(() => stream.writeSSE({ event: "status", data: JSON.stringify(terminal) }));
```

Four things make it right, and each one is a way to get it wrong:

- **Read it *after* the replay, not next to the authorization check.** The producer writes the terminal status **before** it publishes the frame, and the reader subscribes **before** it replays. So for any terminal transition exactly one of two things holds: it published before the subscription existed — in which case the write that preceded the publish is already committed and a read taken after the replay is guaranteed to see it — or it published at or after the subscription, in which case the frame itself is buffered or live. There is no third ordering, so no window is left. Reading it at the top instead just moves the same window one step later: the state would then describe a moment *older* than the message snapshot the client is being handed.
- **Emit it last.** After every replayed row and every flushed buffer entry, so a client never re-enables its composer while its transcript is still missing the answer it was waiting for. It goes on the same serialized write chain as everything else.
- **Still no `id:`.** A status frame is session state, not a sequence point — the rule from [An `id:` promises finality](#an-id-promises-finality-not-merely-durability) is unchanged. Stamping this one would advance `Last-Event-ID` past real messages.
- **Only *terminal* states produce a frame, and an unrecognized state produces none.** `RUNNING` is the absence of a frame, not a frame saying "running". Inventing a terminal frame for a state the reader does not understand tells a browser to stop waiting for an answer that is still coming — which is the original bug with the sign flipped. Fail toward "say nothing", exactly as the cursor rules fail toward the duplicate.

The generalizable form: **enumerate every frame type a client changes behaviour on, and ask what the replay delivers in its place.** Anything that has no answer is riding on Redis alone, which the first line of this document forbids. `apps/server/src/chat-routes.ts` (`terminalStatusFrame`), with regression tests in `chat-routes.test.ts` asserting the terminal status is delivered on a connection that never receives a live frame — including in the Redis-down degraded mode, where the replay is the *only* thing that can carry it.

### One serialized write chain

```ts
let writeChain = Promise.resolve();
const enqueueWrite = (write) => { writeChain = writeChain.then(write).catch(() => {}); };
```

Concurrent `writeSSE` calls on one stream can interleave partial frames — an `id:` line from one event landing inside another's `data:`, which the browser parses as one corrupt event. Every write goes on the chain, **including the heartbeat**, for exactly this reason. `await writeChain` before switching modes is also the natural backpressure point: it lets a batch reach the socket before more is queued.

**"Every" has to be literal, and the replay is where it gets missed.** The heartbeat is the write people remember to put on the chain, because it is obviously concurrent. The replay loop is the one they forget, because it reads as sequential — it is a `for` loop that `await`s each frame, so it looks serialized *with itself*, and it is. It is not serialized against anything else. A replay that runs longer than the heartbeat interval — a long transcript, a slow database, a client draining slowly — has the timer firing onto the chain while the loop is parked mid-write, and the two are unordered with respect to each other. That is exactly the corruption the chain exists to prevent, reintroduced by the one write that was left outside it. "Almost every write is on the chain" is the same as none of them being on it for the frames that collide.

Routing the replay through `enqueueWrite` costs nothing and is strictly better than the alternative fix of *starting the heartbeat after the replay*:

- **The chain is FIFO**, so queueing preserves the loop's own order for free, and everything queued after it — the buffered flush, then the terminal `status` frame — stays strictly behind every replayed row. The "emit the status last" guarantee becomes a property of the queue rather than of who awaited what.
- **The high-water mark is raised in the loop body, not inside the queued write.** It is bookkeeping about what the *reader will hold*, not about what has hit the socket, so it must be fully computed before the flush consults it. Moving it into the closure is the subtle way to get this wrong.
- **`await writeChain` keeps being the right barrier** — it now drains the replay too, which is what makes it a real mode-switch boundary rather than a barrier over the live path only.
- **Deferring the heartbeat instead leaves the invariant conditional** ("every write is on the chain, except during the replay, when nothing else is writing — probably"). Invariants that hold by argument rather than by construction are the ones the next feature breaks.

`apps/server/src/chat-routes.test.ts` guards it by firing a heartbeat (fake timers) into an unflushed 40-row replay and asserting the beat lands behind every replayed frame rather than between two of them.

**Terminate the chain with a `.catch`.** Once the client disappears, the next `writeSSE` rejects. Without the catch that rejection propagates to every link queued behind it — including the 15-second heartbeat, which happily keeps chaining onto an already-rejected promise — and Node reports an unhandled rejection for a client that merely closed a tab. The abort handler is what actually tears the stream down; a write that lost the race to it is noise, so swallow it.

### Heartbeat

```ts
setInterval(() => { enqueueWrite(() => stream.write(": heartbeat\n\n")); }, 15_000);
```

A `:` line is an SSE comment: the client ignores it, but the bytes keep intermediaries, load balancers, and mobile radios from deciding an idle connection is dead. A stream that produces nothing for two minutes during a long tool call is normal and must survive. Clear the interval in the abort path.

### `X-Accel-Buffering: no`

nginx and nginx-derived proxies buffer proxied responses by default, which for a token stream means the user sees nothing until the run finishes and then everything at once. This header opts the response out. It costs nothing where no such proxy exists.

### `Cache-Control: no-store`

Hono defaults SSE to `no-cache`, which still permits *storage*. A replay response is a full private transcript; `no-store` is what keeps a browser or intermediary from writing it to disk.

### Authorization before subscription, and a 404 that hides existence

The ownership check runs before the subscription and before any replay. The failure response is `404`, not `401`/`403`, for anonymous *and* foreign readers alike — otherwise the endpoint is an existence oracle for stream ids. Same reasoning as [server-procedures § Mutation with ownership check](./server-procedures.md#mutation-with-ownership-check) and the `adminOr404Procedure` convention.

Give the endpoint its own rate-limit bucket too. Each connection costs a session lookup, an ownership query, a replay scan and a listener held for the connection's lifetime, and **reconnect storms are the realistic failure mode** — see [rate-limiting § Give every surface its own bucket](./rate-limiting.md#give-every-surface-its-own-bucket) and `chatStreamLimiter`.

## Fan-out: one subscription for the whole process

A Redis connection in subscriber mode can do nothing else. Subscribing per reader therefore makes open connections scale with concurrent viewers — a few hundred idle browser tabs is enough to exhaust a small managed Redis. Instead, open **one** pattern subscription lazily and demultiplex in memory:

```ts
// apps/server/src/chat-subscriber.ts
const listeners = new Map<string, Set<Listener>>();
let subscriber: ReturnType<typeof createRedisConnection> | undefined;
let starting: Promise<void> | undefined;

async function ensureSubscriber() {
  if (subscriber) return;
  // Single-flight: concurrent first subscribers await the same promise instead
  // of each opening a connection and racing to win the `subscriber` slot.
  starting ??= (async () => {
    const connection = createRedisConnection();
    connection.on("pmessage", (_pattern, channel, payload) => {
      if (!channel.startsWith("chat:")) return;
      try {
        const event: unknown = JSON.parse(payload);
        if (!isChatLiveEvent(event)) return;
        for (const listener of listeners.get(channel.slice(5)) ?? []) listener(event);
      } catch {
        // Malformed frame: ignore. Postgres remains authoritative.
      }
    });
    await connection.psubscribe("chat:*");
    subscriber = connection;
  })().finally(() => { starting = undefined; });
  await starting;
}
```

Connection count is **O(1) in readers**. The costs of the trade are worth knowing: every event on the pattern reaches every server replica (fine at this scale, not fine at tens of thousands of channels per second), and the in-memory map is per-process, so it must be cleaned up.

- **`subscribeToChat` returns an unsubscribe function, and the caller must call it** from the abort/cleanup path. Miss it and you leak a `Set` per disconnected reader — the classic slow leak in this pattern. Delete the key when its set empties.
- **Validate the payload; never log it.** `isChatLiveEvent` narrows before dispatch, and a parse failure is swallowed rather than logged, because the payload is private user content.
- **Export a listener count.** `chatSubscriberListenerCount()` exists so tests can assert cleanup actually happens — that is the only way this leak gets caught.

## Failure modes, honestly

**Redis is down or restarts.** Publishes fail (logged, swallowed) and live frames are dropped — at-most-once, by design.

**Redis is down when a reader connects — the sharp one.** The reader subscribes *before* it replays (see [Reader: the replay seam](#reader-the-replay-seam)), which is correct and must stay. But that `await subscribeToChat(...)` is also a Redis call, so an unreachable Redis rejects (or hangs) it **before the replay query ever runs** — and the reader gets nothing at all: not the live tail it cannot have, but not the already-persisted history either. That is the one invariant of this pattern inverted, in the one place people write the code correctly and still get it wrong: *transport being down must never cost a reader durable data.*

The subscription is therefore best-effort too, exactly like the publish:

```ts
let unsubscribe: () => void = () => {};
let live = true;
try {
  unsubscribe = await subscribeToChat(sessionId, listener);
} catch (error) {
  live = false;                       // degraded: no live tail
  console.error("[chat] live subscription unavailable; serving durable replay only", error);
}
// …replay runs unconditionally…
if (!live) return;                    // end the response; do not hold a dead socket open
await new Promise<void>((resolve) => stream.onAbort(resolve));
```

Three details make the degraded mode actually usable rather than merely non-fatal:

- **The replay is unconditional.** A reader in the degraded mode still receives every row past its cursor, with the same `id:` rules — so `Last-Event-ID` keeps advancing and no reconnect ever re-reads what it already holds.
- **End the response instead of holding it open.** A stream with no transport behind it produces nothing, and a heartbeat on it would make a dead stream look healthy while the client waits forever. Closing hands control to `EventSource`'s own reconnect, which resends the last `id:` — so each reconnect is a fresh replay *and* a fresh attempt at the subscription. The feature heals the moment Redis does, with no reconnect logic of its own.
- **Nothing is left behind.** The unsubscribe is a no-op function rather than `undefined` (the cleanup path calls it unconditionally), and the heartbeat interval is never created in the first place — a failed subscribe must not leak a timer or an unhandled rejection.

### A hung dependency is not a failed dependency; bound it

The `try/catch` above is only half the fix, and the missing half is the one that actually bites in production: **it runs only if the subscribe rejects.** A client library configured to survive outages does not reject — it waits.

`createRedisConnection()` sets `maxRetriesPerRequest: null` and no `commandTimeout`, which is ioredis's "retry forever" configuration (correct for a long-lived subscriber: a blip must not kill the feed). The consequence is that when Redis is unreachable, `psubscribe()` goes into the offline queue and stays **pending** while the connection reconnects on a loop. It never settles. So the `catch` never fires, the replay below it never runs, and the request simply hangs — the degradation was written for exactly this scenario and was dead code in it. The symptom is worse than a rejection, too: an error is visible, a hang looks like a slow server.

The fix belongs in the subscriber, not the route, because the route cannot tell "slow" from "never" and every other caller has the same problem. `apps/server/src/chat-subscriber.ts` races the one-time `psubscribe` against a timer, so the attempt always settles — success, rejection, or timeout — and a timeout is just another rejection to the caller:

```ts
const SUBSCRIBE_TIMEOUT_MS = 5_000;          // a liveness bound, not a tuning knob

connection.on("pmessage", onMessage);
try {
  await withTimeout(connection.psubscribe("chat:*"), SUBSCRIBE_TIMEOUT_MS, "…");
} catch (error) {
  connection.off("pmessage", onMessage);     // no listener left on a socket nobody holds
  connection.disconnect();                   // no half-open connection reconnecting forever
  throw error;                               // `starting` is cleared in `finally`: retryable
}
subscriber = connection;                     // unreachable on the abandoned path
```

Four properties are what make the bound safe, and all four are easy to miss:

- **The loser of the race is not cancellable.** `psubscribe` may still resolve minutes later. Everything the pending work would have touched is therefore torn down *before* the throw, and the only assignment it could have made (`subscriber = connection`) sits after a `throw` it can never get past. A late resolution has nothing left to resurrect.
- **Nothing is cached on failure.** The module caches both the connection and an in-flight `starting` promise (single-flight, so concurrent first readers do not each open a socket). A failed attempt must clear that promise and cache no connection, or one outage poisons the process until restart — the reader would keep getting the degraded path long after Redis came back. The next request opens a fresh connection and succeeds.
- **The connection is closed, not dropped.** An abandoned ioredis instance keeps reconnecting in the background forever; one per timed-out reader is a socket leak that outlives the outage.
- **Listener bookkeeping unwinds too.** `subscribeToChat` registers into the demux map *before* awaiting, so its own `catch` removes the listener (and the empty `Set`) on the way out.

Generalize past Redis: **any await on a network dependency that can be down needs a bound, and "it throws when it's down" is an assumption to verify, not to make.** Retry-forever, infinite offline queues, and no default timeout are the norm in resilient clients — that resilience converts a fast failure into an unbounded wait, which turns a fallback path into decoration. Test it by making the dependency *hang*, not by making it reject; those are different tests, and only the hanging one catches this.

Chat degrades to "history loads, live tokens do not; a refresh shows the finished answer" — which is the correct shape of the trade. `apps/server/src/chat-routes.test.ts` guards it with two tests: one rejects the subscription, and one drives the real subscriber over a `psubscribe` that never settles (fake timers, no real waiting) and asserts the full replay still arrives. `chat-subscriber.test.ts` adds the other half — a timed-out attempt closes its connection and does not poison the next one. Readers see nothing new until they reconnect, at which point the replay hands them everything. **Note the template's chat subscriber does not react to a Redis reconnect**: `ioredis` re-issues the `psubscribe` itself, so the *feed* comes back, but the frames published during the outage are gone and nothing re-reads them. The connection then looks healthy while silently missing that window until the client reconnects. web2sqlite closes this with a `ready`-fires-again hook that triggers a backfill from the reader's watermark; if your stream is long-lived and the client does not reconnect on its own, do the same:

```ts
let seenReady = false;
connection.on("ready", () => {
  if (!seenReady) { seenReady = true; return; }
  // ioredis re-subscribed itself; this closes the gap in the DATA, which
  // re-subscribing alone does not.
  notifyReconnect();   // each reader re-reads Postgres past its watermark
});
```

**A slow reader.** The write chain serializes but does not bound: `writeChain.then(…)` keeps queueing whether or not the socket drains, and `buffered` grows unbounded while the replay runs. For chat (one session, human-paced) that is fine. For a firehose it is a memory amplifier, and the fix is to cap the buffer and *recover the overflow from Postgres* rather than drop it — the rows are durable, so an overflow is a re-read, not a loss.

**A very long replay.** The replay must never issue one unbounded read: chat pages it — `take: REPLAY_PAGE_SIZE` in a loop that exhausts every page on the same response, so each read is bounded while the stream itself never truncates (`apps/server/src/chat-routes.ts`). A stream with hundreds of thousands of durable events may need a replay capped *per connection* instead, and — critically — a capped replay must stay *reachable*: announce where it stopped and stop emitting `id:` on live frames until the gap is closed, so the reader's resume cursor cannot step over the omitted range.

**A duplicate frame.** Harmless if the client keys by event id or by `(streamId, seq)`. Build the client that way and every ambiguous case above can be resolved in the safe direction.

**The producer dies mid-run.** Rows written so far survive, still marked `STREAMING` — which is what keeps any reader's cursor parked below them, so nothing has resumed past a row that is about to be replaced. The queue retries under a deterministic job id; the retry clears the partial output it is replacing and re-emits from **fresh, higher** cursors, so a reader that already saw the partial receives the replacement on its next replay. The reader sees the tail arrive late, not twice — and never sees the truncated version win.

**The producer dies and the queue never retries.** The case above assumes a retry happens. Three failures break that assumption and all land in one state — a stream row that claims a run is in flight while nothing is running: a process killed between committing the claim and enqueueing the job (the claim is durable, the job never existed), a worker SIGKILLed mid-run (the claim *and* a stale owning job id survive, locking every later job out), and a queue exhausting its attempts without the handler's error path running. Every subsequent write conflicts on the claim, and the recovery path refuses because it only accepts the failed state. The stream is wedged with no operator or user recourse.

**A stale-run reaper is the proportionate fix**, and it is one cron, not a transactional outbox: sweep rows still claimed past a threshold, release the claim to the failed state, and publish the same terminal `status` frame the producer publishes so a connected client stops waiting. Two things make it safe — the threshold is **derived from the producer's own wall-clock ceiling** (`CHAT_RUN_TIMEOUT_MS + CHAT_STALE_RUN_GRACE_MS`) rather than being an unrelated number, so nothing the producer can legitimately still be doing is in range; and the release is a **compare-and-set on the snapshot the scan read** (status + generation + the same age bound), so a run that came back to life between the two statements is left alone. `apps/worker/src/handlers/reap-stale-chat-runs.ts`. Note what it deliberately does not touch: the partial rows stay `STREAMING`, which keeps every client's cursor parked below them so the retry's replacement still reaches them through the replay alone.

### The exits must be compare-and-set, not just the entry

The moment a reaper exists, the producer stops being the only thing that can end its own run — and that breaks an assumption almost every single-active-run state machine makes without noticing it.

The entry is always guarded. Chat's worker claims a turn with a compare-and-set on `runGeneration` **and** `activeJobId`, because a read-then-write lets two writers through. What it looked like for a long time is that winning the claim was enough, and the terminal writes could be plain `update`s on the stream id: the run is mine, so its ending is mine to record.

It is not. **Winning a claim is a fact about one instant, not a lease that holds for the rest of the run.** Three ordinary things revoke it while the producer is parked inside a long `await`:

- the reaper decides the run is dead and releases it to the failed state,
- the user then starts a new turn or hits Retry, which bumps the generation and mints a different job,
- or the producer simply does not observe its own abort promptly.

Now the superseded producer resumes, reaches its exit, and writes `IDLE` (or `ERROR`) **on the row the newer run owns**, clearing an `activeJobId` that is not its own. Two things break at once: the newest turn shows a status that belongs to a dead run, and the session is freed for a *second* concurrent run — the one-active-job invariant given away by the very code that was supposed to hold it. Worse, the producer also publishes a terminal `status` frame, so a client watching the live answer is told to stop waiting for it.

The rule, and it generalizes to every claim/lease/lock in a queue-backed system:

> **Guard the exit with the same predicate that guarded the entry.** Every terminal write is `updateMany({ where: <the claim predicate>, data: <terminal state> })`, and **a zero-row match is a normal outcome, not an error** — it means "you were superseded". Exit cleanly, do not throw, do not retry, and *do not publish anything terminal*, because the frame would describe a run the stream has moved past.

Three details are easy to get wrong here:

- **Audit *every* write to the stream row, not just the obvious two.** In chat that includes the auto-title: an unguarded one renames a conversation from a question that is no longer the live turn, so it carries the claim predicate too. It is its own statement rather than a field on the terminal write — see [A condition on a write is a predicate, not a snapshot](#a-condition-on-a-write-is-a-predicate-not-a-snapshot).
- **Not every write needs the guard, and saying which is part of the design.** The `nextSeq` floor and the allocator's `{ increment: 1 }` stay unconditional *because they are monotonic*: a superseded producer can only ever push the cursor allocator up, never hand a newer run a value it already used. Writes that are safe under any interleaving should say so in a comment; everything terminal gets the predicate.
- **On the failure path, superseded means don't rethrow.** Rethrowing buys a queue retry, and the retry's first act is to lose the claim and skip. Swallow it and return.

`apps/worker/src/handlers/chat-run.ts` (`releaseRun`), with regression tests in `chat-run.test.ts` asserting that a superseded terminal write matches zero rows and leaves the newer run's state alone.

#### And the middle of the run, not only its ends

Guarding both ends leaves a real gap in between, and it is the same mistake one level down: entry and exit are instants, but a streaming producer *writes continuously* between them. Everything above still holds when a run is superseded at, say, the fourth of forty growth steps — the terminal write correctly refuses to land — yet the producer happily upserts the remaining thirty-six rows into a stream another run now owns, and then promotes them to the final state on its way out.

This is milder than the loss bugs elsewhere in this doc, and it is worth being precise about why: with a **monotonic allocator** the stale producer cannot recycle or collide with the newer run's cursors, so nothing is lost or overwritten. What you get is a stale duplicate answer, interleaved into the transcript, stamped final — plus every paid dispatch it took to produce. That is a correctness bug about *content*, not about delivery.

So the streaming path re-checks ownership too, and three details make it practical rather than expensive:

- **Throttle it.** A growth callback fires once per token batch; a query per fire is absurd. Chat re-checks at most every 5 s, which bounds the waste at a few seconds of streaming — the same order as the supersede itself.
- **Abort, don't just skip.** Returning early from the write callback leaves the model loop running and still billing. Firing an `AbortController` the loop already accepts ends the dispatch, and the abort surfaces as a non-success stop reason that the existing terminal path turns into a clean superseded exit — no new branch.
- **A failed lookup is not a supersede.** A blipping database must not abandon a healthy run mid-answer. Uncertainty leaves the run alone; the terminal compare-and-set is still there to catch it on the way out. (Same principle as [A queued job is not a stale job](#a-queued-job-is-not-a-stale-job).)
- **The write path is not a heartbeat — give the check its own clock.** This is the trap inside the fix. Hanging the re-check off the growth callback means it only fires while the answer is *growing*, and the expensive parts of a turn grow nothing: a provider request in flight, a slow tool call, a retry backoff. A run superseded during one of those keeps its worker slot and keeps spending until it happens to emit a message or hits the wall-clock deadline — which is most of a run. So the same check also runs on an interval for the loop's duration, sharing one throttle timestamp with the write path so a busy stream and the timer never double up. Clear it in a `finally`, start it *inside* the guarded block, and `unref()` it: a watchdog must never be why a process refuses to shut down.

The check pays for itself twice: it is also what stops a run whose stream row was **deleted** outright — chat's `deleteSession` — from spending the rest of its iteration budget answering a conversation that no longer exists.

`stillOwnsRun` in `apps/worker/src/handlers/chat-run.ts`, with a regression test asserting that the second growth step writes nothing, the rows are never promoted, and no terminal frame is published.

### A condition on a write is a predicate, not a snapshot

The compare-and-set rule above is about *who* may write. This one is its twin and it is missed more often, because the code looks nothing like a lock: it is about **when the condition attached to a write is evaluated**.

Chat's auto-title derives a name from the first user message and applies it only if the session was never named. The trigger read `session.title === ""` — off the row the handler loaded *at the start of the run*. A run is a long `await`, and rename is available for its whole duration, so a user who named the conversation while its very first answer was streaming had that name replaced by the derived one the moment the turn completed. Nothing here is a race between two producers; the producer is the only writer. It is a race between a **read** and its own **write**, and the gap between them is a model call.

> **If a write is conditional on the state of the row, the condition belongs in the `WHERE` clause.** A value read minutes ago describes a row that no longer exists. `updateMany({ where: { …claim, title: "" }, data: { title } })` — and a zero-row match is, again, a normal outcome.

The part that takes a moment: **it has to be a second statement, not one longer predicate.** Folding `title: ""` into the terminal compare-and-set is the obvious move and it is wrong — that write is what *ends the run*, so a mid-run rename would make it match zero rows and the session would be left `RUNNING` holding a live `activeJobId`, wedged behind a run that had actually finished. Renaming a conversation must not cost it its terminal status. Two statements keep the two conditions independent:

```ts
// 1. The auto-title: the claim predicate PLUS `title: ""` — strictly narrower,
//    so it cannot weaken the guard. Zero rows = "already named". FIRST, because
//    `releaseRun` clears `activeJobId` and the shared predicate then stops matching.
if (title && session.title === "") {
  await prisma.chatSession.updateMany({ where: { ...ownedByThisRun, title: "" }, data: { title } });
}
// 2. The release: unchanged, and unconditional on the title.
if (!(await releaseRun({ status: "IDLE", activeJobId: null }))) return { skipped: true };
```

Two smaller decisions in that shape:

- **The stale in-memory value survives only as a short-circuit.** `session.title === ""` skips a pointless round trip for an already-named session (a name cannot become unset — rename rejects the empty string). It decides nothing; the predicate does. Keeping a snapshot check *as an optimization* is fine, and worth a comment saying that is all it is.
- **A supersede landing between the two statements costs nothing here**, because the title is derived from the session's *first* user message, which no later turn changes. Check that for your own field before you rely on the ordering; if the derived value is turn-specific, the title write is superseded-sensitive too and belongs after a successful release, not before it.

The generalizable form: **enumerate every `if` that gates a durable write and ask how old the value it tests is.** Anything read before an `await` that can last seconds is a snapshot, and a snapshot is not a lock. Regression test in `chat-run.test.ts` — a rename lands mid-run and must survive completion, while the run still releases to `IDLE` normally.

### A queued job is not a stale job

The reaper's other trap, and it is the mirror image: deciding a run is dead from **age alone**.

Chat's cutoff was originally judged purely on `ChatSession.updatedAt`, defended by a genuinely good argument — every cursor the run allocates is an `UPDATE` on the stream row, so a live producer keeps pushing `updatedAt` forward and only a run that has stopped writing can age past the threshold. That argument is airtight for a run that has **started**. It says nothing about one that has not.

`updatedAt` does not advance while a job sits in the queue. Enqueue more turns than the worker's concurrency can start inside the threshold — a burst, a slow model, a worker restart draining a backlog — and a perfectly healthy queued job ages past the cutoff and is marked failed. The user is shown a Retry button; the still-queued job then starts anyway and races the replacement generation. The reaper has manufactured exactly the double-run it exists to clean up after.

**Age answers "has anything happened recently?". The reaper needs "is anything going to happen?", and only the queue can answer that.** The signal is already there if the job id is deterministic: chat derives it from `(sessionId, userMessageSeq, runGeneration)` (`chatRunJobId`), so the sweep reconstructs the exact id a claim produced and asks BullMQ for it.

```ts
// apps/worker/src/handlers/reap-stale-chat-runs.ts
const DEAD_JOB_STATES: ReadonlySet<string> = new Set(["completed", "failed"]);

const job = await chatRunQueue.getJob(chatRunJobId({ sessionId, userMessageSeq, runGeneration }));
if (!job) return true;                               // never enqueued, or already swept up → reap
return DEAD_JOB_STATES.has(await job.getState());    // waiting / delayed / active / prioritized → skip
```

Four decisions in that shape are worth copying:

- **The crash-before-enqueue case still works, and it is the one the reaper exists for.** There the job never reached Redis, so the lookup finds nothing — absence *is* the reap condition, not an obstacle to it.
- **A dead-state deny-list, not a live-state allow-list.** Anything unrecognized — a transient `unknown`, a state a future queue version adds — must fall on the *skip* side. An allow-list makes the unknown case destructive, which is the wrong default for a sweep that takes work away from users.
- **A failed lookup skips.** If Redis is unreachable the sweep cannot tell a queued job from a vanished one, and reaping on "I could not tell" marks a live run failed, offers a Retry that races the job still in the queue, and surrenders the single-run invariant on the strength of a network timeout. Skipping costs one cron period for a session that is, by construction, already stuck. **Always fail toward leaving state alone**, exactly as the replay always fails toward the duplicate.
- **Do not race a mechanism that already exists.** A job left `active` by a SIGKILLed worker is *live* by this test, and deliberately so: the queue's own stalled-job checker reclaims it within its interval and either re-queues it (it gets answered) or fails it (the next sweep reaps it). One extra cron period is cheaper than two systems recovering the same job at once.

Keep the compare-and-set on the release regardless — the queue check narrows *which* sessions are candidates; the CAS is still what makes the release itself safe against a session revived between the scan and the write.

## Applying this to something else

The chat feature is the first consumer, not the point. web2sqlite reuses the identical shape to stream an agent run's task turns (`task-turn-subscriber.ts`, `task-turns.ts`, `dataset-routes.ts` — in web2sqlite's repo, not this template). The checklist:

1. **A durable table with a monotonic per-stream cursor** and a unique constraint on `(streamId, cursor)`, plus **an allocator no delete can lower** (a high-water column on the stream row, a `SERIAL`, or a time-ordered id). If rows are ever **updated in place** — any streaming producer — add **a durable completeness state** to the row as well, defaulted to the finished value.
2. **A channel name** — `<feature>:<streamId>` — and a `psubscribe("<feature>:*")` module modeled on `chat-subscriber.ts`, with an unsubscribe function and a listener count for tests.
3. **A producer** that writes then publishes, with the publish wrapped in `try/catch`.
4. **An SSE route** doing: authorize → 404 → parse cursor → `X-Accel-Buffering` → subscribe → buffer → replay → flush past the high-water mark → **re-read and emit any terminal state** → live → `no-store`. That second-to-last step is [Terminal state must be replayable, not just published](#terminal-state-must-be-replayable-not-just-published); skip it and every session-level frame rides on Redis alone.
5. **Its own rate-limit bucket**, and a `Cache-Control: no-store`.
6. **If a stream can have only one active producer**, guard the exits with the same predicate as the entry (see [The exits must be compare-and-set, not just the entry](#the-exits-must-be-compare-and-set-not-just-the-entry)), push every *conditional* write's condition into its `WHERE` clause (see [A condition on a write is a predicate, not a snapshot](#a-condition-on-a-write-is-a-predicate-not-a-snapshot)), and if you add a reaper, make it distinguish "no job" from "job waiting its turn" (see [A queued job is not a stale job](#a-queued-job-is-not-a-stale-job)).
7. **Tests** that assert the seam: an event published during the replay is delivered exactly once, the listener count returns to zero on abort, **a retry that replaces earlier output allocates cursors above it rather than reusing them**, **a mid-stream item carries no `id:` on either the live path or the replay path** (both, separately — one of them being right proves nothing about the other), **a superseded producer's terminal write matches zero rows and publishes nothing**, **a reader that never receives a single live frame still learns the stream's terminal state** (the replay-only path is where a session-level frame gets lost), **a heartbeat firing during an unflushed replay lands behind every replayed frame rather than between two of them** (fake timers — the write chain is only real if the replay is on it), and **a row edited while the producer runs is not overwritten by a value the producer decided from a stale snapshot**. See [testing § Worker / BullMQ job tests](./testing.md#worker--bullmq-job-tests).


#### …but "still queued" must be bounded, or it becomes the same wedge

The guard above is correct and incomplete, and the incompleteness is the kind worth naming: **a check that defers indefinitely is not a check.** A job parked in `waiting` answers "still coming" on every single sweep, so a queue with nothing draining it — every worker down, a bad deploy, a Redis restored from a snapshot — holds its streams in the claimed state permanently. That is precisely the condition the reaper exists to clear, now reached *through* the guard that protects against clearing it too early.

So the deferral gets its own, much longer ceiling — derived from the same threshold rather than invented, because it answers the same question one step out. Past it, a job that has **not started** is withdrawn from the queue and its stream released. Two details make that safe:

- **Withdraw before releasing.** A job left in the queue can still be picked up later and answer a turn the user has since retried. Removing it is what makes the release honest.
- **Only the not-started states.** `active` is a run in flight and belongs to the queue's own stalled-job detection, not to the sweep. And unlike the "is it dead?" test — where a deny-list is safest, so an unknown state counts as alive — this test gates a *destructive* action, so it takes an allow-list: an unrecognized state must not qualify for withdrawal.

The general shape: when a sweep asks a second system "is this still coming?", decide up front what you do when the answer is *yes, forever*.
### Variations the second implementation made, and when you'd make them

**Channel scope: per-entity vs per-run.** Chat uses `chat:<sessionId>` — one channel per conversation, which is what a user watches. web2sqlite's runs are trees of up to thousands of tasks, so a per-task channel would mean one subscription per node; it uses `task-turns:<runId>` and carries `taskId` *inside* the payload. **Scope the channel to what a reader watches, not to what a writer writes.**

**Cursor type: integer `seq` vs UUIDv7 row id.** An integer `seq` is readable, compact, and trivially comparable — but it needs a single serialized appender to allocate safely, and a per-task `seq` restarts at 0 so it cannot order a run-wide stream. web2sqlite uses the row's UUIDv7 `id` instead: time-ordered (48-bit millisecond prefix, then random bits), so lexicographic order is a total order that a keyset cursor pages through, allocated by the database on insert with no coordination between concurrent producers. It is also a string that drops straight into an `id:` line with no encoding layer, and it is treated as **opaque** — compared, never parsed into a number.

The honest caveat, which that code states: UUIDv7 orders to millisecond precision, so two rows created in the same millisecond may sort transposed relative to insert order. Backfill is still *complete* — a reader pages to the end and gets every row — it may just see two same-millisecond siblings swapped. Take the integer when one writer appends and you want readability; take the time-ordered id when writers are concurrent.

Note what the cursor parser must become: `Number(uuid)` is `NaN`, and a `NaN` cursor falling back to "no cursor" looks identical to a fresh connect while actually **discarding a reconnect's resume point**. Validate against the id's real shape.

**Payload size: full body vs bounded preview.** Chat publishes the whole message — they are small and the client wants to render immediately. web2sqlite publishes a 500-character `preview` and leaves the full body in Postgres, fetched on demand. Two reasons, both generalizable: pub/sub payloads stay small when a run can produce thousands of turns a minute, and bulk scraped content never streams through Redis at all. **Publish enough to render a row in a list; fetch the body when something is opened.** This costs nothing in durability — the frame was never the source of truth.

**Live-only mode.** web2sqlite's route accepts `?history=none` for a page that already loaded history through a normal paged query and wants only new events. Worth adding when the same data has a list endpoint. Two subtleties: a resume id must **beat** `history=none` (`EventSource` keeps the original query string forever, so after the first drop they always arrive together), and a live-only reader still needs a watermark — read the stream's current maximum cursor at connect, or a later gap-closing re-read starts at the beginning of history.

## Related

- [add-ins/chat.md](./add-ins/chat.md) — the chat feature that consumes this, and how to enable it
- [queue § Adding a new job](./queue.md#adding-a-new-job) — the producer side lives in a BullMQ job, not a request handler
- [agent-runtime](./agent-runtime.md) — what generates the events in the chat case
- [server-procedures § Mutation with ownership check](./server-procedures.md#mutation-with-ownership-check) — the authorization shape the stream route reuses
- [rate-limiting § Give every surface its own bucket](./rate-limiting.md#give-every-surface-its-own-bucket) — sizing the stream's budget
- [schema-guidelines](./schema-guidelines.md) — naming and indexing the durable table
- [testing § Worker / BullMQ job tests](./testing.md#worker--bullmq-job-tests) — testing the producer without Redis
