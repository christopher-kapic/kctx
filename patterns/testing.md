# Testing

Unit tests for oRPC procedures, auth gates, and BullMQ workers on the server, **plus web-side logic tests under `apps/web/src`** — pure helpers, the decision logic extracted from hooks, i18n wiring, and component output rendered with `renderToStaticMarkup`. No browser/DOM environment (no jsdom, no testing-library), no E2E, no coverage thresholds — fast, focused, mocks-not-real-DB.

## Framework

- **Vitest** — native ESM, TypeScript-first, same config surface as Vite.
- **vitest-mock-extended** — deep-mocks Prisma so every method is a spy with zero setup.
- Tests run against mocked dependencies — never a real database or Redis in CI.

## Running tests

```bash
# All packages
pnpm test

# Single package
pnpm --filter @starter/api test

# Watch mode (useful during development)
pnpm --filter @starter/api test -- --watch
```

Turbo caches test results. `pnpm test` at the root runs the `test` task across every package that defines one.

Vitest 5 does not search parent directories for configuration. Workspace test
scripts must pass `--config ../../vitest.config.ts` so the shared network guard
and contract-test exclusions run. The web app passes `--config vite.config.ts`
instead, preserving its aliases and its own network-guard setup.

Deployment and maintenance regressions also run in `pnpm verify` and the PR policy job: schema apply/restore state-machine checks. The template tooling's own self-tests (policy-checker fixtures, Claude hook deny rules, trufflehog filter, Dokploy config checks, template-removal fixtures) were split out of `verify` into `pnpm verify:tooling`, which runs nightly via `.github/workflows/nightly-tooling.yml` and once more at release — the PR jobs run only the enforcement legs, so every app built from this template is spared the maintainer-only self-tests. All of these use inert boundaries and need no database or Redis.

Explicit operational checks are separate from that unit-test gate. `pnpm db:test-operations` creates its own disposable PostgreSQL 17 fixture to check real locks, transaction outcomes, cancellation, and restart reconciliation. `pnpm runtime:test-operations` creates its own PostgreSQL/Redis fixtures, applies the actual Prisma schema through the canonical runner, and exercises embedded and external consumers with a persisted echo job, readiness, and shutdown. Both require Docker and already-cached images; neither reads root `.env` or uses the developer's running services. These commands do not validate a built Docker image or live deployment.

`pnpm lint`, `pnpm check` (after its autofixes), and the pre-commit hook run the
fast `policy:prisma-query-casts` repository scan. It checks every existing
tracked or untracked non-ignored `.ts`, `.tsx`, `.mts`, and `.cts` file
(excluding generated and vendor output). `pnpm check:ci` additionally runs
`policy:prisma-query-casts:test`, whose accepted/rejected syntax matrix executes
in-process and whose small subprocess seam covers CLI exits, malformed/unreadable
inputs, and `--scan` worktree enumeration. Input read failures are distinguished
from syntax parse failures; parse errors and policy violations are reported with
file, line, and column diagnostics.

## Naming and location

- **Colocated**: test files live next to the source file they cover — `routers/settings.ts` → `routers/settings.test.ts`.
- **One test file per source file.** If a source file grows multiple exports, keep one test file with a `describe` block per export.
- **`describe` block names mirror exported symbols**: `describe("settingsRouter", ...)`, `describe("handleEchoJob", ...)`.

## Procedure tests (oRPC)

Every procedure test follows the same shape — mock Prisma, build a context, create a client, call and assert:

1. **Mock `@starter/db`** with `vi.mock` + `vitest-mock-extended`.
2. **Build a context** (authenticated, unauthenticated, or admin).
3. **Create a router client** with `createRouterClient`.
4. **Call the procedure**, assert the result or error.

### Copy-pasteable recipe

