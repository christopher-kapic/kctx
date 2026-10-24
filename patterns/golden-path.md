# The Golden Path — one feature, end to end

Read this first, before your first feature. It walks a shipped, deliberately boring feature — **Projects**, a private per-user list with create, edit and delete — naming every file in the order you should write them, and citing the pattern doc that owns each step.

The feature is not the point. The point is that a vertical on this stack always has the same ten steps, in the same order, and that skipping one is how a feature ends up unreachable, untranslated, unbounded, or leaking someone else's rows. Copy the shape; delete Projects when you no longer need the example (see [Evolve or delete](#evolve-or-delete) at the bottom — the exact file list is there).

**What Projects deliberately is not.** No slug (it has no public URL), no money, no state machine, no background job, no uploads. Every one of those has its own pattern doc, and putting them here would bury the shape under the exceptions.

## The ten steps

| # | Step | You write | Owner doc |
|---|---|---|---|
| 1 | Schema | `packages/db/prisma/schema/projects.prisma`, `auth.prisma` | [schema-guidelines](./schema-guidelines.md) |
| 2 | Apply | `pnpm db:push` | [schema-changes-recipe](./schema-changes-recipe.md) |
| 3 | Procedure | `packages/api/src/routers/projects.ts`, `routers/index.ts` | [server-procedures](./server-procedures.md), [data-fetching](./data-fetching.md) |
| 4 | Test | `packages/api/src/routers/projects.test.ts` | [testing](./testing.md) |
| 5 | Route | `apps/web/src/routes/$lang/_app/_auth/projects.tsx` | [data-fetching](./data-fetching.md), [loading-and-errors](./loading-and-errors.md) |
| 6 | Overlays | `apps/web/src/components/projects/*.tsx` | [overlays](./overlays.md), [forms](./forms.md), [mutations](./mutations.md) |
| 7 | Locales | `packages/locales/src/*/projects.json`, `apps/web/src/i18n/config.ts` | [i18n](./i18n.md) |
| 8 | Nav | `apps/web/src/lib/nav-items.ts` + its test, `*/nav.json` | [auth-and-routing](./auth-and-routing.md) |
| 9 | Sitemap | `sitemap.md` | — |
| 10 | Access matrix | `notes/02-users-and-roles.md` | [custom-roles](./custom-roles.md) |

Steps 1–4 are the server; 5–8 are the client; 9–10 are the paperwork that keeps the next agent (and the CI gates) honest. Do them in order: every later step reads a name the earlier one chose.

---

## 1. Schema — `packages/db/prisma/schema/projects.prisma`

