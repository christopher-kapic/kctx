# Turborepo Remote Cache (Vercel) for faster Docker builds

> Make `turbo build` download a previously-built app's output instead of rebuilding it. The concrete win on this stack: builds of the same commit share results — CI and the deploy build, the `Dockerfile` build and the `Dockerfile.worker` build (each image runs `turbo build` on its own and recompiles the same shared packages), a rollback or retry — so the second one replays the multi-minute TypeScript/Vite compile instead of re-running it. That pays off most on the default Dokploy/VPS path, where builds are slow and memory-tight ([patterns/deployment-vps.md § Build OOMs](./deployment-vps.md)).

This is the Turborepo-specific layer on top of caching you already have. Your `Dockerfile` already orders `COPY <package.json>` + `pnpm install` **before** `COPY . .`, so the install layer is cached, and Docker **layer** caching covers the remaining steps wherever your builder retains layers (a self-hosted builder depends on its host Docker cache). Remote cache is the piece that speeds up the one step those don't reliably help: `RUN pnpm turbo build`.

## When it helps (and when it doesn't)

Remote cache is a hash keyed on each task's inputs (source files, dependencies, env vars the task declares in `turbo.json` — `BUILD_VERSION` for `build` — and, via Turbo's framework inference, `VITE_*` env vars). A cache **hit** replays a stored output in seconds; a **miss** runs the build normally and uploads the result.

- ✅ **You changed one app, not the other.** Turbo skips the untouched app — its inputs hash-match a prior build — as long as `BUILD_VERSION` didn't change: this repo hashes it into every `build` task, and the deployment docs wire it to the commit SHA, so with the arg passed a new commit misses even the untouched app (leave it unset and this is the everyday win — see correctness notes).
- ✅ **CI already built this commit.** The deploy build replays CI's output (or vice-versa) because the hash is identical across machines — including the same `BUILD_VERSION` string (a full SHA and `git rev-parse --short HEAD` hash differently).
- ✅ **You redeployed the same commit** (rollback, config-only change, retry).
- ❌ **A from-scratch build where everything changed** — e.g. a lockfile bump that invalidates every package. Every task misses; you pay full build time plus a small upload. Remote cache never makes a cold build slower in a way you'll notice, but it can't speed one up either.

It does **not** replace Docker layer caching or speed up `pnpm install` — those are separate mechanisms that are already in place.

## Cost

**$0.** Vercel's Remote Cache is free and usable even if you host nothing else on Vercel — you only use it as a cache backend. No credit card, no per-build charge. (If you ever outgrow it or don't want build artifacts on a third party, you can self-host a drop-in replacement like `ducktors/turborepo-remote-cache`; that's out of scope here.)

## Complexity

Medium, one-time. Two env vars — the Dockerfile `ARG`/`ENV` block already ships (Step 2), so the edit is two `--build-arg`s on the Dokploy/VPS or CI builds. ~30–45 minutes including verifying a cache hit. Nothing about the running app changes — this is purely build-time.

---

## Step 1 — Get a token and team slug from Vercel

1. Create a Vercel account (free) at <https://vercel.com> if you don't have one.
2. Generate an access token: **Account Settings → Tokens → Create Token**. Scope it to your team, give it a clear name (`turbo-remote-cache-deploy`), and copy the value — this is `TURBO_TOKEN`.
3. Find your team slug: it's the `…/teams/<slug>` segment in your Vercel dashboard URL, or **Team Settings → General → Team ID/slug**. This is `TURBO_TEAM` (pass the **slug**, e.g. `my-team`, not the `team_xxx` ID).

Treat `TURBO_TOKEN` like any other secret — it grants read/write to your build cache. Anyone with it can read your build outputs or poison the cache, so keep it out of git and out of the shipped image (the steps below ensure both).

## Step 2 — The Dockerfiles already accept the token (nothing to edit)

Both `Dockerfile` and `Dockerfile.worker` **ship the `ARG`/`ENV` block** in their `builder` stage, a few lines above the `RUN pnpm turbo build …` line (a `NODE_OPTIONS` heap-headroom line sits between):

```dockerfile
# --- Turborepo Remote Cache (patterns/turbo-remote-cache.md) ---
ARG TURBO_TOKEN=""
ARG TURBO_TEAM=""
ENV TURBO_TOKEN=$TURBO_TOKEN \
    TURBO_TEAM=$TURBO_TEAM
```

It is **present-but-inert by default**: with both empty (the default on a fresh clone), turbo reports `NotLinked`, prints "Remote caching disabled", and builds normally with the local cache — no error, no behavior change. Turbo *never* fails a build over a missing, unreachable, or unauthorized remote cache; it always falls back to local. So this is genuinely "just works when set / just skips when not" — you don't touch the Dockerfiles at all, you only **provide the values** (Step 3).

> ⚠️ **The block lives in the builder stage only — keep it there.** Both Dockerfiles are multi-stage; the final `runner` stage is `FROM base` and does **not** inherit the builder's `ENV`, so the token never reaches the shipped image. If you ever move or duplicate the block, keep it out of `base`/`runner`, and per [AGENTS.md § Dockerfiles — keep server and worker in sync](../AGENTS.md) mirror any change across **both** files.

**How the values reach the build.** Turbo reads `TURBO_TOKEN` + `TURBO_TEAM` from the environment at `turbo build` time (**both** required — a token alone is ignored). No platform forwards service env into the Docker build automatically, so pass them explicitly at build time: `docker build --build-arg TURBO_TOKEN=… --build-arg TURBO_TEAM=…` (Dokploy/VPS), or the equivalent build-arg wiring in your CI image build.

The build line itself needs no change — `turbo` picks the cache up automatically when the vars are present:

