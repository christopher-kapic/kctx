# Dependency Vulnerabilities — pnpm Overrides & Exclusions

How this monorepo handles a CVE: where the alert comes from, how to lift a dependency out of a vulnerable range, and how that interacts with the supply-chain release-age gate.

This is the security companion to [dependencies.md](./dependencies.md) (which covers the **catalog** — single-version sharing). Overrides and the catalog are different mechanisms: the catalog pins versions you *choose*; an override *forces* a transitive version you'd otherwise never see in a `package.json`. This doc is the *after-install* half of supply-chain hygiene; the before-install half — screening a package before it ever enters the lockfile — is [agent-tooling § Vetting checklist](./agent-tooling.md#vetting-checklist).

## The defense layers

Four independent gates, each in a different file. Know which one fired before you touch anything.

| Layer | File | What it does | Tuning |
|---|---|---|---|
| Dependabot cooldown | `.github/dependabot.yml` | Ignores recent releases when opening version-update PRs (typosquat / compromised-release window): <7 days for npm (so it never proposes a version the release-age gate would reject), <3 days elsewhere. Security updates are **not** delayed. | `cooldown.default-days` |
| pnpm release-age gate | `pnpm-workspace.yaml` | `minimumReleaseAge: 10080` (7 days, in minutes) + `minimumReleaseAgeStrict: true` — pnpm refuses to resolve **any** version published <7 days ago. | `minimumReleaseAgeExclude` list |
| Release-age exclude expiry | `pnpm verify:fast` + `.github/workflows/pr-checks.yml` → `lint` job (`pnpm deps:check-excludes`) | Every `minimumReleaseAgeExclude` entry must carry a `drop-after: YYYY-MM-DD` comment marker; the build fails once that date passes, so a temporary security carve-out cannot silently become a permanent exemption. | the `drop-after:` dates themselves |
| pnpm audit (CI) | `.github/workflows/pr-checks.yml` → `pnpm-audit` job | `pnpm audit --audit-level=high` against the lockfile. A high or critical advisory fails the build until the dependency is fixed, including when no patched release is published yet. | `--audit-level` |
| Trivy image scan (CI) | `.github/workflows/build-image.yml` + `pr-checks.yml` → `docker` job | Scans the **built image** for HIGH/CRITICAL in OS packages *and* `node_modules`. `ignore-unfixed: true` → fails only on CVEs that have a fix available. `exit-code: '1'`. | `severity`, `ignore-unfixed` |

`pnpm audit` reads the lockfile; Trivy reads the image filesystem. Trivy catches things `pnpm audit` misses (OS packages, advisories not in the npm audit DB) — that is why it is the stricter of the two and usually the one that fails first.

## The rule

> **Lift a dependency out of a vulnerable range with the narrowest possible `overrides` selector. Never widen a major. Never suppress a fixable CVE — fix it. Only `ignore-unfixed` advisories (no patch exists) are allowed to pass.**

## Decision tree

A CVE is flagged. Identify what kind it is — the fix differs:

