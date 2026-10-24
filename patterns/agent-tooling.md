# Agent Tooling — installing dependencies safely

How AI agents working in this repo should handle tooling and dependency changes.

## Installing a new pnpm package

When implementing work requires a dependency this repo doesn't already ship:

1. **Stop and confirm with the user before running `pnpm add`.** Do not install quietly. Say what you want to install, why, and which workspace it belongs in — and complete the [vetting checklist](#vetting-checklist) below *before* proposing, so the proposal arrives pre-screened. If the harness is non-interactive and AskUserQuestion isn't available, use judgment — prefer pausing over installing.
2. **Catalog the dep.** If more than one workspace will (or could later) consume it, add it to `pnpm-workspace.yaml → catalog:` and reference it as `"<dep>": "catalog:"` from each `package.json`. See [patterns/dependencies.md](./dependencies.md). Never edit a `"catalog:"` line in a workspace `package.json`.
3. **Understand the API before writing against it.** For a minor/major version you haven't used, check the package's changelog and docs (its GitHub releases page or repo `CHANGELOG.md`) rather than assuming the API from memory — the pinned catalog version is the source of truth for what's actually installed.

### Vetting checklist

Complete this before proposing a package (step 1), and report the findings alongside the proposal:

1. **Do we need a package at all?** If the need is small (a copy button, a debounce, a date format), write it in-house — this template prefers fewer dependencies over convenience wrappers.
2. **Maintained.** Published within roughly the last 12 months, or visibly stable-and-complete with issues still being triaged. Check `npm view <pkg> time.modified` and the repo's recent activity.
3. **Fairly popular.** Enough real-world usage that problems get found by others first — as a rough floor, tens of thousands of npm downloads per month (`https://api.npmjs.org/downloads/point/last-month/<pkg>`) or an established GitHub community. A niche package can still be justified (e.g. the only maintained wrapper for a needed native library) — say so explicitly instead of skipping the check.
4. **Clean supply-chain history.** Search the package name against GitHub Security Advisories / OSV and general news for compromised releases, typosquats, or hijacked maintainer accounts. **Disqualifying:** any supply-chain compromise that took the maintainers more than 7 days to remediate. A quickly-yanked incident with a transparent postmortem is a judgment call — surface it, don't hide it.
5. **License fits.** Note the license (and any embedded artifacts with a different license, e.g. WASM builds) and whether it ships to browsers; flag anything beyond MIT/Apache/BSD/ISC for the user, and remember `THIRD-PARTY-LICENSES.md` needs an entry.
6. **Report the evidence.** The proposal to the user includes: package, version, why, workspace, last-publish date, monthly downloads, license, maintainer count (flag single-maintainer packages — acceptable but higher-risk), and the advisory-search result. One short paragraph, not a dossier.

Vetting is the before-install half of supply-chain hygiene; the after-install half (CVE response, scoped overrides, the release-age gate) is [dependency-vulnerabilities.md](./dependency-vulnerabilities.md).

## Global machine tools

Some tools this repo leans on are **global machine installs, not app dependencies** — they must never appear in a `package.json`:

- **`portless`** — local dev proxy (`pnpm dev` → `https://<slug>.localhost`). Install: `npm install -g portless`. The developer runs its trust/proxy setup themselves.
- **`agent-browser`** — headless browser CLI for UI verification ([agent-ui-testing.md](./agent-ui-testing.md)). Install: `npm i -g agent-browser`.
- **`cloudflared`** — Cloudflare quick tunnels exposing the dev web server on a temporary public `https://…trycloudflare.com` URL (`pnpm dev:tunnel`, [dev-tunnels.md](./dev-tunnels.md)). Install: Linux `curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb` (root required — hand the command to the user, never run `sudo` yourself), macOS `brew install cloudflared`, Windows `winget install Cloudflare.cloudflared`.

If a global tool is missing, **stop and ask the user to install it** — don't pipe installer scripts to `bash` from the agent, and don't edit the user's shell rc to fix `PATH`; tell the user and let them fix it.

## Anti-patterns

- **Don't** `pnpm add` a dep without confirming with the user first.
- **Don't** bump a version in an individual `package.json` when the dep is cataloged — change `pnpm-workspace.yaml`.
- **Don't** write code against an API surface you haven't verified for the installed major version.
- **Don't** install global tools into the repo to work around a missing machine install.
