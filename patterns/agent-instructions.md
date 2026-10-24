# Agent Instructions — Single Source of Truth

How AI coding-agent instructions are managed across this repo.

## Canonical file

**`AGENTS.md`** (repo root) is the single source of truth for all agent instructions. Edit only this file — never edit the generated mirrors directly.

## Generated mirrors

The sync script copies `AGENTS.md` into harness-specific files so each tool picks up the same instructions:

| Harness | File read by the tool | Banner style |
|---|---|---|
| Claude Code | `CLAUDE.md` | HTML comment |
| Cursor | `.cursorrules` | Blockquote + HTML comment |
| GitHub Copilot | `.github/copilot-instructions.md` | HTML comment |

Each mirror is byte-identical to `AGENTS.md` with a "DO NOT EDIT" banner prepended.

## Adding a new harness target

1. Open `scripts/sync-agent-docs.ts`.
2. Add an entry to the `TARGETS` array with `path` (relative to repo root) and `banner` (prepended text).
3. Run `pnpm sync:agent-docs` to generate the new file.
4. Commit both the updated script and the generated file.

```ts
// Example: adding Windsurf support
const TARGETS: Target[] = [
  // …existing targets…
  { path: ".windsurfrules", banner: HTML_BANNER },
];
```

## Keeping mirrors in sync

- **Pre-commit hook** — Lefthook runs `pnpm sync:agent-docs` on commit and auto-stages the mirrors, so they never drift.
- **CI check** — The `pr-checks` workflow verifies mirrors match `AGENTS.md`. If they drift the PR fails.
- **Manual** — Run `pnpm sync:agent-docs` at any time to regenerate.
- **Size budget** — `pnpm policy:agents-size` (in `pnpm verify` and `pr-checks`) caps `AGENTS.md` at the word budget in `scripts/check-agents-size.ts`. The file is read on every agent turn, so growth is a real cost: when you add a rule, move the detail into a `patterns/` doc and leave a link.

## Branch workflow for harnesses without tool-boundary enforcement

Claude Code blocks dangerous commands at the tool boundary before they run (see [claude-code-setup.md](./claude-code-setup.md)). Cursor, Copilot, Codex, and other harnesses without `PreToolUse`-style enforcement have only the commit-time and CI backstops: lefthook `policy-checks` and the Policy checks job in `pr-checks.yml` — both of which see a banned string only after the command already ran.

Therefore, on those harnesses **every change goes on a branch**. Merge to `main` only after `pnpm verify:fast` passes locally. **Never commit agent-made changes directly to `main`.**

## Content guidelines

All content in `AGENTS.md` must stay **harness-agnostic**. Every harness receives the same text, so do not add tool-specific syntax (e.g., Cursor-only directives or Claude-only XML tags).

**Do not restate a value that lives in code.** Version pins, defaults, limits, route tables, env-var lists, queue and scheduler ids, and counts belong in exactly one place — the code — and docs cite the file that owns them. A number typed into prose is a number that will be wrong. AGENTS.md keeps rules; `patterns/` keeps recipes.

For harness-specific guidance, add a clearly labeled section in `AGENTS.md` (e.g., `### Claude Code — …`) rather than branching the generator. The generator intentionally does **not** support conditional sections — simplicity and auditability beat per-tool customization.

## Writing about dangerous commands

`scripts/policy-checks.sh` records each reviewed destructive occurrence by exact path, complete-line SHA-256, and expected count — it never exempts a whole file. When docs or deny-reason strings must *mention* a banned command without invoking it, the `destructive:audited` marker is the narrowly proven-inert exception, not a generic bypass for help, error, or deny-list strings. Prefer comments or non-command wording for explanations. In shell, its only display exception is a complete-source, program-root `echo` or exact `printf '%s\n'` display; command capture, redirection, pipelines, siblings, functions, subshells, controls, assignments, configuration, and unknown carriers remain live. If a legitimate message is rejected, reword the explanation rather than weaken the gate. The scanner makes no arbitrary-program/dataflow or customized-builtin proof, and the marker never covers a command that runs, including a payload consumed by `eval`, `sh`/`bash -c`, or `node -e`/`--eval`/print modes. Comments are ignored by syntax; all source, executable, CI, root-script, lefthook, and Git-tracked or nonignored-untracked candidates are otherwise scanned.
