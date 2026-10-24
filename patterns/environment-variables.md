# Environment variables

How env vars are declared, documented, generated for production, and kept from drifting.

**TL;DR for adding one:** declare it in a `packages/env/src/vars/*.ts` declaration object, add an entry to `scripts/lib/env-manifest.ts`, run `pnpm env:sync`, commit the regenerated `.env.example`. CI fails if you skip step two.

---

## The four moving parts

| File | Role |
| --- | --- |
| `packages/env/src/vars/{shared,server,web,native}.ts` + `packages/env/src/{shared,server,web,native}.ts` | **Validation**, split in two. `vars/` holds nothing but the Zod declaration objects (`sharedVars`, `serverVars`, …) and the `strictBooleanFlag()` helper, with **no import side effects**; the modules one directory up import those objects and call `createEnv`. Declare every key in `vars/` — a key declared inline in a `createEnv({…})` call fails CI (see [The CI gate](#the-ci-gate)). A var that isn't declared doesn't exist as far as the app is concerned. |
| `scripts/lib/env-manifest.ts` | **Description.** Where each value comes from (generated / prompted / defaulted), which feature group it belongs to, which deploy targets inject it, and the prose that documents it. |
| `.env.example`, `apps/web/.env.example`, `apps/native/.env.example` | **Generated.** Rendered from the manifest by `pnpm env:sync`. Do not hand-edit — your changes are overwritten. The root file renders in three tiers: core/required, optional feature blocks, then one "Advanced tuning" section of one-off knobs (`advanced: true`), with `hidden: true` vars omitted entirely; its documented-key count is budgeted at 70 by the CI gate. |
| `.env.docker.defaults` | Hand-maintained placeholders for the local agent-testing stack (`pnpm dev:docker`). Not covered by the manifest, because none of it is real. |

The schemas answer *"is this value valid?"*. The manifest answers *"where does this value come from, and who needs it?"* — which is exactly the knowledge a human filling out a production environment needs and the schema can't express.

## Validation vs loading (do not mix)

These are separate responsibilities. Mixing them breaks production SSR.

| Concern | Where | Rule |
| --- | --- | --- |
| **Validate** `process.env` | `@starter/env/shared`, `/server`, `/web`, `/native` | Zod only. **Never** `import "dotenv"`, never read `.env` from disk, never import `load-dotenv` / `root-env`. |
| **Load** a local `.env` file | `@starter/env/load-dotenv` (side effect) or `@starter/env/root-env` (`loadRootDotenv()`) | Run from **process entrypoints only**, and always **before** validation. |

```ts
// First import in every process entrypoint that needs the root .env
import "@starter/env/load-dotenv";
import { env } from "@starter/env/server"; // or /shared
```

`load-dotenv` is a side-effect-only module; the logic lives in `root-env`, which is import-time pure. Reach for `loadRootDotenv()` instead of the bare import when the file's module shape is dictated by a tool, or when you need `parsed` — the set of keys the `.env` file itself declared, which is how a caller tells a root-`.env` value from a platform-injected one. The one shipped `call`-mode entrypoint is **`apps/web/vite.config.ts`**, which reads `loadRootDotenv().parsed` for exactly that reason: to drop root-`.env` `VITE_*` keys and to ignore a file-supplied `PORT`. (`packages/db/prisma.config.ts` is *not* an example of this — it is one of the three files that must import `dotenv` directly; see below.)

**First-party entrypoints that must load the root `.env`** (checklist when adding a new script that imports `@starter/env/*` or a package that does — auth, db, i18n-translate, queue, mailer, …):

| Entrypoint | Mode | Why |
| --- | --- | --- |
| `apps/server/src/bootstrap.ts` | wrapper | The **built** Hono entry (`dist/index.mjs`) — see "source order is not enough" below |
| `apps/worker/src/bootstrap.ts` | wrapper | The **built** BullMQ worker entry, same reason |
| `apps/server/src/index.ts` | side effect | Hono process under `tsx` (`pnpm dev`), where plain ESM order applies |
| `apps/worker/src/index.ts` | side effect | BullMQ worker under `tsx`, same reason |
| `scripts/doctor.ts` | side effect | `pnpm doctor` |
| `scripts/translate-locale-bundles.ts` | side effect | `pnpm i18n:translate` → `@starter/i18n-translate` → `@starter/env/shared` |
| `packages/db/prisma/seed.cli.ts` | side effect | `prisma db seed` / direct `tsx` of the seed CLI |
| `apps/web/vite.config.ts` | `loadRootDotenv()` | Config-time only — TanStack Start server functions during `vite dev` run in the Vite process, not `apps/server`. **Not** in the client/SSR output graph. Needs `parsed` (see the precedence note below). |

**That table is enforced, not advisory.** `pnpm env:check-entrypoints` (`scripts/check-load-dotenv-contract.ts`, CI `lint` job) asserts each row loads the root `.env` in its declared mode, that every side-effect entry does it as its **first** import, that no validation module imports dotenv, that nothing outside the small allowlist below imports `dotenv` directly, and that this table and the script's `ENTRYPOINTS` list agree. Adding an entrypoint is a two-file change: the script and this table.

What the check *cannot* do is notice a brand-new process entrypoint that was never added to either list — nothing on disk distinguishes "entrypoint" from "module". It does catch the usual way that goes wrong, which is hand-rolling `dotenv.config({ path: "../../.env" })` in the new file.

### Source order is not enough once you bundle

`import "@starter/env/load-dotenv"` as the first import is correct under plain ESM: static imports evaluate in order, so the loader runs before `@starter/db` drags in `@starter/env/shared`. **It stops being true after bundling.** tsdown/rolldown inlines the tiny loader into the entry chunk's *body* while hoisting `@starter/env/shared` into a separate chunk that the entry imports statically — and ESM evaluates every static import before any of the importer's own statements. Net effect in `apps/server/dist/index.mjs`: `createEnv()` ran and threw on missing variables before `loadRootDotenv()` was ever reached, so a fully-populated root `.env` sitting next to the bundle was silently ignored.

That is why the two bundled apps have a `src/bootstrap.ts`:

```ts
import "@starter/env/load-dotenv";

await import("./index.js");   // dynamic — defers the entire rest of the graph
```

`tsdown.config.ts` builds `{ index: "./src/bootstrap.ts" }`, so the emitted file is still `dist/index.mjs` (what the per-app start script — `pnpm --filter server start` / `pnpm --filter worker start`; there is no root `start` — both Dockerfile `CMD`s, and `scripts/docker-entrypoint.sh` reference). `src/index.ts` keeps its own first-import loader because it is still the `tsx` dev entry.

**The rule that makes it work: a bootstrap file may have no static import other than the loader.** Add one and the bug returns, looking perfectly correct in source. `pnpm env:check-entrypoints` enforces the no-other-static-import rule and that each `tsdown.config.ts` actually points at its bootstrap. Because this only manifests in a built artifact, a source-only review will not catch a regression here — check `head -5` of the built entry.

**`vite.config.ts` precedence note.** Loading the root `.env` there means it reaches the Vite process, which it previously did not. Vite's `loadEnv` merges prefix-matching keys from `process.env`, so a `VITE_*` key in the **root** `.env` now reaches the client and outranks `apps/web/.env` — keep `VITE_*` in the app-local file. And `PORT` is a root variable that configures `apps/server`: the dev-server port fallback deliberately ignores a `PORT` that came from the file (via `parsed`) so it cannot silently bind the web dev server to the API's port, while a genuinely injected `PORT` still works.

**Why this split exists.** Auth, db, and the rest of the worker/server graph import the validation modules. The web app's TanStack Start server functions import `@starter/auth`, which imports `@starter/env/server`. Vite SSR leaves bare `dotenv` imports as runtime externals; the Docker runner does not guarantee `dotenv` is resolvable from `apps/web/dist/server/assets/`. Production already injects env vars — loading a file is unnecessary and the path from a bundled chunk is wrong.

**Do not** "fix" a missing-`dotenv` SSR error by adding `dotenv` to `apps/web` or copying more `node_modules` into the image. That papers over the design bug. Keep validation pure; load only from entrypoints.

**Production containers** inject env at runtime and ship **no** `.env` file (see the Dockerfile comments). `load-dotenv` is a no-op when the file is absent; server/worker tsdown **bundle** `dotenv` into their entrypoints so the app images do not need a runtime `dotenv` package for that path.

**The only three files allowed to import `dotenv` directly** (enforced by `pnpm env:check-entrypoints`; everything else goes through `load-dotenv` / `root-env`):

- `packages/env/src/root-env.ts` — the single implementation of root-`.env` loading
- `scripts/generate-secrets.ts` — `parse()` only, for the dotenv round-trip of generated blocks; never loads a file
- `packages/db/prisma.config.ts` — **must stay self-contained.** `packages/db` has a `postinstall` that runs `prisma generate`, so both Dockerfiles load this config during `pnpm install --frozen-lockfile`, which runs *before* `COPY . .`. At that point only the workspace `package.json` files and `packages/db/prisma*` exist — importing `@starter/env/root-env` there fails with `Cannot find module '/app/packages/env/src/root-env.ts'` and takes the image build down. Its fixed `../../.env` hop is safe precisely because Prisma pins the file to the package root and it is never bundled or relocated, which is what made the same hop unsafe in `packages/env/src/shared.ts`. If you change this file, rebuild both images — `pnpm build` and `pnpm test` will not catch it.

Vite's own `loadEnv` in `apps/web/vite.config.ts` is unrelated to dotenv-the-package — it reads `apps/web/.env*` for build-time `VITE_*` and is not affected by any of this.

## Which schema does my variable go in?

Four declaration modules, one per surface. All four live in `packages/env/src/vars/`.

- **`vars/shared.ts`** (`sharedVars`) — the server *and* the BullMQ worker read it (`DATABASE_URL`, `REDIS_URL`, `S3_*`, `BACKUP_*` / `RESTORE_*`, `SMTP_*`, `CHAT_*`, translation keys). The worker validates only this surface, so a worker-only deploy isn't forced to set `BETTER_AUTH_SECRET`.
- **`vars/server.ts`** (`serverVars`) — server-only (`BETTER_AUTH_*`, `SSO_*`, `VAPID_*`, `RATE_LIMIT_*`, `IMAGE_*`). `packages/env/src/server.ts` `extends` the shared env; **no key may appear in both** — `extends` merges, it does not override, and the scan fails outright on a key declared in two `vars/` modules.
- **`vars/web.ts`** (`webVars`) — `VITE_*`, inlined into the browser bundle at build time. **Public. Never a secret.**
- **`vars/native.ts`** (`nativeVars`) — `EXPO_PUBLIC_*`, baked into the app binary. **Public. Never a secret.**

Adding a fifth surface means adding a module to `vars/` and a `createEnv` caller beside it — nothing lists the modules by name, so the scan picks the new file up on its own.

## Generating a production environment

```bash
pnpm generate:secrets                   # interactive, prints to stdout
pnpm generate:secrets --target vps      # skip the deploy-target question
pnpm generate:secrets --all             # also list every skipped var, commented out
pnpm generate:secrets --out .env.prod   # write to a file instead of printing
```

What it does:

1. **Asks where you're deploying.** Two targets ship (`DEPLOY_TARGETS` in `scripts/lib/env-manifest.ts`): `vps` ("VPS / Dokploy") and `other` ("Other / not sure"). Neither declares any injected keys, so both are prompted for `DATABASE_URL` and `REDIS_URL`; the answer picks the reference doc named in the block's header and the note printed before the prompts. Both connection strings are `omittable` — a blank answer leaves the var out and records the omission in the header, which is the escape hatch for a platform that supplies it out of band.
2. **Generates the pure-entropy values** — `BETTER_AUTH_SECRET`, and the VAPID keypair if you enable push.
3. **Offers to reuse credentials from your shell.** For the groups that hold portable credentials (SMTP, object storage, translation), if those variables are already exported in the environment you run the command in, it lists them — secrets previewed, never printed in full — and offers to reuse them in one keypress. This is the fast path for pointing a second prototype at the same provider account. **The offer defaults to no**, because saying yes copies live credentials into a block that gets printed.
4. **Prompts for the rest** — pick-lists for enum values, yes/no for booleans, masked input for secrets. Optional feature blocks (SMTP, SSO, push, object storage, translation) are gated behind one yes/no each, so you aren't walked through forty prompts for features you're not using.
5. **Leaves defaults alone.** Anything with a documented default is omitted — the default *is* the recommended production value. `--all` also emits the variables the interactive run skipped, commented out, so you can uncomment and tune one: both defaulted vars and the optional ones you declined. It does **not** emit the keys the chosen deploy target injects (`platformInjects`, built from that target's `injects` list); those would be supplied by the platform and are excluded even under `--all`. Both shipped targets declare `injects: []`, so today that set is empty and nothing is dropped on this ground — the machinery is there for a target that does inject. The single exception to "leaves defaults alone" is `NODE_ENV`, always written as `production` — this block is for a deployed environment, and several env guards only harden when it is set. Feature flags that must flip with their group (`SSO_ENABLED`) are set automatically when you enable that group.
6. **Validates before printing anything** — twice. The collected values run through the real `@starter/env/server` schema (which pulls in `shared`) in a child process — this generator emits the server/worker block, so the `web` and `native` schemas are not exercised (a malformed origin, a missing required var, or a partially-configured feature fails here rather than at boot). Then the *rendered block* is parsed back with dotenv and compared against what was collected, so a quoting bug can't hand you a file that decodes to different bytes than you typed.

Guardrails worth knowing:

- Prompts and progress go to **stderr**, the env block to **stdout** — so `pnpm generate:secrets > .env.prod` captures only the block.
- **Quoting matches what dotenv actually parses.** dotenv strips one layer of quotes and expands `\n`/`\r` inside double quotes *only* — it never unescapes `\\` or `\"`. So the encoder tries four forms in order: **unquoted** when the value is plain enough not to need it, then **single quotes** (fully literal), then **backticks** when the value contains a single quote, then **double quotes** for the narrow case that has both but no `"` or `\`. A value containing a single quote, a backtick, *and* a double quote or backslash cannot be written unambiguously at all, so the script refuses and tells you to set that one by hand. The intuitive "double-quote and backslash-escape" silently corrupts any credential containing a backslash or a quote, which is why the dotenv round-trip check in step 6 exists.
- **Interactive runs use Inquirer**; piped/non-interactive input falls back to a plain line reader (Inquirer reaches for `/dev/tty` when stdin isn't a terminal, which breaks scripted runs). Exactly one of the two ever attaches to `stdin` — do not add a second reader. A previous version ran a readline interface alongside a raw-mode handler for masked prompts; both received every keystroke, and every answer after a password prompt silently shifted into the next variable.
- Values marked `secret: true` are **masked as you type** and never echoed back.
- In the reuse listing, masking is **not** limited to `secret: true`. `SMTP_USER` is an IAM access key ID on SES, and an R2 `S3_ENDPOINT` embeds the account ID — anything offered for reuse either is a credential or names the account behind one, and the listing appears *before* you've agreed to anything. Values inherited from the environment are also re-validated (line breaks, `format`); a bad one is reported and prompted for instead of failing at the end of the run.
- A group with `requiredWhen` is **forced on, with a printed reason**, when an earlier answer makes it mandatory — answering yes to public signup makes SMTP non-optional, so it isn't offered as a choice. Contradictions surface at the prompt, not after you've answered everything. Vars with `format` are shape-checked at the prompt for the same reason.
- Vars marked `omittable` (`DATABASE_URL`, `REDIS_URL`) accept a **blank answer to leave them out** — for when the platform supplies them out of band. The omission is recorded in the block's header.
- `--out` **refuses to write to a path inside the repo that isn't gitignored** (checked with `git check-ignore`, not by filename), **refuses to follow a symlink** (the ignore check applies to the link, but the bytes land on its target), and refuses to overwrite. Files are written `0600`.
- It never reads your existing `.env`. Re-running generates a *new* `BETTER_AUTH_SECRET` — rotating that invalidates every session, so generate once per environment and keep it.

## Adding a new environment variable

1. Declare it in the right `packages/env/src/vars/*.ts` object (see the table above). Never inline in the `createEnv({…})` call one directory up.
2. Add an entry to `ENV_VARS` in `scripts/lib/env-manifest.ts`:

```ts
{
  key: "STRIPE_SECRET_KEY",
  group: "payments",          // must match an id in ENV_GROUPS — see below
  source: "prompt",           // generate | prompt | confirm | enable | default | manual
  required: true,             // required once its group is enabled
  secret: true,               // masked at the prompt, previewed not printed
  prompt: "Stripe secret key",
  hint: "Dashboard → Developers → API keys. Use the test key for staging.",
  example: "",
}
```

   Pick `source` by asking **who knows this value**:

   | `source` | Use when | Generator behaviour |
   | --- | --- | --- |
   | `generate` | It's just entropy (secrets, keypairs) | Produced automatically via `generator` |
   | `prompt` | Only the operator knows it (URLs, credentials, API keys) | Asked interactively; a pick-list when `choices` is set, masked when `secret` |
   | `confirm` | A boolean opt-in the operator should decide (`SIGNUP_ENABLED`) | Yes/no; emits `"true"` only on yes |
   | `enable` | A feature flag that must flip on with its optional group (`SSO_ENABLED`) | Set to `"true"` automatically when the group is enabled |
   | `default` | A documented default is right for production | Omitted; shown commented out with `--all` |
   | `manual` | Deliberate opt-in with no sensible prompt (`CORS_ORIGIN`) | Same as `default`, but carries prose in `.env.example` |

   Optional per-var fields worth knowing:

   | Field | Effect |
   | --- | --- |
   | `choices: [{ value, label?, description? }]` | Arrow-key pick-list instead of free text, and an `Allowed: a \| b \| c` line in `.env.example`. Use for every enum with **three or more** members. Two-state `strictBooleanFlag()` vars are `z.enum(["true","false"])` but read better as `confirm` (or a `default`) than as a pick-list — they intentionally have no `choices`. |
   | `omittable: true` | A blank answer leaves a `required` var out entirely, recorded in the block header. For values a platform may inject. |
   | `format: "origin" \| "push-subject"` | Shape-checked at the prompt, mirroring the Zod refinement, so a typo costs one retry instead of the whole run. |
   | `defaultFrom: "app"` | Says the `default` is an application-code fallback, not a Zod `.default()`. Required for honesty: the CI gate compares key sets, not defaults. |
   | `advanced: true` | Renders the var in the trailing **Advanced tuning** section of `.env.example` instead of its feature section — for one-off knobs (rate-limit budgets, image-transform limits, cache TTLs) a nontechnical operator should not trip over. Always commented with the default shown. Only valid on `default` / `manual` vars. |
   | `hidden: true` | Omits the var from `.env.example` entirely — for deep one-shot knobs (restore confirmations, db-applier modes) whose audience reads `patterns/` docs, not the example file. The manifest and schema stay complete; `generate:secrets --all` still lists it. Only valid on `default` / `manual` vars. |

   A whole new feature block gets a new entry in `ENV_GROUPS` with a `prompt` — that makes it optional and ships it commented out in `.env.example`. Other group-level fields:

   - `tuning: true` — every var has a default and nothing is worth asking about; the group is never prompted and appears only in `.env.example` and under `--all`.
   - `requiredWhen: { key, equals, because }` — force the group on (with the reason printed) when an earlier answer makes it mandatory, instead of failing validation at the end of the run.
   - `reuseFromEnv: true` — offer to reuse this group's values from the shell environment. Only for **portable** credentials you'd legitimately share across prototypes (SMTP, object storage, an LLM key). Never for per-app values like `BETTER_AUTH_URL` or `DATABASE_URL`, where silently inheriting another app's value is a footgun. Reuse is accepted or declined for the whole group, so any var inside it that identifies *one app* rather than the shared account behind it needs `reusable: false` — `S3_BUCKET` (a shared bucket commingles two apps' uploads) and `SMTP_FROM` (the app's own From: identity) both carry it.

3. `pnpm env:sync`, then commit the regenerated `.env.example` files alongside your change.

### If it isn't in a Zod schema

Set `inSchema: false` (as `APPLY_SCHEMA` does — it's read by `scripts/docker-entrypoint.sh` and `scripts/db-applier.sh`, never by the app). Otherwise the manifest→schema direction of the check will flag it as a typo.

## The CI gate

`pnpm env:check` runs in the `lint` job of `.github/workflows/pr-checks.yml` and fails on, in the order `scripts/sync-env-example.ts` checks them:

1. Anything that makes the **scan itself** untrustworthy — an unreadable `vars/` directory, a module that fails to import, a key that isn't SCREAMING_SNAKE, the same key declared in two modules, a zero-key result — or a variable declared **inline in a `createEnv({…})` call** instead of in `vars/`. Such a key is invisible to the scan below, so it would need no manifest entry, never reach `.env.example`, never be prompted by `generate:secrets`, and never be zeroed before validation. `assertNoInlineDeclarations` in `scripts/lib/env-schema.ts` reads the four `createEnv` modules with comments and string literals stripped, and fails on any SCREAMING_SNAKE key in object-literal position. The one exemption is an explicit `runtimeEnv: { … }` map — `packages/env/src/native.ts` must spell out `EXPO_PUBLIC_SERVER_URL: process.env.EXPO_PUBLIC_SERVER_URL` because Metro replaces each `process.env.EXPO_PUBLIC_*` member expression at build time, and that mapping *references* a variable rather than declaring one. The match is deliberately loose (`server: { ...sharedVars, SNEAKY: z.string() }` is a one-line hole); the cost of a false positive is a message telling you to move the declaration into `vars/`, which is where it belonged anyway.
2. A key in a Zod schema with no manifest entry.
3. A manifest entry naming a key no schema declares (typo or stale entry) — unless `inSchema: false`.
4. A duplicate key in `ENV_VARS`.
5. A var whose `group` doesn't exist in `ENV_GROUPS`, or whose `file` disagrees with its group's. Both would make the var **invisible** — rendering and prompting each walk groups → vars, so a mistyped group name drops the var from `.env.example` *and* from every prompt while the key-set checks above still pass.
6. An incoherent presentation flag: a var marked both `hidden` and `advanced`, or either flag on a var whose `source` is not `default`/`manual` (prompted, generated, and enable vars must stay visible in their own section).
7. A `.env.example` that doesn't match what the manifest renders — and, on the root file, one documenting **more than 70 keys** (active or commented). That file is the surface a nontechnical operator reads; when a new var pushes it over budget, mark one-off knobs `hidden`, or fold per-surface knobs into a shared budget (the pattern the five `RATE_LIMIT_<FAMILY>_*` pairs follow) — don't grow the file. A target file that is absent is skipped rather than fatal: removing a feature module ([removable/*](./removable/)) can delete one, and aborting here would leave you unable to regenerate the files that remain.

The schema → manifest check (2) is the reason this gate exists. Without it, adding an env var and forgetting the manifest produces a `generate:secrets` that silently omits it, and the omission doesn't surface until a production container fails to boot.

### How the scan reads the key set

The schema scan (`scripts/lib/env-schema.ts`) does not parse source at all. It enumerates every `.ts` under `packages/env/src/vars/` (skipping `.d.ts` and `.test.ts`), `await import()`s each one, and takes `Object.keys()` of every export that looks like a declaration object — a non-empty plain object whose values all quack like Zod schemas (`parse` + `safeParse`). Anything else a module exports (the `strictBooleanFlag` helper, a type) is ignored. Directory enumeration rather than a hardcoded module list is the point: a new declaration surface is picked up the moment the file lands.

**This is why `vars/` exists.** Importing the *validation* modules would be the obvious way to read the key set, and it does not work: `packages/env/src/{shared,server,web,native}.ts` call `createEnv`, which parses `process.env` at import time and **throws when required variables are unset** — exactly the situation in CI, where nothing is set and the check most needs to run. So the declarations were split into modules that hold nothing but Zod objects and have **no import side effects**: no dotenv, no validation, no `process.env` reads. Keep it that way. A stray side effect in `vars/` — even an innocent-looking `import "@starter/env/load-dotenv"` — turns a passing check into an import error, and the scan reports that as fatal rather than continuing with a partial key set.

Two guards keep the scan honest about what it cannot see:

- **A `vars/` module that exports no declaration object is an error**, not a silent skip. A file that declares nothing either is a mistake or does not belong in that directory; staying quiet about it lets its keys go unchecked.
- **`assertNoInlineDeclarations`** covers the hole the import cannot: a key declared inline in a `createEnv` call, bypassing `vars/` entirely. That is part of CI failure mode 1 above.

**Read keys, not text.** The old scanner tokenized source and read structure out of `createEnv` calls, and every hole it ever had came from that: a hardcoded file list missed a new schema file, a line-regex missed keys and invented phantom ones, and a regex used merely to *locate* `server: {` matched the same text inside a comment, silently swapping the real key set for a decoy. `Object.keys()` on an imported object has none of those failure modes — the only text-matching left in the file is the inline-declaration guard, which is allowed to be approximate because its worst case is a false positive with a clear message.

When the scan **can't** read something — an unreadable `vars/` directory, a module that fails to import, a key that isn't SCREAMING_SNAKE, the same key declared in two modules, or a zero-key result — it reports an error, and both callers treat that as fatal: `env:check` fails, and `generate:secrets` refuses to validate. A degraded scan under-reports keys, and every missed key is one the validator forgets to zero, which lets the repo's own `.env` satisfy it in the child process and turn a broken block green.

**What it still cannot catch:** a `default` or `hint` in the manifest that has drifted from reality. The gate compares key *sets*. If you change a Zod `.default()`, update the manifest by hand — nothing will tell you.

## Agent notes

- **Adding an env var is a two-file change**, always: a `packages/env/src/vars/*.ts` declaration + the manifest. Then `pnpm env:sync`. Declaring it inline in a `createEnv({…})` call fails CI.
- **Nothing in `packages/env/src/vars/` may have import side effects.** The scan imports those modules; a dotenv load or a `process.env` read there breaks `pnpm env:check` and `pnpm generate:secrets` at once.
- **Removing a feature module** ([removable/*](./removable/)) means deleting its group and its vars from the manifest, then `pnpm env:sync`. A ripped-out module that still prompts for its API key is a bug.
- **Dependency updates and repo cleanups**: if a bump changes a library's configuration surface (a renamed env var, a new required one, a changed default), the manifest is part of that change. `pnpm env:check` catches a schema key you forgot, but it **cannot** catch a stale `hint`, a wrong `default` mirrored from the schema, or a provider that no longer needs a key you still prompt for. Re-read the affected group when you touch the schema.
- **Never put a real value in the manifest.** `example` fields are placeholders that get committed. Secrets come from `generate` or `prompt` at runtime.
- The `default` field on a var is documentation mirroring the schema — it does not *set* anything. If you change a default, change it in the schema and update the manifest to match.

## Related

- [production-hardening](./production-hardening.md) — what to verify before real traffic
- [infra-notes](../infra-notes.md) — the cross-platform deploy contract and `APPLY_SCHEMA`
- [deployment-vps](./deployment-vps.md) (default)
- [getting-started](./getting-started.md) — first-run setup (`pnpm run setup` for local dev)
