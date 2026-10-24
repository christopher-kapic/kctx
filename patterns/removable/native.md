# Removable: Expo mobile app

Remove the native iOS/Android app (`apps/native`) and everything that exists only to support it when the owner explicitly chooses physical removal. For a first web-only milestone, deferring this client is the default: do not launch or publish it, and retain the existing workspace checks. Removal is not required before building the first web feature. The Expo app is for teams that need App Store / Play Store presence, SecureStore, native haptics, or deeper OS integration.

## What you'll lose

- The `apps/native` Expo Router app (Home + Account tabs, native sign-in/sign-up/2FA)
- The `pnpm dev:native` / `pnpm native:ios` / `pnpm native:android` / `pnpm native:web` scripts
- The `pnpm doctor:native` preflight check
- The `@starter/env/native` env surface (`EXPO_PUBLIC_SERVER_URL`)
- Native i18n: the `native` namespace bundles + `resolveDeviceLocale()` in `@starter/locales` and the `expo-localization` catalog entry (the rest of `@starter/locales` stays for the web app)
- ~26 catalog entries (Expo SDK, React Native, Uniwind, HeroUI Native)

## What stays untouched

- The web PWA is completely independent — nothing in `apps/web` imports from `apps/native`.
- The API, auth, worker, and all `packages/*` are unaffected: the native app is a pure *consumer* of `@starter/api`, `@starter/auth`, and `@starter/env`. No server code exists solely for it.
- The server/worker runtime images do not ship the native app. The builder sees its source through `COPY . .`, but does not hand-enumerate its manifest; no native `COPY` line needs removal. Keep `scripts/check-docker-copy.ts` absent-workspace handling intact.
- Keep `tailwind-merge` (used by `packages/ui`) and `@orpc/tanstack-query` (used by `apps/web`) in the catalog — they look native-ish but are shared.

## Steps

### Maintained helper (recommended)

After the owner explicitly chooses removal, preview the complete change:

```bash
pnpm template:remove native
```

The preview lists every tracked deletion and shows dependent edits, including
generated agent mirrors and the pnpm lockfile. It prepares and checks these in
a temporary snapshot using the installed tools and cached packages, without
changing the source tree or Git index. Review the whole preview with the owner,
then run its printed `--apply --confirm <hash>` command. `native cli` prepares
both clients together. Only these two shipped clients are supported.

The helper refuses overlapping staged, unstaged, and untracked work, unsafe or
symlink paths, missing recipe anchors, unknown client consumers, and stale
confirmation hashes. Keep other writers paused during apply. It leaves every
change **unstaged** and makes no commit. Ignored local environment/build files
remain, protected by root Git and Docker ignore entries for the removed client.
It does not recursively delete the client directory.

Consumer checks cover literal client references in all surviving tracked and
nonignored untracked files, including shell scripts, workflows, extensionless
tools, and root configuration. The same inventory runs before apply. Markdown,
the maintained agent prose and removal helper/recipes/tests are excluded; local
environment files are never scanned. Retained compatibility references must
match their reviewed complete lines exactly. Computed paths and arbitrary
program behavior still need human review.

Before the first native or chat preview, run `pnpm template:remove --prepare-cache`
while online. It resolves complete metadata in a disposable snapshot with lifecycle
scripts disabled; it does not change your manifests, lockfile, index, or installed
packages. A frozen install alone can leave cached metadata without publish dates.
The release-age gate stays enabled during preparation and offline generation.

Generation uses `pnpm install --lockfile-only --offline --ignore-scripts` in
the temporary snapshot. If the cache or an existing check is incomplete, the
helper stops before touching your source; resolve the reported problem and
preview again. After apply, run `pnpm install --offline --ignore-scripts` to
refresh workspace links, then `pnpm verify` before committing.

