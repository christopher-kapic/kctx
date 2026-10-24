# Agent UI testing with a disposable docker stack

A port-parameterized local docker-compose stack agents (or humans) can spin up
on any free port, browse in a headless/remote browser, and tear down again. It
exists so an AI agent working on UI changes can actually **see the app it just
edited** end-to-end — not just type-check it.

This is a local-only tool. It is **not** a deployment target and nothing in it
is safe to copy into production. See [§ Security](#security) for why.

## For humans: asking an agent to test a UI change

You don't need to remember any commands below. Once your agent client has this
repo checked out and a browser CLI installed (see
[§ Driving a browser from the terminal](#driving-a-browser-from-the-terminal)),
you can just say things like:

- *"Bring up the dev stack and tell me what the dashboard looks like."*
- *"Run the app and click through the sign-in → dashboard → settings flow,
  then show me any errors in the server logs."*
- *"Test the new card I just added on the `/dashboard` route — check it
  renders on mobile and desktop widths."*
- *"Fix the layout bug on `/settings`. Iterate with the browser until the
  form submits cleanly."*

The agent picks a free port, starts the stack, navigates to the page, reports
what it sees, and tears the stack down when done — all documented below so it
can follow without guessing.

To test *authenticated* features, read
[§ Testing auth-gated features](#testing-auth-gated-features). There is **no**
auth bypass — you sign up and sign in for real, but the dev stack ships a local
email sink (mailpit) so the verification email is captured locally with zero
credentials. The real signup → email-verification → 2FA flow works fully
offline.

## TL;DR

```bash
# 1. Pick a free port
PORT=$(pnpm --silent find-free-port)

# 2. Start the stack (first run ~1-2 min, subsequent ~10s)
pnpm dev:docker "$PORT"

# 3. From another terminal (or agent), browse it → http://localhost:$PORT
#    Tail the server logs while you test:
pnpm dev:docker:logs "$PORT"

# 4. When done
pnpm dev:docker:down "$PORT"
```

Each invocation uses `COMPOSE_PROJECT_NAME=<repo-slug>-<path-hash>-<port>`, so
multiple agents can run their own stacks on the same machine without colliding
even when two repos share the same directory name — each gets its own network,
containers, and ephemeral volumes.

## Why this exists

The normal `pnpm dev` flow requires a developer to already have portless,
Postgres, and Redis running locally, and to have filled in `.env`.
None of that works if you want an agent to:

1. discover a free port on a shared build machine,
2. boot a full stack in isolation from any other agent on the same box,
3. drive a browser against it to verify a UI change,
4. tear everything down and leave no state behind.

`docker-compose.agent.yml` + the three wrapper scripts do exactly that, with
`docker` or `podman` as the runtime. The same runtime-detection helpers also
back everyday local-service commands like `pnpm db:*` and `pnpm dev:services`,
so podman-only hosts can start the normal Postgres/Redis stack without Docker.

## Commands

All are thin wrappers around `scripts/dev-docker*.sh`.

| Command | What it does |
|---|---|
| `pnpm find-free-port [start] [end]` | Prints the first free TCP port in range (default `3100..4100`). Use in `$(…)`. |
| `pnpm dev:docker <port>` | Boot the dev profile (hot-reload `pnpm dev:raw` inside a container). Web bound to `http://localhost:<port>`. |
| `pnpm dev:docker <port> --prod` | Boot the prod profile — builds `Dockerfile` + `Dockerfile.worker` and runs the real shipped bundle (server + worker as separate containers). Slower first run, closer to production. |
| `pnpm dev:docker <port> --reset` | Tear the stack down (wiping the ephemeral DB) before starting. Equivalent to `pnpm dev:docker:down <port> && pnpm dev:docker <port>`. |
| `pnpm dev:docker:logs <port> [service]` | Follow logs (`-f`, 200-line backfill) for a service. Default: auto-picks the running `app-dev` or `app-prod` container. |
| `pnpm dev:docker:down <port>` | Stop the stack and wipe its ephemeral volumes. |

After `pnpm dev:docker` starts, the script writes `.agent-ports.json` at the
repo root with the URL and helper commands — an agent can `cat` it to
re-discover what's running without remembering the port:

```json
{
  "port": 3100,
  "project": "template-a1b2c3d4-3100",
  "volumeRoot": "/abs/path/to/repo/.docker-volumes/template-a1b2c3d4-3100",
  "runtime": "docker",
  "profile": "dev",
  "url": "http://localhost:3100",
  "logs": "pnpm dev:docker:logs 3100",
  "down": "pnpm dev:docker:down 3100"
}
```

`.agent-ports.json` is gitignored.

## How it's wired up

```
┌────────── host ──────────┐
│                          │
│   browser @ :$PORT ──────┼──▶ ┌─ compose project: <repo-slug>-<path-hash>-$PORT ─┐
│                          │    │                                       │
│                          │    │  ┌─── app-dev container ───┐          │
│                          │    │  │  pnpm dev:raw (turbo)    │          │
│                          │    │  │   ├─ vite (web) :3001 ◀──┼── port   │
│                          │    │  │   ├─ server    :3000     │  map    │
│                          │    │  │   └─ worker              │          │
│                          │    │  └──────────────────────────┘          │
│                          │    │                                       │
│                          │    │  postgres:5432   redis:6379            │
│                          │    │   (internal — no host port binding)    │
│                          │    └────────────────────────────────────────┘
└──────────────────────────┘
```

One container runs `pnpm dev:raw`, which bypasses portless and lets `turbo` fan
out into server, web, and worker. The vite dev server inside the container
binds `0.0.0.0:3001` (so the host port mapping can reach it) and proxies
`/api`, `/rpc`, `/ws` to the in-container server on `3000`. Only the vite port
is mapped to a host port, and that mapping is published on `127.0.0.1`
(loopback) by default via `BIND_ADDR` — so the stack is never reachable off-box
even on a shared VPS. Postgres and Redis are reachable only from inside the
compose network.

The `--prod` profile replaces the dev container with two real production
images (`Dockerfile` → `app-prod`, `Dockerfile.worker` → `worker-prod`):
server and worker as separate containers, SSR bundle served by the Hono
process, no hot reload.

## Database behavior — ephemeral but restartable

The stack deliberately has **no named volume for Postgres or Redis**. Data
lives in the container's writable layer:

| Action | Effect on data |
|---|---|
| `pnpm dev:docker <port>` (first run) | Fresh DB, schema push applies |
| `pnpm dev:docker <port>` (subsequent run, no down between) | Same container reused, **state preserved** |
| Code change triggering container restart | Same container, **state preserved** |
| `pnpm dev:docker:down <port>` | Container removed, **state wiped** |
| `pnpm dev:docker <port> --reset` | Shorthand for `down` then `up` — fresh DB |

This is what you want for agent testing: a clean slate whenever you ask for
one, stable state across quick iteration within a session.

## Environment variables

### The goal

For local docker-compose testing, a fresh clone should boot with **zero manual
env setup**. The only reason to touch an env file is to plug in a third-party
integration that needs real credentials (paid API keys, SSO IdP, real SMTP).

### How it's layered

`docker-compose.agent.yml` loads env files in this order — later overrides earlier:

1. `.env.docker.defaults` (committed) — placeholder values that make the stack
   boot in isolation. Defines `BETTER_AUTH_SECRET`, `SIGNUP_ENABLED`, and points
   SMTP at the in-stack **mailpit** sink (`SMTP_HOST=mailpit`, `SMTP_PORT=1025`,
   `SMTP_FROM=noreply@dev.local`, no user/pass) so email **works offline** — a
   fresh clone can run the real signup → email-verification → 2FA flow with zero
   credentials. SSO/VAPID/ADMIN_EMAILS are left unset (those features gracefully
   degrade in dev). See [§ Testing auth-gated features](#testing-auth-gated-features).
2. `.env` (gitignored, optional) — **only for real external integrations** you
   want layered on top. Your `.env` wins over the defaults file. Example:
   ```bash
   # .env — gitignored
   SMTP_HOST=smtp.postmarkapp.com
   SMTP_PORT=587
   SMTP_USER=real-token
   SMTP_PASS=real-token
   SMTP_FROM=noreply@yourdomain.com
   VAPID_PUBLIC_KEY=BK…
   VAPID_PRIVATE_KEY=…
   ```
3. `environment:` block in the compose file — hardcodes the in-compose service
   URLs (`DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_URL`) so the app always
   talks to the compose postgres/redis, never to whatever's in your local `.env`.

The weak-secret detector in `packages/env/src/server.ts` logs a warning at
startup because `BETTER_AUTH_SECRET` is a placeholder. **That warning is
intentional** — it is the stack telling you "you are in local-insecure mode."
The same validator *throws* in production, so a production deploy refuses to
boot with a placeholder.

## Testing auth-gated features

**There is no auth bypass.** You test the genuine flow — sign up, verify your
email, enable 2FA, sign in — exactly as a real user would. The only thing the
dev stack does for you is capture the outgoing email locally so you can read the
verification link without owning a real mailbox. Two flows are supported.

### Flow A — mailpit (the default, offline, zero credentials)

`docker-compose.agent.yml` ships a `mailpit` service (image
`axllent/mailpit:v1.21`) that accepts any SMTP connection and exposes a web UI +
REST API. `.env.docker.defaults` points the app's `SMTP_*` at it
(`SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_FROM=noreply@dev.local`, no
user/pass), so a fresh clone sends verification email to mailpit with **zero
setup**. Mailpit's UI/API are published on host port = web `PORT` + 5000, and
`scripts/dev-docker.sh` writes that URL into `.agent-ports.json` under the
`"mailpit"` key.

The full verified flow:

1. Open `http://localhost:<port>/` and go through the real **sign-up** form.
2. The app sends a "Verify your email" message — it lands in mailpit.
3. Read the captured email and open the verification link. The user's
   `emailVerified` flips to `true`.
4. **Log in** with the same credentials.
5. **Enable 2FA** — the TOTP base32 secret is shown in a `<code>` element on the
   setup page. Compute a code from it and confirm.
6. Log out, log back in, and supply a fresh TOTP code → you land on the
   dashboard.

Read a captured email from the host (the verified commands):

```bash
MAILPIT=$(python3 -c "import json;print(json.load(open('.agent-ports.json'))['mailpit'])")
curl -fs "$MAILPIT/api/v1/messages" | python3 -m json.tool          # list
ID=$(curl -fs "$MAILPIT/api/v1/messages" | python3 -c "import sys,json;print(json.load(sys.stdin)['messages'][0]['ID'])")
curl -fs "$MAILPIT/api/v1/message/$ID"                              # one message (HTML/Text fields)
```

The HTML body double-encodes `&` (as `&amp;amp;`), so when extracting the
verification URL, HTML-unescape it (`python3` `html.unescape`). The link looks
like `http://localhost:<port>/api/auth/verify-email?token=...&callbackURL=%2F`.

From inside the compose network (no host port needed):

```bash
docker exec <project>-app-dev-1 node -e \
  "fetch('http://mailpit:8025/api/v1/messages').then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))"
```

(`<project>` is the `project` field in `.agent-ports.json`.)

### Flow B — real delivery via `.env` (e.g. AgentMail)

To deliver email to a real inbox you control, set `SMTP_*` in the **gitignored
root `.env`**. Because compose layers `.env` *after* `.env.docker.defaults`,
those values override the mailpit defaults. SMTP creds belong in `.env`, **not**
the compose file — the compose `environment:` block is reserved for in-compose
service URLs and would override `.env`.

[AgentMail](https://agentmail.to) is both an SMTP relay and an inbox, which makes
it convenient for fully-automated runs:

```bash
# .env — gitignored
SMTP_HOST=smtp.agentmail.to
SMTP_PORT=587
SMTP_USER=<your-inbox>@agentmail.to
SMTP_PASS=<AgentMail API key>
SMTP_FROM=<your-inbox>@agentmail.to   # From must equal the inbox
```

Read the inbox with the `agentmail` CLI:

```bash
agentmail inboxes:messages list --format json
agentmail inboxes:messages get --inbox-id <inbox> --message-id <id> --format json
```

### Caveat — the auth rate limiter

The auth rate limiters (`apps/server/src/rate-limit.ts`) are strict: sign-up is
capped at **10 requests per hour** on `/api/auth/sign-up/*` with a
**15-minute block**, and the general `/api/auth/*` ceiling is **30 requests
per 60 s** with a **5-minute block** once tripped. A multi-step automation run
(signup + login + enable-2FA + re-login) can trip them. This is the realistic
friction the old bypass used to hide. Reset it in the ephemeral dev stack:

```bash
proj=$(python3 -c "import json;print(json.load(open('.agent-ports.json'))['project'])")
docker exec ${proj}-redis-1 redis-cli FLUSHALL
docker restart ${proj}-app-dev-1
# then wait for the server to answer again:
# until curl -fs -o /dev/null "http://localhost:<port>/"; do sleep 2; done
```

### Caveat — TOTP codes

TOTP codes are windowed to 30 s — recompute the code right before you submit it,
or it will already have expired. The base32 secret appears in a `<code>` element
on the 2FA setup page.

## Security

Everything in `.env.docker.defaults` — and the compose stack's design — is only
safe because of three assumptions. Break any and you are no longer looking at a
dev stack.

1. **It binds to localhost only.** Every published host port (vite + mailpit)
   maps against `127.0.0.1` via `BIND_ADDR` (default in `scripts/dev-docker.sh`),
   so the stack is unreachable off-box even on a shared VPS — where it matters
   most, since Docker writes its own iptables rules ahead of ufw/firewalld and a
   `0.0.0.0` binding would be public behind an otherwise-closed host firewall.
   Postgres and Redis are not exposed to the host at all. If you genuinely need
   LAN access (e.g. loading the PWA on a real phone), opt in deliberately with
   `BIND_ADDR=0.0.0.0 pnpm dev:docker <port>` — never hardcode `0.0.0.0:…`
   bindings into the compose file or publish the project over a tunnel.
2. **All data is ephemeral.** Postgres and Redis write to the container's
   writable layer, not a named volume. `pnpm dev:docker:down <port>` wipes
   everything. Don't store data you care about in the local dev stack.
3. **It never loads in production.** `docker-compose.agent.yml`,
   `.env.docker.defaults`, and `Dockerfile.dev` are all ignored by the
   production deploy pipeline (see `patterns/deployment-vps.md`).

### Shortcuts this file takes that would be CRITICAL bugs in production

| Shortcut | Why it's OK locally | Why it's unsafe for production |
|---|---|---|
| `BETTER_AUTH_SECRET` is a known, committed placeholder | DB is ephemeral, sessions don't outlive the stack | Anyone can mint valid sessions; generate with `pnpm generate:secret` |
| Postgres password is `password` | Not reachable from outside the compose network | Trivial credential — use a secret manager |
| `CORS_ORIGIN` unset, so CSRF plugin is off | Same-origin (vite proxies /api/rpc/ws) — browser blocks cross-origin preflight anyway | Set to the exact frontend origin; CSRF plugin activates automatically (see `patterns/production-hardening.md § 3 — CSRF Protection`) |
| `ADMIN_EMAILS` unset | No admin UI to test against by default | No one has admin privileges → fill it in via Dokploy secrets |
| `SMTP_*` points at the in-stack mailpit sink | Email is captured locally by mailpit — never delivered externally; the real verification flow works offline | Mailpit is a dev sink with no auth; configure a real SMTP provider so verification email actually reaches users |
| No TLS | `localhost` | Put the app behind HTTPS (Dokploy/Traefik handles this) |
| No rate-limit tuning | Defaults fine for one local browser | Tune per endpoint — see `patterns/production-hardening.md § 1 — Rate Limiting` |
| Postgres data in container writable layer | Wiped on `down` by design | Must use a managed DB with backups |

When you're ready to ship, read `patterns/production-hardening.md` and the
deployment walkthrough for your target — `patterns/deployment-vps.md` —
end-to-end. Nothing in this file transfers.

## Server logs — debugging from inside the container

The compose project name is deterministic
(`<repo-slug>-<path-hash>-<port>`), so container names and labels are
predictable. Four ways to get logs, by convenience:

### 1. The wrapper (recommended for agents)

```bash
pnpm dev:docker:logs <port>
# or pick a specific service:
pnpm dev:docker:logs <port> postgres
pnpm dev:docker:logs <port> redis
pnpm dev:docker:logs <port> app-dev
pnpm dev:docker:logs <port> worker-prod   # only under --prod
```

Streams with `-f` and a 200-line backfill. Ctrl-C detaches; the stack keeps
running.

### 2. Raw docker/podman (when the wrapper is not enough)

```bash
# List this project's containers
docker ps --filter "label=com.docker.compose.project=<repo-slug>-<path-hash>-$PORT"

# Last 500 lines without following
docker compose -p "<repo-slug>-<path-hash>-$PORT" -f docker-compose.agent.yml \
  --profile dev --profile prod logs --tail 500 app-dev

# One-shot snapshot (no follow, no backfill limit)
docker logs "<repo-slug>-<path-hash>-$PORT-app-dev-1"
```

Swap `docker` for `podman` if that's your runtime; the command shape is
identical. (The wrapper already does this detection for you.)

### 3. Exec into the container

```bash
docker exec -it "<repo-slug>-<path-hash>-$PORT-app-dev-1" sh
# Then: tail -f /app/*.log, run pnpm scripts, inspect prisma, etc.
```

Useful for a one-off command (e.g. `pnpm db:studio`,
`pnpm -F @starter/db exec prisma db pull --print`).

### 4. Browser-side errors

Server logs only cover the server. For client-side errors (React, vite HMR,
oRPC request failures), the browser console is the source of truth. Whichever
CLI you pick from the next section captures the console alongside the page
snapshot — together they give you the full picture of a failed interaction.

## Driving a browser from the terminal

Agents can't click a mouse. You need a CLI that spawns Chromium (or Firefox),
navigates to the dev stack, captures page state as an accessibility tree the
agent can reference, clicks elements by those references, and reports the
console output.

This repo recommends **`agent-browser`** as the default: bundled Chromium
(correct engine for testing this PWA), installs without `sudo`, returns
accessibility snapshots agents can click directly. If you already have a
preferred tool from the two below, use it — just be consistent in a session so
the browser daemon model doesn't thrash.

### Install once (headless Ubuntu)

Both recommended CLIs install in under two minutes and work fully headless.
They use separate browser installations — installing both costs disk but never
conflicts.

**Recommended: [`agent-browser`](https://www.npmjs.com/package/agent-browser)**

```bash
npm install -g agent-browser
agent-browser install     # downloads Chrome for Testing (~170 MB)
```

**Alternative: [`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli)**

```bash
npm install -g @playwright/cli@latest
# Install Firefox — NOT chromium. See "Why Firefox" below.
playwright-cli install-browser firefox
```

> **Not recommended on headless Ubuntu: `browser-use`.** Its `install` step
> runs `playwright install --with-deps` which pulls system packages via
> `sudo`, and even with `IN_DOCKER=true` (which should add the right Chromium
> flags) the daemon times out on launch in this environment. Use it inside a
> real Docker container or where you can `sudo`, or stick with the two above.

### The headless-Ubuntu gotchas

On a fresh headless Ubuntu box without `sudo`, each CLI has one quirk worth
knowing up front:

| CLI | Gotcha | Fix |
|---|---|---|
| `agent-browser` | Ubuntu 23.10+ blocks Chromium's unprivileged user namespaces via AppArmor, so Chrome crashes at launch with "No usable sandbox!" | Pass `--args "--no-sandbox"` on the **first** `agent-browser open` call in a session. The daemon reuses those args until `close`. If you `close --all` you must re-pass it on the next `open`. |
| `playwright-cli` | Default `chrome` channel expects system Chrome at `/opt/google/chrome/chrome`, not installed and `playwright install chrome` requires `sudo`. Bundled `chromium` is not exposed as a selectable channel. | Use `--browser firefox` and install it with `playwright-cli install-browser firefox`. Firefox runs cleanly headless without any `sudo`. WebKit also needs `libgtk-4` via `apt`, so skip it. |

### Why Firefox for `playwright-cli`?

This starter is a PWA targeting a Chromium engine, and `agent-browser` runs
Chromium natively — that is why it is the recommended default. `playwright-cli`
is an alternative for teams that already use Playwright everywhere, but its
on-headless-Ubuntu story pushes you to Firefox, which loses Chromium-specific
behavior (install prompt, service worker caching quirks, etc.). For most
starter UI testing the DOM works identically in both engines — for anything
more PWA-specific, use `agent-browser`.

### The agent's loop — recommended CLI

These commands go into a single agent session, top to bottom. The browser
daemon persists across invocations so each command is cheap.

```bash
# 1. Pick a free port and boot the dev stack (in a background shell)
PORT=$(pnpm --silent find-free-port)
pnpm dev:docker "$PORT" &

# 2. Wait for the dev server to start answering
until curl -fs -o /dev/null "http://localhost:$PORT/"; do sleep 2; done

# 3. First open of the session — MUST include --no-sandbox args
agent-browser open "http://localhost:$PORT/dashboard" --args "--no-sandbox"

# 4. Capture the page as an accessibility tree with refs (e1, e2, …)
agent-browser snapshot

# 5. Read the visible URL / title / any specific element
agent-browser get url
agent-browser get title
agent-browser eval 'document.querySelector("h1")?.innerText'

# 6. Click elements — three equivalent forms
agent-browser find role button click "Save"       # by accessible role + name
agent-browser find text click "Save"              # by visible text
agent-browser click "@e4"                         # by snapshot ref
agent-browser click "#submit"                     # by CSS selector

# 7. Pull the browser console (great for React/HMR errors)
agent-browser console
agent-browser errors

# 8. A full-page screenshot for the agent to review
agent-browser screenshot /tmp/dashboard.png

# 9. Tear down when done
agent-browser close
pnpm dev:docker:down "$PORT"
```

`agent-browser snapshot` returns the accessibility tree in text form with
`[ref=e1]`-style labels. Clicking `@e1` in a subsequent command targets the
same element the snapshot described — agents don't need to guess selectors.

### The agent's loop — `playwright-cli` alternative

Same shape, different commands. Note `-s=<session>`: the unnamed "default"
session in `playwright-cli` does not persist between process invocations
reliably on headless Ubuntu, so always use a named session.

```bash
PORT=$(pnpm --silent find-free-port)
pnpm dev:docker "$PORT" &
until curl -fs -o /dev/null "http://localhost:$PORT/"; do sleep 2; done

# First open MUST include --browser firefox (see § headless-Ubuntu gotchas).
playwright-cli -s=ui --browser firefox open "http://localhost:$PORT/dashboard"

# Capture page snapshot (structured markdown + YAML accessibility tree)
playwright-cli -s=ui snapshot

# Eval / click / navigate
playwright-cli -s=ui eval "() => document.title"
playwright-cli -s=ui click "e4"                          # by snapshot ref
playwright-cli -s=ui goto "http://localhost:$PORT/settings"

# Console messages (includes log level + source:line)
playwright-cli -s=ui console

# Screenshot
playwright-cli -s=ui screenshot

# Tear down
playwright-cli -s=ui close
pnpm dev:docker:down "$PORT"
```

Every `playwright-cli` command echoes the underlying Playwright code it ran
(`await page.click(…)`, etc.), useful when the agent needs to explain what it
did or translate the session into a persistent test.

### Keeping the three things in sync

Whichever CLI you pick, keep three things aligned: what the browser sees, what
the server logs say, what the source files contain. If the snapshot looks
wrong, tail the server with `pnpm dev:docker:logs $PORT`; if the logs look
wrong, open the source file; if the source looks right but nothing changes, HMR
may be stale — `pnpm dev:docker:down` and restart the stack.

## Docker vs podman

The scripts auto-detect the runtime in this order:

1. `$CONTAINER_RUNTIME` if set (`docker` or `podman`)
2. `docker` if it's in `PATH`
3. `podman` if it's in `PATH`

They then try `<runtime> compose` (docker compose plugin / modern podman
compose subcommand) and fall back to standalone `docker-compose` or
`podman-compose` if that fails. If your setup needs a different compose binary,
set `CONTAINER_RUNTIME` explicitly:

```bash
CONTAINER_RUNTIME=podman pnpm dev:docker 3100
```

Rootless podman works unchanged — the stack has no SELinux volume labels
(`:Z`) because it uses named volumes rather than bind-mounting paths needing
SELinux relabeling. One caveat: `depends_on: condition: service_healthy`
requires a compose implementation new enough to understand the long-form
syntax (docker compose v2, podman 5+ built-in compose, or recent
`podman-compose`).

## Troubleshooting

**First start is slow.** Expected — about 60–120 s. The container runs `pnpm
install`, generates the Prisma client, applies the Prisma schema, then boots
three turbo dev processes. Subsequent starts of the same port reuse the cached
node_modules volume and take ~10 s.

**Port is in use.** The `dev:docker` script checks `ss`/`lsof`/`/dev/tcp` for a
listener on the port before starting, and only lets you through if the existing
owner is *your own compose project* for that port. On a conflict, run `pnpm
find-free-port` and pick a different port.

**`error: neither docker nor podman found`.** Install one, or set
`CONTAINER_RUNTIME` to the binary name if it's at a non-standard path.

**`depends_on.condition` unsupported.** Your compose implementation is too old.
Upgrade to `docker compose` v2 (the plugin, not the standalone `docker-compose`
v1 Python script) or a recent `podman-compose`.

**The server warns about a weak `BETTER_AUTH_SECRET`.** Intentional. The
committed placeholder trips the weak-secret detector on purpose so the dev
stack is visibly insecure. The same check throws (not warns) in production.

**Changes to `packages/*` aren't picked up.** Live reload watches source files
in the bind-mounted repo. If the change is in a package that isn't being
re-bundled by the app (e.g. a type-only change in `@starter/env`), restart the
stack: `pnpm dev:docker:down <port> && pnpm dev:docker <port>`.

**Files on the host are owned by `root`.** The dev container runs as the host
UID/GID (`HOST_UID`/`HOST_GID` exported by `scripts/dev-docker.sh`), so
anything it writes into the bind-mounted `/app` (turbo cache, vite cache,
generated prisma client, `dist/`, etc.) ends up owned by the host user. If you
see root-owned files anyway, either (a) a previous run used the older
root-as-default setup and left stale artifacts — `sudo chown -R
"$(id -u):$(id -g)" <paths>` once, then `pnpm dev:docker <port> --reset` to
recreate the per-project node_modules volumes with the new perms — or (b) your
shell did not inherit `HOST_UID`/`HOST_GID` (rare; `scripts/dev-docker.sh`
exports them, so this should only happen if you ran `docker compose`
directly). Set them explicitly:
`HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose …`.