```dockerfile
# Dockerfile:        RUN pnpm turbo build --filter=server --filter=web
# Dockerfile.worker: RUN pnpm turbo build --filter=worker
```

> **Hardening (optional).** Passing the token as a build `ARG` keeps it out of the final image but it can appear in the builder's intermediate-layer metadata on the build host. To avoid even that, use a BuildKit secret mount instead of an `ARG`/`ENV`:
> ```dockerfile
> RUN --mount=type=secret,id=turbo_token,required=false \
>     TURBO_TOKEN="$(cat /run/secrets/turbo_token 2>/dev/null || true)" TURBO_TEAM="$TURBO_TEAM" \
>     pnpm turbo build --filter=server --filter=web
> ```
> `required=false` + the `2>/dev/null || true` guard preserve the "just skips" property: if the secret isn't supplied, `/run/secrets/turbo_token` is absent, `TURBO_TOKEN` resolves to empty, and turbo builds locally — instead of the unguarded `cat` failing the build. (An unguarded `cat` of a missing mount errors, which would turn "no token" into a hard build failure — the opposite of what you want.) This requires a builder that can supply `--secret` (local `docker build --secret`, or CI).

## Step 3 — Pass the two vars to the build

Pass `TURBO_TOKEN` and `TURBO_TEAM` as build args to **both** image builds (each Dockerfile builds independently and each needs the cache):

```sh
docker build --build-arg TURBO_TOKEN="$TURBO_TOKEN" --build-arg TURBO_TEAM="$TURBO_TEAM" .
```

Because the cache is opt-in via these vars, a fork or fresh clone with them unset builds exactly as before — no breakage, just no remote cache.

## Step 4 — Verify a cache hit

1. Deploy once with the vars set. This is a **miss** (nothing cached yet) — Turbo uploads outputs at the end. Build logs show lines like `cache miss, executing <hash>`.
2. Trigger a second build that changes **only one app** (e.g. edit a server file, push) — with `BUILD_VERSION` unset (see the correctness note; if the SHA arg is passed, verify with a same-commit rebuild instead). In that build's logs, the untouched app's task reports a hit:
   ```
   • Packages in scope: server, web
   web:build: cache hit, replaying logs <hash>
   server:build: cache miss, executing <hash>
   ```
   `web:build` replaying instead of executing is the win. A build where nothing changed prints Turbo's `>>> FULL TURBO`.

To inspect what's happening, add `--summarize` to the build line locally (`pnpm turbo build --summarize`) and read the generated `.turbo/runs/*.json`, or run with `TURBO_LOG_VERBOSITY=debug` to see remote-cache HTTP calls.

## Correctness notes

- **`VITE_*` changes are handled automatically.** Turbo's framework inference includes `VITE_*` env vars in the hash for Vite packages, so changing `VITE_APP_NAME` busts `web:build`'s cache and you get a fresh bundle — no stale-content risk for client env.
- **`BUILD_VERSION` is hashed — already, and deliberately.** `turbo.json`'s `build` task declares `"env": ["BUILD_VERSION"]`, so its value is part of every `build` task's hash, and the deployment docs wire it to the commit SHA. Two consequences: while the SHA build arg is passed, every new commit is a guaranteed miss for every `build` task (the untouched-app replay above needs the arg unset — an empty value hashes the same everywhere); and two machines share a commit's cache only when they pass the same SHA string. In exchange, the baked `__APP_VERSION__` always identifies the commit actually deployed rather than the older commit a replayed bundle would carry. Dropping it from `env` buys back cross-commit replay at that price.
- **Read-only consumers.** If you want CI to *populate* the cache but the deploy build to only *read* it (or any other split), pass `--remote-cache-read-only` on the side that shouldn't write. Not required for the basic setup.

## Disabling / rolling the token

- **Turn it off:** drop the `--build-arg`s from the Dokploy/VPS or CI build and redeploy. The empty `ARG` default takes over and builds run normally.
- **Rotate:** revoke the token in Vercel (**Account Settings → Tokens**), create a new one, update the dashboard value. Old cache entries remain valid; only the credential changes.

## Self-hosting the backend, and artifact signing (optional)

The steps above use Vercel as the cache backend. Two more env vars cover the self-hosted and hardened cases — both follow the **same present-but-inert pattern**: unset → the feature is simply off, build unaffected.

- **`TURBO_API`** — point turbo at a self-hosted cache (e.g. [`ducktors/turborepo-remote-cache`](https://github.com/ducktors/turborepo-remote-cache), which fronts S3/GCS/Azure) instead of Vercel: `TURBO_API=https://your-cache.example.com`, with `TURBO_TOKEN`/`TURBO_TEAM` matching what that server expects. To wire it through Docker, add a matching `ARG TURBO_API=""` (+ `ENV`) beside the token block in **both** Dockerfiles. Unset = the Vercel default. Use this if you don't want build artifacts on a third party.
- **`TURBO_REMOTE_CACHE_SIGNATURE_KEY`** — opt-in HMAC signing of cache artifacts so a poisoned/forged entry is rejected. It only does anything when you also set `"remoteCache": { "signature": true }` in `turbo.json`; with signature verification **on**, this key is *required* (the build errors without it), so flip both together. Leave the key unset **and** `signature` off (the default) and nothing changes. Pass the key the same way as the token (build arg / secret mount, builder stage only).

## Related

- [patterns/deployment-vps.md § Build OOMs](./deployment-vps.md) — the default deployment; slow, memory-tight VPS builds are where a replay (which skips the compile) pays off most.
- [patterns/performance-and-bundling.md](./performance-and-bundling.md) — the *output* side of build speed (eager vs. lazy chunks). Orthogonal to this doc, which is about *build-time* caching.
- [AGENTS.md § Dockerfiles — keep server and worker in sync](../AGENTS.md) — why every change here lands in both files.