A new domain gets its own file rather than being appended to `schema.prisma`, which holds only the generator and datasource blocks — [schema-guidelines § Multi-file schema](./schema-guidelines.md#multi-file-schema).

```prisma
model Project {
  id        String   @id @default(cuid(2))
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt
  ownerId   String
  Owner     User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  name      String
  notes     String?

  @@index([ownerId, createdAt(sort: Desc)])
  @@map("project")
}
```

Four decisions worth naming, because they are the ones a new model gets wrong:

- **`id` / `createdAt` / `updatedAt` on every model**, and `updatedAt` takes `@default(now()) @updatedAt` together — [schema-guidelines § Required fields on every model](./schema-guidelines.md#required-fields-on-every-model).
- **The relation is explicit, bidirectional, and declares `onDelete`.** `Cascade` because a project cannot outlive its owner. The back-relation (`Projects Project[]`) goes on `User` in `auth.prisma` in the same edit — Prisma requires both sides. [schema-guidelines § Relationships](./schema-guidelines.md#relationships).
- **One compound index, `[ownerId, createdAt(sort: Desc)]`**, serves both the foreign key and the list query's `WHERE ownerId = $1 ORDER BY createdAt DESC`: equality column first, range column second. [schema-guidelines § Indexing](./schema-guidelines.md#indexing).
- **No `slug` and no `publicId`.** A project has no shareable URL, so the primary key is the only identifier it needs. Adding a slug "for later" would be a public identifier on a private resource. [schema-guidelines § Which one do I need?](./schema-guidelines.md#which-one-do-i-need)

The `name` length ceiling lives in the Zod schema at the procedure boundary (step 3), not in the column type — every write goes through that boundary.

## 2. Apply — `pnpm db:push`

```bash
pnpm db:push
```

There is no migration history in this repo. A new table plus an index plus a foreign key is purely additive, so the push completes with the success message and no data-loss warning; if you see a yellow warning block, stop and read it — you removed something by accident. [schema-changes-recipe § Recipe 2 — Add a new model](./schema-changes-recipe.md#recipe-2--add-a-new-model).

Commit the `.prisma` files. Nothing else is generated that needs committing.

## 3. Procedure — `packages/api/src/routers/projects.ts`

Four procedures — `list`, `create`, `update`, `delete` — on `protectedProcedure`, the registered authenticated builder. **Register the router in `packages/api/src/routers/index.ts` in the same edit**; a router nobody spreads into `appRouter` is invisible to the client's types and to the access-matrix gate. [server-procedures § Registering a new router](./server-procedures.md#registering-a-new-router).

Three properties make this file worth copying:

**The projection is a disclosure boundary.** One `projectSelect` object, `satisfies Prisma.ProjectSelect`, is the only shape that reaches a client. Note what is *not* in it: `ownerId`, which the caller already knows and which nothing on the wire should carry. Never cast a query result to widen it. [server-procedures § Prisma projections and result types](./server-procedures.md#prisma-projections-and-result-types).

**The list is bounded by construction.** `cursorPageInput` + `pageTake(limit)` + `cursorPage(...)`, with the owner clause ANDed under `withCursor` and a total order (`[{ createdAt: "desc" }, { id: "desc" }]` — the `id` tie-breaker is required, or rows sharing a timestamp repeat or vanish across pages). There is no unbounded variant to reach for. [data-fetching § Server side: the cursor is a composite keyset](./data-fetching.md#server-side-the-cursor-is-a-composite-keyset).

**Ownership is enforced in the query, and a foreign id fails closed as NOT_FOUND.** The single-row paths go through `findOwnedOrThrow` (`packages/api/src/lib/ownership.ts`), which merges the owner clause into the query itself, so a caller cannot forget it and a reviewer cannot mistake a post-hoc comparison for a check. `FORBIDDEN` would turn the error code into an existence oracle — a row that belongs to someone else must be indistinguishable from one that does not exist. [server-procedures § Error vocabulary](./server-procedures.md#error-vocabulary).

Inputs are bare Zod validators with no inline messages: the copy comes from the locale-aware error map. [i18n § Zod validation messages](./i18n.md#zod-validation-messages).

Nothing here spends money, sends mail, or queues work, so the generic `/rpc/*` limiter is the whole rate-limiting story. A procedure that *did* cost something would need its own bucket — [rate-limiting § When the surface is a procedure, not a route](./rate-limiting.md#when-the-surface-is-a-procedure-not-a-route).

## 4. Test — `packages/api/src/routers/projects.test.ts`

Colocated next to the router, one file per source file — [testing § Naming and location](./testing.md#naming-and-location). `vi.mock("@starter/db")` with `mockDeep()`, plus `@starter/env/server` and `@starter/env/shared`; CI has no Postgres, and the worker-safe env module is distinct from the server one, so mocking only the latter leaves the real validator running. [testing § Designing tests for CI — mock every external boundary the import graph touches](./testing.md#designing-tests-for-ci--mock-every-external-boundary-the-import-graph-touches).

What the tests actually have to prove, because nothing else checks it — `pnpm policy:access-matrix` reads the procedure's builder chain and can see that a caller is signed in, never that a row belongs to them:

- the list is **scoped** (assert the `where` Prisma received, not just the returned rows: a deep mock hands back whatever the test put in, so a response assertion alone passes for a handler that selected everything) and **bounded** (`take: limit + 1`, and an over-large `limit` is an input error);
- a foreign id on `update` / `delete` raises **NOT_FOUND and writes nothing**;
- `create` files the row under the **session's** user and returns the projection.

A compile-time exact-type assertion in `packages/api/src/routers/client-boundaries.contract.test.ts` pins the client-facing shape, so a projection that quietly grows an `ownerId` fails `pnpm check-types`.

## 5. Route — `apps/web/src/routes/$lang/_app/_auth/projects.tsx`

A flat file under `_auth`, which is the layout that enforces a session — the route itself carries no guard and no `authClient.getSession()` call. [auth-and-routing § Protected child route](./auth-and-routing.md#protected-child-route).

The list is `useInfiniteQuery(orpc.projects.list.infiniteOptions(...))` + `<LoadMore>` — the default for any list; a flat `limit:` is for a genuinely bounded widget. [data-fetching § Infinite queries](./data-fetching.md#infinite-queries).

All four display states go through one `<QueryBoundary>`: `<SkeletonList>` while pending (never a spinner — skeletons mirror the final layout), an inline "Try again" card on error, an `<EmptyState>` with a create CTA when there is nothing yet, and the list otherwise. [loading-and-errors § Error state — QueryBoundary + InlineRetry](./loading-and-errors.md#error-state--queryboundary--inlineretry) and [loading-and-errors § Empty states](./loading-and-errors.md#empty-states).

Row actions live in a non-exported local section component in the same file. **Do not export a component function from a route file** — exported route components can rejoin the eager bundle graph. [react-composition § Splitting Route Files](./react-composition.md#splitting-route-files).

There is no `useEffect` here, and there is no room for one: the overlays hold their target row in `useState`, and the edit form resets by remounting.

Regenerate the route tree after adding the file — `pnpm dev` (or a build) rewrites `apps/web/src/routeTree.gen.ts`. Never hand-edit it.

## 6. Overlays — `apps/web/src/components/projects/`

Three files, one per convention, plus the form they share:

| File | Overlay | Why |
|---|---|---|
| `create-project-dialog.tsx` | Dialog | [overlays § Create — Dialog](./overlays.md#create--dialog) |
| `edit-project-sheet.tsx` | Sheet | [overlays § Edit — Sheet](./overlays.md#edit--sheet) |
| `delete-project-dialog.tsx` | AlertDialog, type-to-confirm | [overlays § Delete — AlertDialog with type-to-confirm](./overlays.md#delete--alertdialog-with-type-to-confirm) |
| `project-form.tsx` | — | the shared name + notes form |

Triggers use Base UI's `render` prop, never Radix's `asChild`. The delete dialog wraps the shared `ConfirmDeleteDialog` rather than assembling its own AlertDialog — that component already solves the small-screen layout of a typed token plus two 44px actions.

The form is TanStack Form with native Zod (no adapter package), fields wired through `TextField` / `TextareaField`, and both `autoComplete` and `inputMode` stated because the prop union requires them on a text field whose `type` implies no keyboard. [forms § Minimal form](./forms.md#minimal-form) and [forms § Mobile keyboard / autofill attributes](./forms.md#mobile-keyboard--autofill-attributes).

The edit form resets by remounting on `key={project.id}` — never by syncing props in an effect. [forms § Edit forms — reset via `key={id}`](./forms.md#edit-forms--reset-via-keyid).

Each overlay owns its mutation through `useEntityMutation(orpc.projects.<x>.mutationOptions({ onSuccess }), { invalidateKey: orpc.projects.key() })`: a success toast, a namespace-wide invalidation, and the global `MutationCache` handler owning the error toast. Never hand-roll a `mutationFn` around `.call()`. [mutations § useEntityMutation — the common case, in one call](./mutations.md#useentitymutation--the-common-case-in-one-call).

Sharing one form between two overlays is an exception to the three-call-sites rule made on purpose: the two are the *same* form mirroring one server contract, and a second copy of a schema is the copy that drifts.

## 7. Locales — `packages/locales/src/<lang>/projects.json`

Every user-facing string goes through `t()`. Projects owns more than ~20 strings, so it gets its own namespace rather than living under `dashboard` — [i18n § Naming conventions](./i18n.md#naming-conventions).

A new namespace is registered in exactly two places:

1. the `NAMESPACES` tuple in `apps/web/src/i18n/config.ts`;
2. the namespace list in the i18n section of `AGENTS.md`, then `pnpm sync:agent-docs` to regenerate the harness mirrors (never hand-edit `CLAUDE.md`).

Write `en-US/projects.json` by hand and run `pnpm i18n:translate` to fill the others; it is idempotent and only pays for new keys. Per-locale wiring is not needed — the eager and lazy globs and the `locale-<tag>` chunk rule all match by directory.

## 8. Nav — `apps/web/src/lib/nav-items.ts`

Add the destination to `appNavItems` (id, path, `labelKey`, icon, audience, placements), extend the `AppNavPath` / `LangNavRoute` unions, add `items.projects` to every `nav.json`, and update `nav-items.test.ts` — its assertions are exact arrays, and it carries a regression guard per route for a reason: **this array is what renders the desktop header and the mobile bottom bar, so a route missing from it ships reachable only by typing its URL.**

Array order is also the source of truth for the nav slide direction, so where you insert it is a visual decision, not a formality.

Every link keeps the locale segment: the registry stores the bare path and `toLangRoute()` turns it into `/$lang/projects`, which is what the shell renders as `<Link to="/$lang/projects" params={{ lang }} />`. Never hardcode `/projects`. [i18n § URL routing](./i18n.md#url-routing).

## 9. Sitemap — `sitemap.md`

Add the route to the **Authenticated Routes** table and mention it in the navigation bullets. Do **not** add it to `PUBLIC_PATHS` in `apps/server/src/seo.ts`: that list is for indexable public content, and a per-user private list is neither.

## 10. Access matrix — `notes/02-users-and-roles.md`

`pnpm policy:access-matrix` runs in `pnpm verify:fast` and enforces two different things depending on whether the app has been through onboarding:

- **Always:** every procedure's chain must start at a builder registered in `procedureAccessLevels` in `packages/api/src/index.ts`, and pass only middleware registered in `middlewareAccessLevels`. `protectedProcedure` is registered at `authenticated`, so Projects satisfies this by construction. A role check written inline in a handler body is invisible to the gate. [custom-roles § When to create a middleware](./custom-roles.md#when-to-create-a-middleware).
- **Once `./notes/` exists:** every live procedure needs an `implemented` row in the access matrix binding its dotted path (`projects.list`, `projects.create`, `projects.update`, `projects.delete`), or the gate fails. Planned rows and prose mentions do not cover a live endpoint.

`scripts/access-matrix-pre-notes-baseline.json` is the reviewed floor for endpoints the **template** shipped; it is not an app access matrix, app endpoints do not belong in it, and CI never regenerates it. [custom-roles § Builder provenance and the pre-notes contract](./custom-roles.md#builder-provenance-and-the-pre-notes-contract).

The gate proves sign-in. It cannot see ownership scoping inside a handler — that is what step 4's tests are for, and it says so on every run.

## Before you hand it back

```bash
pnpm verify:fast
```

Lint, the policy gates, citation checks, and the affected typechecks and tests. `pnpm verify` is the full sweep that runs in CI.

---

## Evolve or delete

Projects is an example, not a dependency. Nothing else in the template imports it, so removing it is a clean subtraction — and leaving a feature the product does not have is worse than deleting it, because the next agent will copy from it *and* wire it into a nav bar a real user sees.

**Delete these files:**

```text
packages/db/prisma/schema/projects.prisma
packages/api/src/routers/projects.ts
packages/api/src/routers/projects.test.ts
apps/web/src/routes/$lang/_app/_auth/projects.tsx
apps/web/src/components/projects/project-form.tsx
apps/web/src/components/projects/create-project-dialog.tsx
apps/web/src/components/projects/edit-project-sheet.tsx
apps/web/src/components/projects/delete-project-dialog.tsx
packages/locales/src/en-US/projects.json
packages/locales/src/es-MX/projects.json
patterns/golden-path.md
```

**And edit these back:**

- `packages/api/src/routers/index.ts` — drop the `projectsRouter` import and the `projects:` key.
- `packages/api/src/routers/client-boundaries.contract.test.ts` — drop the `projectsRouter` import and the two `ProjectsRouter*Contract` types.
- `apps/web/src/lib/nav-items.ts` — drop the entry, the `FolderKanban` import, and `/projects` from `AppNavPath` / `LangNavRoute`.
- `apps/web/src/lib/nav-items.test.ts` — drop the projects guard and remove `/projects` from the exact-array assertions.
- `apps/web/src/i18n/config.ts` — drop `"projects"` from `NAMESPACES`.
- `packages/locales/src/*/nav.json` — drop `items.projects`.
- `AGENTS.md` — drop `projects` from the namespace list and the golden-path line in the Patterns section, then `pnpm sync:agent-docs`.
- `patterns/README.md` and `patterns/getting-started.md` — drop the links to this file.
- `sitemap.md` — drop the route row and the navigation mentions.
- `apps/web/src/routeTree.gen.ts` — regenerate; never hand-edit.

**The schema is the one part that is not a delete.** Dropping a model drops its table, which is destructive, so it follows expand-contract like any other destructive change: ship the code-only removal first (keep `Project` and `User.Projects` in the schema, unchanged), verify nothing touches the table, and only then remove the model and the back-relation in a separate release applied with `APPLY_SCHEMA=dangerous`. [schema-changes-recipe § Remove a deployed feature's tables](./schema-changes-recipe.md#remove-a-deployed-features-tables).

A **fresh app that has never deployed**, whose only data is disposable and local, can do both halves at once with `pnpm db:push:dangerous` against its own local Postgres. That exception covers exactly this case — deleting the example before the first release — and it authorizes nothing about shared data.

Either way, finish with `pnpm verify:fast` and `pnpm knip`: a stale export or an orphaned locale key is what a half-finished removal leaves behind.
