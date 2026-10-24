# Dev tunnels — give someone a public URL to the running dev app

For the request that arrives as *"can I try it?", "send me a link"*, or *"show
this to my colleague"* from a nontechnical user while the app only exists on the
developer's machine. `pnpm dev:tunnel` exposes the running dev web server
through a Cloudflare **quick tunnel**: a random `https://<words>.trycloudflare.com`
URL that proxies to `localhost`. No Cloudflare account, no config.

```text
nontechnical user ── "give me a link to try the app"
        │
        ▼
agent: dev stack up? ── pnpm dev:tunnel ──▶ https://random-words.trycloudflare.com
        │                                        (proxies to the Vite dev server)
        ▼
agent shares the URL + the caveats below, in plain language
```

The tunnel targets the **Vite dev server** (`apps/web`), which already proxies
`/api`, `/rpc`, `/sw`, and `/ws` to the API server — so one URL covers the
whole app, auth included.

## Prerequisites

1. **The dev stack is running.** The web dev server must answer on the target
   port (default `3001`). The script preflights this and refuses to start
   against a dead origin.
2. **`cloudflared` is installed** — a global machine tool, never a package.json
   dependency (see [agent-tooling.md](./agent-tooling.md) § Global machine
   tools). If it is missing, print the installer for the user's OS and wait;
   never run `sudo` yourself:

   | OS | Command (user runs it) |
   |---|---|
   | Linux (deb) | `curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb` |
   | macOS | `brew install cloudflared` |
   | Windows | `winget install Cloudflare.cloudflared` |

## The runbook

Run these steps; each is one command.

```bash
# 1. Confirm the dev web server is up (or start it: pnpm dev:services, then pnpm dev:raw)
curl -fsS -o /dev/null http://localhost:3001

# 2. Start the tunnel (idempotent: a healthy running tunnel is reused, URL unchanged)
pnpm dev:tunnel
# → dev-tunnel: https://remaining-learning-tool-congratulations.trycloudflare.com

# 3. Re-read the URL later without output noise
pnpm dev:tunnel url

# 4. Stop when the user is done
pnpm dev:tunnel:down
```

State (pid, log, url) lives in `tmp/dev-tunnel/`, which is gitignored. The
tunnel dies with the machine; the URL **rotates on every restart**.

### Under `pnpm dev` (portless)

Portless assigns each app its own injected `PORT`, so the web server is usually
not on 3001. Find the Vite port and pass it explicitly:

```bash
ss -ltnp | grep -E 'vite|node'     # or read the portless startup output
pnpm dev:tunnel --port <N>
```

`--url http://localhost:N` / `--url https://…` also work for arbitrary origins.

## Caveats — always pass these along with the URL

Quick tunnels are a testing convenience, not a deployment. Tell the user, in
plain words:

- **Chat streaming will not work.** Quick tunnels do not support Server-Sent
  Events, and the chat stream is SSE (see [durable-streaming.md](./durable-streaming.md)).
  Everything else works; streaming responses will hang or fall back. Do not
  "fix" this by changing the stream implementation — it is a tunnel limit.
- **Anyone with the URL reaches the dev app and its dev database.** Real auth
  still applies (login is required), but treat the URL as a secret: share it
  deliberately, not in public channels. Take the tunnel down when the demo is
  over (`pnpm dev:tunnel:down`).
- **200 concurrent requests**, and the URL changes if the tunnel restarts —
  re-run `pnpm dev:tunnel url` and re-share after any restart.
- **It is the development build**: dev-only logging, seed data, and
  work-in-progress UI. For a shareable stable build, deploy properly
  ([deployment-vps.md](./deployment-vps.md)) instead.

## How it works

- `scripts/dev-tunnel.sh up` preflights the origin, starts
  `cloudflared tunnel --url http://localhost:<port> --no-autoupdate` in the
  background, waits for the assigned URL in the startup banner, and records it.
- `apps/web/vite.config.ts` sets `server.allowedHosts: [".trycloudflare.com"]`
  — Vite's host-header check would otherwise answer `403 Blocked request` for
  tunnel traffic (Host: `<random>.trycloudflare.com`). The dev server still
  binds to localhost; remote access exists only while the tunnel runs.
- No ports are opened on the machine; all traffic flows outbound through
  Cloudflare's edge.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cloudflared is not installed` | Print the OS installer (table above) and hand it to the user. |
| `nothing is answering on http://localhost:3001` | Dev server not running, or portless moved it — start it or pass `--port <N>`. |
| Tunnel URL answers `530` | The tunnel is down (cloudflared exited or was stopped) — `pnpm dev:tunnel` again; the URL may have rotated. |
| Page loads but API calls fail | The API server behind Vite's `/api`,`/rpc` proxy is down — bring up the dev services (`pnpm dev:services`, then restart dev). |
| Old URL shared, no longer works | URLs rotate per restart — re-read with `pnpm dev:tunnel url` and re-share. |

For a permanent, stable hostname (production or long-lived demos), set up a
named Cloudflare tunnel with an account — out of scope here; deploy instead.