Apply changes files individually; it is **not a multi-file atomic transaction**.
An interruption or write failure retains `template-removal.lock` in the Git
directory (`git rev-parse --absolute-git-dir`). This journal contains the reviewed
paths/hash and completed writes. A later apply refuses the lock. Inspect the
journal and `git diff`, preserve any later owner work, and explicitly finish or
restore the listed paths before removing that lock. The helper never performs
automatic rollback, force removal, staging, or commits.

The numbered steps below are the maintained inventory for reviewing the helper
or carrying out a separately reviewed manual removal.

### 1. Delete the files

Read all steps first and inventory both files to delete and shared files to edit. Run `git status --short --untracked-files=all` and refuse the removal if any planned path has existing staged, unstaged, or untracked work; do not use force flags. Explain overlapping paths and let the owner preserve their changes first. Preview the exact tracked deletion set:

```bash
git rm --dry-run -r -- apps/native scripts/native-doctor.ts packages/env/src/native.ts packages/env/src/vars/native.ts patterns/native.md packages/locales/src/en-US/native.json packages/locales/src/es-MX/native.json packages/locales/src/native.ts packages/locales/src/native.test.ts
```

After the owner has chosen this removal and reviewed the file set, run the same scoped `git rm -r --` command without `--dry-run`. This removes tracked files and stages their deletions; it does not create a commit. Inspect any retained ignored files under `apps/native` (such as local env or build output) by name only and leave them for the owner; never sweep the directory recursively. Additional locales require adding their exact native namespace files to the reviewed list. Complete every dependent edit below before handing back the change.

Keep the rest of `packages/locales` (the web namespaces) and its `i18next` / `react-i18next` catalog entries — those are shared with the web app. Only `expo-localization` is native-only (removed in step 5).

### 2. Root `package.json` — remove the native scripts

```jsonc
"dev:native": "pnpm doctor:native && turbo -F native dev",
"native:android": "pnpm doctor:native && turbo -F native android",
"native:ios": "pnpm doctor:native && turbo -F native ios",
"native:web": "pnpm doctor:native && turbo -F native web",
"doctor:native": "tsx scripts/native-doctor.ts",
```

### 3. `packages/env/package.json` — remove the export

```jsonc
"./native": "./src/native.ts"
```

Remove the matching `./native` export from `packages/locales/package.json` too. It points to the device-locale resolver deleted in step 1; the remaining locale exports stay.

### 4. `scripts/setup.ts` — remove the native env step

Delete the `NATIVE_ENV_PATH` / `NATIVE_ENV_EXAMPLE_PATH` constants and the entire "3. Copy `apps/native/.env.example` -> `apps/native/.env`" block, including the `ensureNativeEnvFile()` definition and the header-comment line that lists step 3. Also delete the `ensureNativeEnvFile();` invocation from `main()`; removing only the definition leaves setup broken. Confirm `rg 'ensureNativeEnvFile|NATIVE_ENV' scripts/setup.ts` has no matches. Renumber the remaining step comments if you care.

### 4b. `scripts/lib/env-manifest.ts` — remove the native env group

Delete the `EXPO_PUBLIC_SERVER_URL` `ENV_VARS` entry and the `native` group, plus
the `apps/native/.env.example` entry in the `FILES` list in
`scripts/sync-env-example.ts`, then run `pnpm env:sync`.

Deleting `apps/native/.env.example` without this leaves the manifest describing
a file that no longer exists. `pnpm env:sync` skips a missing target rather than
crashing, so nothing breaks loudly — but the manifest keeps carrying a var for
an app you removed, and `pnpm generate:secrets` keeps prompting for it. Verify
with `pnpm env:check`.

### 5. `pnpm-workspace.yaml` — remove the native-only catalog entries

