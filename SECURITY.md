# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**, not via public issues:

- Preferred: open a private advisory on the repository's
  [Security tab → "Report a vulnerability"](../../security/advisories/new).

We aim to acknowledge reports within 72 hours.

## Template updates

This template is a one-shot starting point, not a trackable upstream: every
app built from it renames packages, removes modules, and diverges from the
first commit, so there is no supported "pull updates from the template"
path. Security fixes made to this repository after you copy it do not reach
your app — watch this repository and port anything relevant into your code
yourself.

## Security controls shipped by default

Defaults baked into this template:

- pnpm 11 supply-chain hardening — release-age gate (7 d), exotic-subdep
  blocking, build-script allowlist, sha512-pinned package manager
  (`pnpm-workspace.yaml`, `package.json#packageManager`).
- SHA-pinned GitHub Actions kept current by Dependabot
  (`.github/dependabot.yml`).
- Trufflehog verified-secret scanning on every PR (`.github/workflows/pr-checks.yml`).
- Trivy HIGH/CRITICAL image scanning on every container build
  (`.github/workflows/build-image.yml`).
- `pnpm audit` on every PR with `--audit-level=high`.
- Non-root `USER node` in the production server and worker images.
- Tight Content-Security-Policy and `secureHeaders` middleware
  (`apps/server/src/index.ts`).
- Tiered rate limiting — signup (3/hour) stricter than auth (10/minute)
  (`apps/server/src/rate-limit.ts`).
- Hard production-boot guards in `packages/env/src/server.ts`:
  a weak `BETTER_AUTH_SECRET` refuses to start in production.
- Permission-checked asset URLs (see `patterns/assets.md` § "The agent rule").

See `AGENTS.md` § "Agent Safety Rules" for the full list of guardrails an
AI coding agent must respect when working in this repo.

## Features that need a paid GitHub tier

The defaults above work on **any repository**, public or private, with no
GitHub Advanced Security (GHAS) subscription. These are intentionally NOT
shipped because they require GHAS on private repos:

- CodeQL (generic JS/TS SAST) — free on public repos; GHAS on private.
- GitHub Dependency Review Action — free on public; GHAS on private.

If your fork is public, or you have GHAS, add either as a workflow at no
behavioral cost.