```ts
import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@starter/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { myRouter } from "./my-router";

// 1. Mock Prisma
vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@starter/db");

// 2. Type-safe handle to mocked methods you'll use
const db = prisma as unknown as {
  myModel: {
    findMany: MockInstance;
    create: MockInstance;
  };
};

// 3. Context builder (copy from an existing test or use createMockContext)
function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };

  return {
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
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "test-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("myRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns items for authenticated users", async () => {
    db.myModel.findMany.mockResolvedValue([{ id: "1", name: "Item" }]);

    const ctx = buildContext(); // default: authenticated user
    const client = createRouterClient(myRouter, { context: ctx });

    const result = await client.list();
    expect(result).toEqual([{ id: "1", name: "Item" }]);
    expect(db.myModel.findMany).toHaveBeenCalledOnce();
  });

  it("throws UNAUTHORIZED without a session", async () => {
    const ctx = buildContext(null);
    const client = createRouterClient(myRouter, { context: ctx });

    await expect(client.list()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("UNAUTHORIZED");
      return true;
    });
  });
});
```

### Mocking Prisma queries

```ts
// Return a value
db.myModel.findUnique.mockResolvedValue({ id: "1", name: "Test" });

// Return null (not found)
db.myModel.findUnique.mockResolvedValue(null);

// Simulate a DB error
db.myModel.create.mockRejectedValue(new Error("Unique constraint violated"));

// Assert a method was called with specific args
expect(db.myModel.upsert).toHaveBeenCalledWith({
  where: { key: "siteName" },
  update: { value: "New Name" },
  create: { key: "siteName", value: "New Name" },
});

// Assert a method was NOT called
expect(db.myModel.delete).not.toHaveBeenCalled();
```