1. **Direct dependency, catalog-managed** → bump the version in `pnpm-workspace.yaml` `catalog:`. Normal [dependencies.md](./dependencies.md) flow. No override needed.
2. **Direct dependency, not in the catalog** → bump it in the consuming `package.json`.
3. **Transitive npm dependency** (the common case — you don't list it, something you depend on does) → add a scoped `overrides:` entry. Recipe below.
4. **OS / base-image package** (`libc6`, `libcap2`, `libsystemd0`, `openssl`, …) → not an npm problem. Recipe in [§ OS-level CVEs](#os-level-cves--base-image).
5. **No fix exists** (`ignore-unfixed` already skips these in Trivy; `pnpm audit` still fails on high/critical findings) → fix the other findings, record the remaining blockers, and keep the audit gate blocking until a fix is available. Do not hand-write suppressions.

## Recipe: transitive npm CVE → scoped override

Overrides live in `pnpm-workspace.yaml` under `overrides:` (pnpm 11 reads them from the workspace file, not the root `package.json`).

### 1. Get the exact fixed version

Trivy prints `Installed Version` and `Fixed Version` per CVE. Use the **lowest** version that clears the advisory — not "latest".

Confirm that the fixed version is actually published in the npm registry, and check the upstream advisory. An audit response can advertise a patched range whose first version does not exist yet. Do not add an unresolvable override or treat that range as proof of a released fix; follow the no-fix path above and report the discrepancy.

### 2. Add a range-scoped selector

```yaml
# pnpm-workspace.yaml
overrides:
  defu@<6.1.5: ">=6.1.5"            # CVE-2026-35209 (prototype pollution)
  fast-uri@>=3 <3.1.6: ">=3.1.6 <4" # GHSA-4c8g-83qw-93j6 / GHSA-v2hh-gcrm-f6hx / GHSA-7p8r-x3mc-p8w7
  picomatch@>=4 <4.0.4: ">=4.0.4"   # CVE-2026-33671 — only the v4 line; v2 has its own entry
```

Selector discipline:

- **Scope to the vulnerable range only** (`pkg@<fixed` or `pkg@>=major <fixed`). A bare `pkg: ">=x"` rewrites *every* copy in the tree, including majors that were never vulnerable, and can force-break an unrelated consumer.
- **One line per affected major.** If a package appears in two vulnerable majors through different dependency chains, each major gets its own override line with its own fixed version. Do not collapse them.
- **Comment every entry with the CVE id and one-word reason.** Future-you needs to know when it is safe to delete the line.
- **An existing override is not proof the package is safe.** A pin that cleared one advisory says nothing about the next one against the same package, and nothing warns you — the line still looks deliberate and current. `fast-uri` sat at `<3.1.2: ">=3.1.2"` while two later advisories raised the floor to 3.1.4, so the gate was failing on a package the file appeared to have handled. When `pnpm audit` names a package that already has an override, **raise the existing line** rather than assuming it is covered.

### 3. Regenerate the lockfile and verify it resolves

```bash
pnpm install --lockfile-only      # apply overrides to pnpm-lock.yaml
pnpm install --frozen-lockfile    # exactly what CI's setup job runs — must pass
grep -oE "<pkg>@[0-9][0-9.]*" pnpm-lock.yaml | sort -u   # confirm resolved >= fixed
```

Then run the suites the lockfile change could disturb: `pnpm check-types && pnpm test`. A transitive bump that crosses a minor (e.g. `kysely 0.28 → 0.29`) is safe **only if nothing in `apps/`/`packages/` imports it directly** — verify with a quick grep before trusting it.

### 4. The release-age trap

`minimumReleaseAgeStrict: true` means pnpm will **refuse to resolve a fix version published less than 7 days ago** — the install fails, it does not silently downgrade. Real CVE fixes are often hours old. Before adding an override, check the publish date:

```bash
npm view <pkg> time --json | python3 -c "import sys,json;print(json.load(sys.stdin)['<fixed-version>'])"
```

- **Fix ≥ 7 days old** → nothing extra. (All five overrides added in the worked case were weeks old.)
- **Fix < 7 days old** → you must temporarily add the package to `minimumReleaseAgeExclude` *and* note why, mirroring the existing entries:

```yaml
minimumReleaseAgeExclude:
  # CVE-2026-XXXX: <pkg> <fixed> (released YYYY-MM-DD) patches the only fixed
  # version and is <7 days old.
  # drop-after: YYYY-MM-DD   <- release date + 7 days
  - <pkg>
```

The **`drop-after:` marker is required, not decorative**. `pnpm deps:check-excludes` (`scripts/check-release-age-excludes.ts`, run in CI's `lint` job) parses it and fails the build if an entry has no marker, has an unparseable date, or is past its date. Without that, an exemption taken for a one-week security window silently becomes a permanent hole in the gate — and it is a hole in exactly the defence that protects you from a compromised publish, on exactly the package you were forced to take on short notice.

When the build fails on an expired entry, the fix is almost always just deleting it: by definition the version is now older than the window, so it no longer needs the exemption. Re-run `pnpm install` to confirm resolution still succeeds.

This is a deliberate, documented hole in the supply-chain gate. It is acceptable for a security fix and **only** for a security fix. Re-resolution can also drag *other* transitives below 7 days (a cascade) — that is what the bulk of the existing Exclude list is; add cascade victims the same way, with the same "status-quo, drop when…" note.

## OS-level CVEs — base image

`libc6`, `libcap2`, `libsystemd0`, `openssl`, etc. are Debian packages in `node:24-slim`, not npm. The base image lags the Debian point release, so Trivy fails on fixable HIGH CVEs that Debian has already patched. Fix: pull the patches at build time in the **`base`** stage of **all three** Dockerfiles (`Dockerfile`, `Dockerfile.worker`, `Dockerfile.db-applier` — each `runner` stage inherits its `base`):

```dockerfile
RUN apt-get update -y && apt-get upgrade -y && apt-get install -y \
  openssl \
  postgresql-client \
  && rm -rf /var/lib/apt/lists/*
```

`Dockerfile` and `Dockerfile.worker` must stay in sync — see the "keep server and worker in sync" rule in AGENTS.md. The Trivy scan only runs inside the Docker build (not reproducible with a local `pnpm` command); rely on the CVE id + fixed version Trivy reports.

## Cleanup — overrides are debt

Every override and every Exclude entry is a pin that hides upstream progress. Stale ones accumulate and silently hold back legitimate updates.

- **Override**: delete the entry once your direct/transitive graph no longer pulls the vulnerable range on its own (the upstream dependency caught up). Re-run `pnpm install --lockfile-only`; if the resolved version stays ≥ fixed without the override, the line is dead — remove it.
- **`minimumReleaseAgeExclude`**: delete the entry as soon as the version has aged past 7 days. You do not have to remember — `pnpm deps:check-excludes` fails CI on the `drop-after:` date. These are meant to be short-lived.
- A periodic pass over both blocks belongs in the cleanup routine — see [agent-tasks/cleanup.md](./agent-tasks/cleanup.md) and [project-audit.md](./project-audit.md).

## Agent task

When a CVE is reported (Trivy CI failure, Dependabot alert, `pnpm audit`):

1. Classify it with the decision tree. OS vs npm vs direct vs transitive — the fix is different for each.
2. For an npm transitive: find the lowest fixed version, check its publish date, add a **range-scoped** override (+ a dated `minimumReleaseAgeExclude` entry only if <7 days old), regenerate the lockfile, verify with `--frozen-lockfile` + `check-types` + `test`.
3. For an OS package: `apt-get upgrade -y` in the `base` stage of all three Dockerfiles.
4. Never suppress a fixable CVE or widen a selector past the vulnerable range to make CI green. If a fix genuinely cannot be applied without breaking the app, stop and surface it to the user — do not silence the scanner.
