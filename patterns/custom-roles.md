# Custom Roles

This template supports custom roles generically. The starter does not define product-specific staff roles because those come from the app's access matrix in `notes/02-users-and-roles.md`.

## Model

`User.role` is a string because Better-Auth supports comma-separated multi-role values such as `admin,manager`. Keep `admin` as the full-control operational role, then add domain roles from onboarding: `hr`, `dispatcher`, `support`, `partner`, `instructor`, or whatever the product needs.

Do not invent roles during implementation. Every custom role should appear in `notes/02-users-and-roles.md` with the feature rows it can read or write.

During onboarding, use the `Status` column from [getting-started.md § 3.2 Build the access matrix](./getting-started.md#32-build-the-access-matrix): `planned` rows describe future permissions before procedures exist. In the implementation change, mark each new live procedure's row `implemented`, bind its real dotted path, and add the role tests below. A live endpoint cannot remain planned.

## Server procedure pattern

Enforce the role in a **middleware registered in `packages/api/src/index.ts`**, wrapped in a builder the routers import. The role check then lives on the procedure's chain, where `pnpm policy:access-matrix` can read it statically. A check written inside a handler body is invisible to that gate: a matrix row that says "Staff:HR full, User none" is satisfied by any `protectedProcedure`, so the gate proves sign-in and nothing else.

Write the middleware and its builder in `packages/api/src/index.ts`, next to `requireAdmin`:

```ts
// packages/api/src/index.ts
import { ORPCError } from "@orpc/server";
import { hasRole } from "@starter/auth/roles";

// Generic: the role name comes from notes/02-users-and-roles.md, not from here.
export const requireRole = (role: string) =>
  o.middleware(async ({ context, next }) => {
    const userRole = context.session?.user.role ?? "";
    if (!hasRole(userRole, role) && !hasRole(userRole, "admin")) {
      throw new ORPCError("FORBIDDEN", { message: "Forbidden." });
    }
    return next({ context: { session: context.session } });
  });

// One builder per role. Builders are exported from this file and named `*Procedure`.
export const hrProcedure = protectedProcedure.use(requireRole("hr"));

export const procedureAccessLevels = {
  // ...existing builders
  hrProcedure: "authenticated",
} as const satisfies Record<string, ProcedureAccessLevel>;

export const middlewareAccessLevels = {
  // ...existing middleware
  requireRole: "authenticated",
} as const satisfies Record<string, ProcedureAccessLevel>;
```

The level in both registries is the *minimum* a caller must hold. A custom role is still `authenticated` from the matrix's point of view unless it implies admin — the registry says "signed in at least", the middleware says "and holds this role".

Then the router imports the builder and says nothing about roles:

```ts
// packages/api/src/routers/payroll.ts
import { hrProcedure } from "../index";

export const payrollRouter = {
  run: hrProcedure.handler(async ({ context }) => {
    // handler body — the gate already ran
  }),
};
```

Never re-declare `requireRole` or `hrProcedure` locally in a router file; a local declaration that shadows a registered name is rejected by the gate.

### Inline handler checks — single call site only

A role checked at the top of a handler body is **invisible to the access-matrix gate**: the gate reads the builder chain, so it proves the caller is signed in, never that they hold the role. Use it only for a genuinely single-call-site rule, and only with a test that covers the role, because nothing else catches a regression:

```ts
export const payrollRouter = {
  // Single call site. NOT seen by pnpm policy:access-matrix — the chain says
  // `authenticated`; only the test below proves "hr only".
  run: protectedProcedure.handler(async ({ context }) => {
    if (!hasRole(context.session.user.role ?? "", "hr")) throw new ORPCError("FORBIDDEN");
    // handler body
  }),
};
```

Keep the check before any database write. The moment a second procedure needs the same role, it becomes a registered middleware — see § When to create a middleware.

## Tests

Every implemented matrix row that grants custom-role access must have a server-side unit test (include these tests in the implementation plan for planned rows):

- unauthenticated user rejected by the base procedure,
- authenticated user without the role receives `FORBIDDEN`,
- user with the role succeeds,
- `admin` succeeds when admin is supposed to have full access.

Mock Prisma and external boundaries as described in [testing.md](./testing.md). Do not hit a real database.

## Route gates

Frontend route gates improve UX but do not enforce security. Hide navigation and redirect unauthorized users in the UI, but always enforce the role in the oRPC procedure. A user can call `/rpc` without your React route.

## When to create a middleware

The repo-wide rule is three call sites before extracting an abstraction. Authorization is the one exception ([AGENTS.md § Scope discipline](../AGENTS.md#scope-discipline)): **the second router that needs the same role check gets a registered middleware, not a second copy.** Two hand-written role checks drift, and drift in an access check is a data leak, so the bar is deliberately lower here.

"Registered" is literal. `packages/api/src/index.ts` exports two objects, `procedureAccessLevels` and `middlewareAccessLevels`, that list every builder a procedure chain may start from and every middleware it may pass to `.use()`, each with the minimum level it enforces. `pnpm policy:access-matrix` reads them statically and fails on any procedure built on something not listed — in the template too, before the app has any notes. So the extraction and the registration are the same edit:

1. Write the middleware once (in `packages/api/src/index.ts` next to `requireAdmin`, or in `packages/api/src/lib/` if it needs its own tests) and, if it is the whole gate, a builder such as `export const hrProcedure = protectedProcedure.use(requireRole("hr"))`. Builders are exported from `packages/api/src/index.ts` and named `*Procedure` — the gate treats any exported `*Procedure` that is missing from the registry as a gap. Routers must import both from there; a local declaration with the same name is rejected as shadowing.
2. Add `requireRole: "authenticated"` to `middlewareAccessLevels` (and `hrProcedure: "authenticated"` to `procedureAccessLevels` if you added a builder). The level is the *minimum* a caller must hold: a custom role is still `authenticated` from the matrix's point of view unless it implies admin.
3. Use it from both routers. Delete the inline check.

Keep the middleware generic: it should accept role names from the app's access matrix, not bake in template-specific roles.

### Builder provenance and the pre-notes contract

Routers may import a registered builder from `packages/api/src/index.ts` directly, through a simple alias, or through a re-export. Do not construct a builder with `.use()` in `packages/api/src/lib/` (or another router helper) and then import it into a router: the static policy rejects that shape rather than guessing which middleware it carries. A middleware implementation may live in `packages/api/src/lib/` when it needs its own tests, but its exported, registered builder must still be declared in `packages/api/src/index.ts`.

`scripts/access-matrix-pre-notes-baseline.json` freezes the currently shipped procedure paths and their minimum registered access levels. Its name reflects the template's first use, but the reviewed compatibility floor remains enforced after onboarding as well: a product matrix adds requirements and cannot omit or downgrade these endpoints. It is not an app access matrix and not a source of product roles. CI never generates it: changing a listed endpoint's minimum, adding a newly shipped template endpoint, or removing a feature requires an intentional update in the same reviewed change. A stale path after following a removal recipe fails the gate until that maintenance is performed. App-specific endpoints belong in implemented product-matrix rows, not in the template baseline. Once notes exist, every live endpoint outside that baseline must have an implemented matrix binding as well as a registered builder; prose mentions and planned rows cannot supply coverage. Before notes exist, the template's baseline and registry gates remain active.

A one-off domain check that is not an authorization gate — a feature flag, a "is the export window open" guard — may stay inline. Put `// access:audited <middlewareName> — <why this is not a role check>` in the `//` comment lines directly above the router property (no blank line or `/** */` block in between) so the gate knows it was a decision, not an omission. **The escape names the middleware it excuses** (`// access:audited requireExportWindow — time window, not a role check`): it covers that one identifier on that one property, and a comment that names nothing, or names a middleware the chain does not pass to `.use()`, is a failure. The chain must still start at a registered builder.
