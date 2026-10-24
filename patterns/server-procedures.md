# Server Procedures (oRPC)

All API logic lives in `packages/api/src/routers/` as oRPC procedures. Types flow to the client with zero codegen — adding a procedure here makes it immediately available as `orpc.<router>.<procedure>` on the web client.

## Procedure levels

Defined in `packages/api/src/index.ts`:

| Procedure | What it gives you | When to use |
|---|---|---|
| `publicProcedure` | No auth | Health checks, public config, anything anonymous can see |
| `authenticatedProcedure` | `context.session` is guaranteed, but force-2FA is not enforced | Rare auth-only surfaces that must stay reachable during forced 2FA enrollment |
| `protectedProcedure` | `context.session` is guaranteed | Anything a signed-in user does |
| `adminProcedure` | `context.session` + admin role check (throws `FORBIDDEN`) | Admin actions where the endpoint's existence is OK to leak |
| `adminOr404Procedure` | `context.session` + admin role check (throws `NOT_FOUND`) | Admin actions that back the 404-hidden `/admin` UI; see [auth-and-routing.md § Admin route group](./auth-and-routing.md#admin-route-group-admin) |

**Pick the most restrictive level that works.** Don't wrap a role check inside a `publicProcedure` — use `adminProcedure` so the middleware enforces it before the handler runs. For product-specific staff roles, follow [custom-roles.md](./custom-roles.md) and enforce the access matrix explicitly.

**Every builder is registered, and a new one must be too.** Builders live in `packages/api/src/index.ts`, are named `*Procedure`, and are listed in the `procedureAccessLevels` object exported from that same file; middleware a chain passes to `.use()` is listed in `middlewareAccessLevels` beside it. Routers import the builder from `../index` — never re-declare one locally. `pnpm policy:access-matrix` parses that file statically and **fails on any procedure built on a builder or middleware that is not registered**, in the template as well as in your app. So adding a role gate is two edits in one commit: the builder/middleware, and its registry entry. Recipe: [custom-roles.md § When to create a middleware](./custom-roles.md#when-to-create-a-middleware).

## Minimal query

```ts
// packages/api/src/routers/posts.ts
import { z } from "zod";
import { ORPCError } from "@orpc/server";
import prisma from "@starter/db";
import { protectedProcedure, publicProcedure } from "../index";

export const postsRouter = {
  list: publicProcedure
    .input(z.object({ limit: z.number().max(100).default(20) }))
    .handler(async ({ input }) => {
      return prisma.post.findMany({
        take: input.limit,
        orderBy: { createdAt: "desc" },
        select: { id: true, slug: true, title: true },
      });
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const post = await prisma.post.findUnique({
        where: { id: input.id },
        select: { id: true, slug: true, title: true, body: true },
      });
      if (!post) throw new ORPCError("NOT_FOUND", { message: "Post not found" });
      return post;
    }),
};
```

## Mutation with ownership check

Ownership checks go at the **top** of the handler, before any mutation logic. Bail fast on unauthorized access.

```ts
update: protectedProcedure
  .input(z.object({ id: z.string(), title: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const post = await prisma.post.findUnique({
      where: { id: input.id },
      select: { id: true, authorId: true },
    });
    if (!post) throw new ORPCError("NOT_FOUND");

    // Admin bypass + ownership
    const isAdmin = hasRole(context.session.user.role, "admin");
    if (!isAdmin && post.authorId !== context.session.user.id) {
      throw new ORPCError("FORBIDDEN");
    }

    return prisma.post.update({
      where: { id: input.id },
      data: { title: input.title },
      select: { id: true, slug: true, title: true },
    });
  }),
```

## Autocomplete / search procedure

Accept a query string and a limit. Propagate the `signal` for cancellation. Keep page size small.

```ts
search: protectedProcedure
  .input(z.object({ query: z.string(), limit: z.number().max(50).default(10) }))
  .handler(async ({ input, signal }) => {
    return prisma.post.findMany({
      where: { title: { contains: input.query, mode: "insensitive" } },
      take: input.limit,
      select: { id: true, title: true, slug: true },
    });
  }),
```

The web side calls this without React Query — see [autosuggest.md](./autosuggest.md).

## Prisma projections and result types

A Prisma projection is both a type boundary and a data-disclosure boundary. A
client-facing procedure must explicitly `select` the fields it returns or map a
query result through an explicit serializer. Returning an unrestricted model
row means a later schema change can silently add a sensitive field to the API.

Inline projections are already contextually checked by Prisma. When a
projection is reused, passed to a helper, or needs a named result type, declare
it with `satisfies` and derive the row type from the generated client:

```ts
import prisma, { type Prisma } from "@starter/db";

const postListSelect = {
  id: true,
  slug: true,
  title: true,
  Author: {
    select: { id: true, name: true },
  },
} satisfies Prisma.PostSelect;

type PostListRow = Prisma.PostGetPayload<{
  select: typeof postListSelect;
}>;

function serializePost(row: PostListRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    author: {
      id: row.Author.id,
      name: row.Author.name,
    },
  };
}

const rows = await prisma.post.findMany({
  where: { deletedAt: null },
  select: postListSelect,
});
```

Keep the serializer as an explicit client DTO allowlist. Identity-return is
wrong whenever the projection also contains server-only fields needed for
authorization, coordination, or internal decisions. The query projection and
client contract may intentionally differ; changing either one should not
silently change the other.

Use `satisfies Prisma.<Model>FindManyArgs` instead when the complete argument
object—including filters, ordering, and pagination—is itself reusable. Do not
cast the result of a Prisma query to a hand-written row, record, or payload
type. A cast hides a stale relation name, wrong nullability, or a projection
that no longer returns what its consumer expects:

```ts
// Wrong: this silences the generated schema contract.
const rows = (await prisma.post.findMany(args)) as PostListRow[];

// Correct: fix/schema-check `args`; inference now produces PostListRow[].
const rows = await prisma.post.findMany(args);
```

A small structural type is still appropriate for a genuinely generic helper
that accepts more than one source. It must describe only what the helper reads,
and callers must satisfy it normally—never through an assertion on a Prisma
result.

The repository's `policy:prisma-query-casts` AST check closes direct assertions
on proven Prisma model-delegate results, `$transaction` results, and
`$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, and `$executeRawUnsafe` results.
It covers normal and optional calls plus the tagged-template forms supported by
`$queryRaw` and `$executeRaw`. It follows the default `@starter/db` import
through local `const` client aliases and into inline interactive `$transaction`
callback parameters. Within that proven provenance it recognizes static string
and no-substitution-template members and assertions wrapped in await,
parentheses, non-null, chain, or `satisfies` expressions. It also follows one
result hop: a local `const` initialized directly from any covered result may not
be asserted later (`const rows = await prisma.post.findMany(); rows as Row[]`).
Runtime expressions in binding patterns are checked too, and a write
conservatively ends proven client provenance. Unrelated SDKs with matching
method names are not flagged.

This is deliberately a bounded, local analysis. Results passed through helper
parameters or returned by helpers, destructured result bindings, mutable
(`let`/`var`) result or client aliases, extracted delegate methods, dynamic
computed member names, and transaction callbacks declared elsewhere remain
review concerns. It does not attempt interprocedural flow. Projection review
also remains responsible for ensuring every client-facing read uses an explicit
`select` or serializer.

## Error vocabulary

Use `ORPCError` with these standard codes:

| Code | When |
|---|---|
| `NOT_FOUND` | Entity doesn't exist |
| `UNAUTHORIZED` | Not logged in (the `protectedProcedure` middleware throws this automatically) |
| `FORBIDDEN` | Logged in but not allowed |
| `BAD_REQUEST` | Invalid input beyond what Zod catches |
| `CONFLICT` | Duplicate / already exists (email taken, etc.) |
| `INTERNAL_SERVER_ERROR` | Unexpected — let it throw and the interceptor logs it |

```ts
throw new ORPCError("CONFLICT", { message: "Email already in use" });
```

These map to HTTP status codes on the wire and to `Error.message` on the client. The server's `onError` interceptor (see `apps/server/src/index.ts`) logs anything with status ≥ 500 but skips 4xx ORPCErrors, so expected client errors don't spam logs.

## Input validation

Always use `.input(z.object(...))`. Zod validates at the procedure boundary; the handler only runs if the input is valid. TypeScript infers `input` from the schema, so the handler body is fully typed.

**Security note:** Zod validates *shape*, not *content*. If any field is rendered via `dangerouslySetInnerHTML`, sanitize it server-side with `sanitize-html` or DOMPurify + jsdom. Normal JSX interpolation is auto-escaped, so most fields are safe.

### Extensible state contracts

Use `z.enum(...)` instead of `z.boolean()` for procedure inputs or returned
objects when the value is a named state that could plausibly gain more states
later. This mirrors the Prisma rule in [schema-guidelines.md § Enums and state
fields](./schema-guidelines.md#enums-and-state-fields).

```ts
const reviewStateSchema = z.enum(["PENDING", "APPROVED"]);

updateReview: protectedProcedure
  .input(z.object({ id: z.string(), state: reviewStateSchema }))
  .handler(async ({ input }) => {
    return prisma.review.update({
      where: { id: input.id },
      data: { state: input.state },
    });
  }),
```

Plain Booleans are still fine for inherently binary switches or package-owned
contracts that require Booleans.

## Registering a new router

1. Create `packages/api/src/routers/<name>.ts` exporting a plain object of procedures.
2. Import it into `packages/api/src/routers/index.ts` and add it as a key on `appRouter`.

```ts
// packages/api/src/routers/index.ts
import { postsRouter } from "./posts";

export const appRouter = {
  health: { /* ... */ },
  appConfig: /* ... */,
  settings: settingsRouter,
  push: pushRouter,
  posts: postsRouter, // <- new
};
```

The client picks it up automatically as `orpc.posts.list.queryOptions()`, `orpc.posts.create.mutationOptions()`, etc.

## Prisma enum serialization

Prisma enum fields should be widened to plain strings at the client boundary. Schema-check the input projection, derive its row type, and explicitly allowlist the serialized output so later schema fields cannot silently become API fields:

```ts
const postListArgs = {
  select: { id: true, slug: true, title: true, status: true },
} satisfies Prisma.PostFindManyArgs;

type PostListRow = Prisma.PostGetPayload<typeof postListArgs>;

function serializePost(post: PostListRow) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    status: String(post.status),
  };
}

const posts = await prisma.post.findMany(postListArgs);
return {
  items: posts.map(serializePost),
  total,
};
```

## Anti-patterns

- ❌ **Ownership checks inside the mutation step.** Put them at the top; don't let a half-completed mutation run because the user wasn't allowed.
- ❌ **`publicProcedure` + manual `if (!session)` check.** Use `protectedProcedure` instead.
- ❌ **Returning raw `Error` objects.** Use `ORPCError` with a proper code.
- ❌ **Casting Prisma query results to hand-written types.** Schema-check the projection and derive its type with `Prisma.<Model>GetPayload`.
- ❌ **Returning unrestricted Prisma rows to clients.** Use an explicit projection or serializer so schema additions do not become API additions.
- ❌ **Importing from `@starter/api` in the web app.** Import `AppRouterClient` as a type only; never import runtime code from the server package into the client bundle.

## Reference

- Base procedures: `packages/api/src/index.ts`
- Example routers: `packages/api/src/routers/settings.ts`, `packages/api/src/routers/push.ts`
- Server entrypoint / handler mounting: `apps/server/src/index.ts`