```yaml
"@better-auth/expo": …
"@expo/metro-runtime": …
"@expo/vector-icons": …
"@gorhom/bottom-sheet": …
"expo": …
"expo-constants": …
"expo-font": …
"expo-haptics": …
"expo-linking": …
"expo-localization": …
"expo-network": …
"expo-router": …
"expo-secure-store": …
"expo-status-bar": …
"expo-web-browser": …
"heroui-native": …
"react-native": …
"react-native-gesture-handler": …
"react-native-keyboard-controller": …
"react-native-reanimated": …
"react-native-safe-area-context": …
"react-native-screens": …
"react-native-svg": …
"react-native-web": …
"react-native-worklets": …
"tailwind-variants": …
"uniwind": …
```

Do **not** remove `tailwind-merge` or `@orpc/tanstack-query` (see "What stays untouched").

Remove the SDK-specific `@react-native/metro-config` override and its preceding
comment as well. It only aligns Metro's auto-installed peer with this native SDK.

### 6. `turbo.json` — remove the native env passthrough

In the `dev` task's `passThroughEnv` array, remove:

```jsonc
"EXPO_*",
"EXPO_PUBLIC_*",
"ANDROID_HOME",
"ANDROID_SDK_ROOT",
"JAVA_HOME"
```

Also remove the `nm_apps_native` bind mount in `docker-compose.agent.yml`.
Remove Dependabot's `native-sdk` group and Expo/React-Native-only major-update
ignore entries; retain the shared React and React DOM version guards.
Preserve ignored local data by adding `/apps/native/` to the root `.gitignore`
and `apps/native` to `.dockerignore` before handing off; deleting the leaf's
`.gitignore` otherwise exposes its former ignored artifacts.

### 7. `knip.jsonc` — remove the workspace block

```jsonc
"apps/native": { … }
```

### 8. Docs

- **AGENTS.md**: delete the `### Native App — Expo Guardrails` section, the `Expo native ([removable/native](./patterns/removable/native.md))` item in the `## Stack` paragraph's "Optional/removable" list, the `apps/native/` line in Project Structure, the `Do not bypass pnpm doctor:native…` bullet in Agent Safety Rules, the `native` namespace sentence in the i18n section, and the React-Compiler sentence in `### React health checks — react-doctor`. (`removable-native` marker comments mark the sections — `### Native App — Expo Guardrails`, the i18n namespace sentence, and the react-doctor paragraph — not every individual edit site, so work from this list rather than from `grep removable-native`.) Then run `pnpm sync:agent-docs`.
- **README.md**: remove the "Expo mobile app" feature bullet, the native item in the removable-features bullet, the `apps/native/.env` setup bullet, the `cp apps/native/.env.example` snippet, the `#### Native (apps/native/.env)` env table, the `### 5. Run the mobile app` section, and the native-only audit note.
- **patterns/README.md**: remove the "Work on the Expo native app" quick-picks row.
- **patterns/getting-started.md**: remove the `apps/native/.env` note in Phase 0.3, the Expo row in the Phase 5 triage table, and the Expo-specific default triage guidance.
- **patterns/removable/i18n.md**: point its native-guide link to this retained removal recipe after deleting `patterns/native.md`. Keep both removal recipes as helper documentation.

### 9. Reinstall and verify

```bash
pnpm install
pnpm sync:agent-docs
pnpm verify
```

## Sanity checks

### After removal

- `pnpm install` completes and the lockfile shrinks (Expo/React-Native subtree gone).
- `pnpm check-types` runs one fewer project than before (no `native#check-types` task).
- `git grep -n -E 'apps/native|EXPO_PUBLIC|doctor:native|ensureNativeEnvFile'` returns no active consumers. Review remaining hits individually: removable recipes and guards that intentionally tolerate an absent workspace are documentation/compatibility references, not a reason to delete shared safety checks. Do not search local `.env` contents.
- `pnpm knip` reports no unused catalog entries or dependencies.

### If you change your mind

The app was a leaf workspace with no inbound dependencies, so re-adding it later is a clean `git revert` of the removal commit (or cherry-pick `apps/native` plus steps 2–8 from the template repo).