**Return-type gotcha**: `mockResolvedValue` does not type-check the shape you pass — you can return a partial object and the test will still compile. This is intentional (deep mocks would be unwieldy for Prisma's generated types), so projection-sensitive tests should type their fixture with the same Prisma-derived payload as production:

```ts
import type { Prisma } from "@starter/db";

const postWithAuthorSelect = {
  id: true,
  Author: { select: { id: true, name: true } },
} satisfies Prisma.PostSelect;

type PostWithAuthor = Prisma.PostGetPayload<{ select: typeof postWithAuthorSelect }>;

const postWithAuthor = {
  id: "post-1",
  Author: { id: "user-1", name: "Ada" },
} satisfies PostWithAuthor;
```

When behavior branches on a selected relation being absent, present, or empty,
test every behaviorally distinct case. A pass-through relation does not need a
ceremonial pair of tests; the generated payload type already checks its shape.

### Compile-time boundary contracts

Use pure compile-time exact-type assertions in a small colocated file named
`*.contract.test.ts`. The API package's
`tsconfig.boundary-tests.json` discovers that suffix with a glob, and
`pnpm check-types` runs the boundary project after the production project.
Ordinary `*.test.ts` files are intentionally excluded from production
typechecking, so a type assertion placed only in an ordinary test is not a
typecheck gate.

Keep contract tests compile-only and fixture-light. Use only `import type`,
including for production functions and routers, and express assertions as types
(`Assert<IsExact<...>>`) so collecting the module can never initialize Prisma,
queues, environment validation, or another runtime dependency. The shared root
Vitest config excludes this suffix globally (the API script also excludes it
defensively); runtime key allowlists and behavior still belong in the ordinary
Vitest file.

```ts
import type { serializeChatSession } from "./chat";

type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
    ? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

export type ChatSessionContract = Assert<
  IsExact<
    ReturnType<typeof serializeChatSession>,
    {
      id: string;
      title: string;
      status: string;
    }
  >
>;
```

This file has no `vitest` import and no runtime assertion expression. A changed
or widened client type makes `Assert<...>` fail during `pnpm check-types`.

## Auth / session gate tests

Route guard tests should target pure decision helpers, not browser routing. For `_app` route access, cover `apps/web/src/lib/route-session-access.ts`: authenticated vs confirmed anonymous, admin verified vs hidden, device admin vs dashboard/login, and `failedRouteSessionResolution()` so infrastructure failure stays distinct from logout. Server-function tests for `apps/web/src/server/auth-session.ts` mock `@starter/auth` and assert request headers are forwarded and token-bearing session fields are not returned. Client session classifier tests live in `apps/web/src/lib/auth-session-state.test.ts`.

Test oRPC/server access levels by varying the context:

```ts
// Unauthenticated — expects UNAUTHORIZED
const ctx = buildContext(null);

// Authenticated regular user — expects success or FORBIDDEN depending on procedure
const ctx = buildContext(); // role defaults to "user"

// Admin — expects success on admin-gated procedures
const ctx = buildContext({ user: { role: "admin" } });
```

Assert error codes with `rejects.toSatisfy`:

```ts
await expect(client.adminOnly()).rejects.toSatisfy((error: ORPCError) => {
  expect(error).toBeInstanceOf(ORPCError);
  expect(error.code).toBe("FORBIDDEN");
  return true;
});
```

See `packages/api/src/routers/settings.test.ts` for a complete example covering public, authenticated, and admin procedures.

## Worker / BullMQ job tests

Worker handlers are plain async functions that receive a BullMQ `Job` object. Test them by:

1. Mocking `@starter/db` (same pattern as procedure tests).
2. Building a fake `Job` with the required `data` and `id`.
3. Calling the handler directly.

### Fake job helper

```ts
import type { MyJobData } from "@starter/queue";
import type { Job } from "bullmq";

function fakeJob(overrides?: Partial<Job<MyJobData>>): Job<MyJobData> {
  return {
    id: "test-job-1",
    data: { /* your default job data */ },
    ...overrides,
  } as Job<MyJobData>;
}
```

### Example

```ts
it("processes the job and writes to the database", async () => {
  const { handleMyJob } = await import("./my-handler.js");

  db.myModel.upsert.mockResolvedValue({ id: "1" });

  const job = fakeJob({ data: { message: "hello" } });
  const result = await handleMyJob(job);

  expect(result).toEqual({ processed: true });
  expect(db.myModel.upsert).toHaveBeenCalledOnce();
});
```

See `apps/worker/src/handlers/echo.test.ts` for the full example.

## Designing tests for CI — mock every external boundary the import graph touches

CI runs with no Postgres, Redis, S3, or SMTP. A test that passes locally because your dev `docker compose` stack is up will hang in CI when the first connection attempt times out. The CI runner has a 5 s default vitest timeout, so the failure shows up as `Error: Test timed out in 5000ms` pointing at a line with nothing obvious to do with networking.

**The rule:** mock every module that opens a network/disk connection at module-load time, even if your assertion doesn't touch it. Module-load side effects fire as soon as the import graph is walked — not when you call the function.

**The trap:** `@starter/queue` constructs `new Queue(...)` at the top of `packages/queue/src/index.ts`, opening an IORedis socket. The connection is lazy (not required for module load to finish), but `.add()` blocks on it. A test that mocks `@starter/db` but forgets `@starter/queue` will pass locally if your dev Redis is running, and hang in CI on the first `.add()` until vitest's 5 s timeout fires.

The shared Vitest setup also replaces `net.Socket.prototype.connect` with a fail-fast test-only sentinel. It records attempts and fails the suite at teardown even if application code catches the sentinel error, preventing a same-process TCP client from being created when an import was externalized past Vitest's module mocks. It is not a general network or subprocess sandbox and does not replace a precise `@starter/queue` mock. The web package receives the same setup through its Vite test config.

If your test imports a full router barrel (e.g. `appRouter` from `@starter/api/routers/index`), you import *every* sub-router's transitive dependencies. Mock them all.

### Boundaries to mock

| Module | Why | What to put in the mock |
|---|---|---|
| `@starter/db` | Opens a Postgres pool on first query | `mockDeep()` from `vitest-mock-extended` |
| `@starter/queue` | Constructs BullMQ `Queue`s (IORedis sockets) at module load | A fake queue implementing every method the test can call (`add`, `getJob`, `getJobs`, …), plus `QUEUE_NAMES`, enqueue/cancel helpers, `redisConnection`, and any job schemas the import graph reads |
| `@starter/auth` | Better-Auth loads its config + session store | `{ auth: { api: { getSession: vi.fn().mockResolvedValue(null) } } }` (override per test as needed) |
| `@starter/env/server` | Server-only Zod validation against `process.env` on first import (Better-Auth, CORS, SSO, SMTP, VAPID, rate limits, …) | `{ env: {}, ...flags-your-code-reads }` (e.g. `SIGNUP_ENABLED`, `ADMIN_EMAILS`) |
| `@starter/env/shared` | Worker-safe Zod validation (`DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `S3_*`, `BACKUP_*`, chat + translation keys). A **distinct module** — `@starter/env/server` `extends` it but does not re-export it, so mocking `server` alone does **not** suppress it | `{ env: {}, S3_FORCE_PATH_STYLE: false, ...flags-your-code-reads }` |
| `@starter/api/lib/assets`, `@starter/api/lib/images`, anything that lazy-imports `sharp` / `@aws-sdk/client-s3` | Pulls native bindings + opens S3 clients | Stub the specific function the procedure calls — `createAsset`, `analyzeImage`, etc. |

**Which env module to mock — the split convention.** The env package is split into two import targets (since `@starter/env` was split):

- **Code in the worker import graph** — `apps/worker/**`, `@starter/db`, `@starter/queue`, `@starter/api/lib/storage`, `@starter/i18n-translate` — imports only `@starter/env/shared`. A unit test whose code under test lives there mocks `@starter/env/shared` (e.g. `packages/api/src/lib/storage.test.ts`, `packages/i18n-translate/src/*.test.ts`), **not** `@starter/env/server`.
- **Server-only code** — oRPC procedures, auth gates, the Hono server — imports `@starter/env/server`; those tests mock `@starter/env/server` as before.
- **Tests whose import graph spans both** (a procedure test that transitively loads `@starter/db` / `@starter/queue` / a storage helper) need a **sibling `vi.mock("@starter/env/shared", …)` in addition to** the `@starter/env/server` mock — otherwise the real shared validator runs and the test fails on missing env. The canonical worked example is `packages/api/src/routers/chat.test.ts`:

```ts
vi.mock("@starter/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));

// The worker-safe env is a distinct module the router's import graph touches
// transitively (db / storage / queue / the chat gate). Mocking
// @starter/env/server alone does not suppress it.
vi.mock("@starter/env/shared", () => ({
  env: { CHAT_ENABLED: true, OPENROUTER_API_KEY: "test-key" },
}));
```

Put real values in the shared mock when a gate reads them — `lib/chat-enabled.ts` is `CHAT_ENABLED && OPENROUTER_API_KEY`, so an empty `env: {}` silently disables chat and every procedure assertion fails on a `SERVICE_UNAVAILABLE` instead of the behaviour under test.

For ESM modules, the mock factory must export **every named export the import graph reads** — not just the ones your assertion exercises. A missing name comes back as `undefined`, and the error shows up as `X is not a function` deep inside an unrelated procedure.

### Worked example — full-router test

`packages/api/src/routers/index.test.ts` imports the full `appRouter` to assert on `health` and `appConfig`. Neither assertion goes near Redis — but importing the barrel pulls in `routers/queue.ts` (which imports every queue in the package), `routers/chat.ts` (the chat producer and the Redis-backed spend limiter), `routers/seed.ts`, and the asset helpers. Every one of those boundaries has to be stubbed before the first assertion runs:

```ts
// @starter/queue opens IORedis sockets at import time — mock every producer the
// import graph touches or the suite hangs in CI (no Redis).
vi.mock("@starter/queue", () => {
  const fakeQueue = { add: vi.fn() };
  return {
    echoQueue: fakeQueue,
    analyzeAssetQueue: fakeQueue,
    cleanupAssetsQueue: fakeQueue,
    seedQueue: fakeQueue,
    chatRunQueue: fakeQueue,
    reapStaleChatRunsQueue: fakeQueue,
    reapExpiredAuthTokensQueue: fakeQueue,
    checkBackupFreshnessQueue: fakeQueue,
    echoJobSchema: { parse: (v: unknown) => v },
    ensureRunnableJob: vi.fn(),
    QUEUE_NAMES: {},
    // The chat spend limiter (packages/api/src/lib/chat-rate-limit.ts) builds a
    // Redis-backed limiter over this connection at module load.
    redisConnection: {},
  };
});
```

That producer list is the whole of `QUEUE_NAMES` (`packages/queue/src/jobs.ts`) — a barrel import buys you all of it. `@starter/db`, `@starter/auth`, `@starter/mailer`, `../lib/storage`, and both env modules get the same treatment in that file; read it before writing a new full-graph test.

A narrower test that imports one router only needs the queues that router actually uses. `packages/api/src/routers/chat.test.ts` mocks `enqueueChatRun` / `cancelChatRun` / `redisConnection` and nothing else, and deliberately leaves `@starter/queue/jobs` — the Redis-free half of the package — unmocked so the real `chatRunJobId` derivation is under test rather than stubbed past. Narrow your import graph and the mock block shrinks with it.

### Verifying locally without Redis

If you're unsure whether a new test depends on a live service, stop your dev stack before running it:

```bash
pnpm dev:services:stop   # stops Postgres + Redis from the dev compose stack (docker-compose.dev.yml)
pnpm test
pnpm dev:services        # bring it back up when you're done
```

A test that passes here passes in CI. One that hangs ~5 s then fails with `Error: Test timed out in 5000ms` is missing a mock — find the boundary it's trying to reach and add it to the `vi.mock` block.

### Other CI-only constraints

- **No filesystem writes outside `tmpdir`.** CI runners have read-only mounts in places dev machines don't. Use `os.tmpdir()` or `node:fs/promises` against an explicit temp path; don't write to the repo or to `~`.
- **Don't depend on wall-clock time.** Use `vi.useFakeTimers()` for anything that calls `setTimeout`, `setInterval`, or compares against `new Date()` — CI runners are slower and a `setTimeout(fn, 100)` race that works locally can flake under load.
- **Don't rely on environment variables being set.** The `@starter/env/server` and `@starter/env/shared` mocks above cover the typed env readers (mock whichever your import graph touches — see "Which env module to mock" above), but if your code calls `process.env.FOO` directly, mock or set it explicitly in the test.
- **Don't depend on test ordering.** Vitest runs files in parallel and tests within a file in source order, but `--shard` in CI can reorder. Reset state in `beforeEach` (`vi.clearAllMocks()`), not in `beforeAll`.

## What NOT to test

| Skip | Rationale |
|---|---|
| Third-party libraries (Zod, oRPC routing, TanStack) | Tested upstream; our tests only verify our logic |
| Prisma queries against a real DB | Slow, flaky, requires Docker in CI; mock instead |
| Better-Auth internals (token issuance, OAuth flows) | Tested by the library; we test our auth *gates* |
| Components and hooks driven through a browser DOM (clicks, effects, `renderHook`) | No jsdom/testing-library setup; test the pure logic a hook delegates to (`apps/web/src/hooks/use-mobile-keyboard.test.ts`) or its static markup via `renderToStaticMarkup` (`apps/web/src/components/query-boundary.test.tsx`) instead |
| E2E browser flows | Out of scope for now; add Playwright when justified |
| Coverage thresholds | Incentivizes low-value tests; focus on critical paths |

## Shared test utilities

`packages/test-utils` exports `createMockContext()` — builds a typed oRPC `Context` with a deep-mocked PrismaClient. Use it for less boilerplate than a local `buildContext`:

```ts
import { createMockContext } from "@starter/test-utils";

const { ctx, db } = createMockContext(); // authenticated
const { ctx } = createMockContext({ session: null }); // unauthenticated
const { ctx } = createMockContext({ session: { user: { role: "admin" } } }); // admin
```

The existing example tests use a local `buildContext` function for clarity, but either approach is fine.
