#!/usr/bin/env node
/** Opt-in removal of shipped native/CLI leaves. Preview is the default. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  modules,
  nativeCatalog,
  references,
  transformModule,
} from "./lib/template-removal-recipes.mjs";

function run(root, command, args, acceptable = [0]) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || !acceptable.includes(result.status)) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function git(root, ...args) {
  return run(root, "git", ["--no-optional-locks", ...args]);
}

function safeFile(root, path, tolerateMissingFile = false) {
  if (
    !path ||
    isAbsolute(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character === "\\") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Unsafe path: ${JSON.stringify(path)}`);
  }
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const current = resolve(root, ...parts.slice(0, i));
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      // A plan-ADDED file does not exist yet; only its final component may be
      // missing, and every parent must still be a real, safe directory.
      if (
        tolerateMissingFile &&
        i === parts.length &&
        error?.code === "ENOENT" &&
        !existsSync(current)
      )
        return current;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (i < parts.length ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    ) {
      throw new Error(`Unsafe symlink, hardlink, or non-file: ${path}`);
    }
  }
  return resolve(root, path);
}

function isLocalEnvironmentFile(path) {
  const parts = path.split("/");
  return parts.some(
    (part, index) =>
      part.startsWith(".env") &&
      !(index === parts.length - 1 && [".env.example", ".env.docker.defaults"].includes(part)),
  );
}

function trackedSnapshot(root) {
  const files = new Map();
  for (const row of git(root, "ls-files", "--stage", "-z").split("\0").filter(Boolean)) {
    const match = /^(100644|100755) [a-f0-9]+ 0\t(.+)$/.exec(row);
    if (!match)
      throw new Error("Unmerged, symlink, or unsupported tracked entry; inspect git status");
    const path = match[2];
    if (isLocalEnvironmentFile(path)) {
      throw new Error(`Refusing to read tracked local environment file: ${path}`);
    }
    files.set(path, readFileSync(safeFile(root, path)));
  }
  return files;
}

function dirtyPaths(root) {
  // Include BOTH paths of renames/copies. Status also sees staged-only changes.
  const rows = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0");
  const paths = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    paths.push(row.slice(3));
    if (/^[RC]|^.[RC]/.test(row)) paths.push(rows[++i]);
  }
  return paths;
}

function assertClean(root, selected, paths) {
  const overlaps = dirtyPaths(root).filter(
    (path) =>
      paths.has(path) ||
      selected.some((name) => path === `apps/${name}` || path.startsWith(`apps/${name}/`)),
  );
  if (overlaps.length)
    throw new Error(
      `Removal overlaps existing work:\n${overlaps.map((path) => `  ${path}`).join("\n")}`,
    );
  // Git flags (assume-unchanged / skip-worktree) must not hide edited inputs.
  for (const path of paths) {
    const index = spawnSync("git", ["show", `:${path}`], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    // A plan-ADDED path is not in the index yet; an untracked file sitting at
    // that path was already refused as an overlap above.
    if (index.status !== 0) continue;
    const content = readFileSync(safeFile(root, path));
    if (!content.equals(index.stdout)) throw new Error(`Hidden or missing index input: ${path}`);
  }
}

function writeSnapshot(directory, files) {
  for (const [path, bytes] of files) {
    const destination = resolve(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

/** Only for directories created by mkdtemp here; never follows a symlink. */
function clearScratch(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) clearScratch(path);
    else unlinkSync(path);
  }
  rmdirSync(directory);
}

/** Explicit online preparation; previews and applies still never use the network. */
export function prepareRemovalCache(root) {
  root = resolve(root);
  if (realpathSync(root) !== root || git(root, "rev-parse", "--show-toplevel").trim() !== root)
    throw new Error("Run from the real Git repository root");
  const scratch = mkdtempSync(resolve(tmpdir(), "template-removal-cache-"));
  try {
    writeSnapshot(scratch, trackedSnapshot(root));
    // Frozen installs can cache abbreviated metadata without publish times.
    // Resolve complete platform metadata in a disposable snapshot, preserving
    // the owner's manifests, lockfile, index, and installed packages.
    run(scratch, "pnpm", [
      "install",
      "--lockfile-only",
      "--ignore-scripts",
      "--no-frozen-lockfile",
      "--no-prefer-frozen-lockfile",
    ]);
  } finally {
    clearScratch(scratch);
  }
}

const generated = [
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".env.example",
  "apps/web/.env.example",
  "pnpm-lock.yaml",
];

function generateAndCheck(root, files, selected) {
  const scratch = mkdtempSync(resolve(tmpdir(), "template-removal-plan-"));
  try {
    writeSnapshot(scratch, files);
    // No packages are installed and no lifecycle scripts run. An incomplete
    // local cache fails before the user's tree changes; never fall back online.
    if (selected.includes("native") || selected.includes("chat")) {
      run(scratch, "pnpm", [
        "install",
        "--lockfile-only",
        "--offline",
        "--ignore-scripts",
        "--no-frozen-lockfile",
      ]);
    }
    const dependencies = resolve(root, "node_modules");
    if (!existsSync(dependencies)) throw new Error("Run pnpm install before preparing a removal");
    symlinkSync(dependencies, resolve(scratch, "node_modules"), "dir");
    for (const args of [
      ["scripts/sync-agent-docs.ts"],
      ["scripts/sync-env-example.ts"],
      ["scripts/sync-env-example.ts", "--check"],
      ["scripts/check-docker-copy.ts"],
      ["scripts/check-doc-citations.ts"],
    ])
      run(scratch, process.execPath, ["--import", "tsx", ...args]);
    for (const path of generated) files.set(path, readFileSync(resolve(scratch, path)));
  } finally {
    clearScratch(scratch);
  }
}

function digest(files) {
  const hash = createHash("sha256");
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

// Exact complete matching lines, including counts/order, reviewed for absent
// clients. New or edited occurrences in these files also fail the inventory.
export const compatibility = {
  native: {
    ".gitignore": "90e82d37cbfbb18b5ef85c8557e087265bd0f485be6defebabcc62e4d9722fc3",
    ".dockerignore": "e3a2304fd868c5ac2954cda317ecba5ae5add68b4cb597de834654096d4cfc9e",
    "apps/web/src/i18n/index.ts":
      "ea851cd47a370e21cd4fa1449f034b42bd4b744f288932748cd2ec56c0c4195e",
    "packages/api/src/lib/asset-image-prepare.ts":
      "bc3bfcdb159df0f511998d34a460d36cf1ca1a496b8de8df185b5ef21839cb90",
    "scripts/check-docker-copy.ts":
      "856af89d9685a005384c3b9dad287416647dcbe551d9c69dac391535091472ec",
    "scripts/claude-hooks/pre-tool-use.mjs":
      "85a73f168edc4cd5dee3dc145f4712a255ddc0314ee55a13df1c95566e7acf22",
    "scripts/lib/env-schema.ts": "0d738eaf6aa29de5c91d7219785e4b5d549a95f1f898c3551ddb4b6735fcc8de",
    "pnpm-workspace.yaml": "6fbc9fc753bb82cc7aebabf2d2a9f76ef1b0b10f20e0c8249a107f165ffe800b",
  },
  cli: {
    ".gitignore": "8b3bbfd18b37e3c55147f27990f480b6ad921d016681c6bba8323d5bc67155b9",
    ".dockerignore": "bde7b76204809af1c81cd88f734e0b740d35cd066974995899ac732711ada11a",
    "scripts/check-docker-copy.ts":
      "63a784f1c76ec6be68950ac7740603ea6d5e849db778d3f30fc09087e61f599e",
    "scripts/check-load-dotenv-contract.ts":
      "cddd01e5d4d4fc7bd3c750d3d40ee2e28465e5c007307c0fec9643572efa7265",
  },
  // The OpenAI SDK's `chat.completions` API name is translation-only and the
  // only surviving `/chat/i` lines after the removal; the test mock asserts
  // against the same call. Pin both so a NEW chat consumer fails preview.
  chat: {
    "packages/i18n-translate/src/openrouter.ts":
      "d2583985ba0ed69c9e36cec892b766a80609a10007fa8ce5c0f2823f25855871",
    "packages/i18n-translate/src/openrouter.test.ts":
      "8380997b1a7cb8c38ab8ff0c286b59c90cdcac6afb7a8e0530e3b61aff052d48",
  },
};
function isConsumerCandidate(path) {
  // One conservative inventory for tracked AND nonignored untracked files.
  // No directory/extension allowlist: shell siblings, workflows, Dockerfiles,
  // extensionless tools, and root dot-configs can all hold literal consumers.
  // Prose and this helper's own maintained recipe/test references are inert.
  return (
    Boolean(path) &&
    !isLocalEnvironmentFile(path) &&
    !path.endsWith(".md") &&
    ![
      ".cursorrules",
      "apps/cli/.cursorrules",
      "scripts/remove-template-module.mjs",
      "scripts/remove-template-module.test.mjs",
      "scripts/lib/template-removal-recipes.mjs",
    ].includes(path)
  );
}

function assertConsumerInventory(files, selected) {
  for (const [path, bytes] of files) {
    if (!isConsumerCandidate(path)) continue;
    const text = bytes.toString();
    for (const module of selected) {
      const matches = text.split("\n").filter((line) => references[module].test(line));
      if (!matches.length) continue;
      const actual = createHash("sha256").update(matches.join("\n")).digest("hex");
      if (compatibility[module][path] !== actual)
        throw new Error(`Unreviewed remaining client consumer: ${path}`);
    }
    if (selected.includes("native") && path.endsWith("package.json")) {
      const manifest = JSON.parse(text);
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        if (nativeCatalog.some((name) => Object.hasOwn(manifest[field] ?? {}, name)))
          throw new Error(`Native dependencies are shared by ${path}; review the removal recipe`);
      }
    }
  }
}

function assertUntrackedConsumers(root, selected) {
  const files = new Map();
  for (const path of git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
    if (isConsumerCandidate(path)) {
      files.set(path, readFileSync(safeFile(root, path)));
    }
  }
  assertConsumerInventory(files, selected);
}

export function createRemovalPlan(root, selected) {
  root = resolve(root);
  if (realpathSync(root) !== root || git(root, "rev-parse", "--show-toplevel").trim() !== root)
    throw new Error("Run from the real Git repository root");
  if (
    !selected.length ||
    selected.some((name) => !modules.includes(name)) ||
    new Set(selected).size !== selected.length
  )
    throw new Error(`Choose from ${modules.join(", ")} — each at most once.`);
  selected = modules.filter((name) => selected.includes(name));
  assertClean(root, selected, new Set());
  const before = trackedSnapshot(root);
  const after = new Map(before);
  for (const module of selected) transformModule(after, module);
  const paths = new Set(
    [...before.keys()].filter(
      (path) => !after.has(path) || !before.get(path).equals(after.get(path)),
    ),
  );
  // Generators are part of the reviewed operation, including files whose
  // generated bytes happen to stay identical. Dirty generated files are not ours.
  for (const path of generated) paths.add(path);
  for (const path of before.keys()) {
    if (
      [
        "scripts/sync-agent-docs.ts",
        "scripts/sync-env-example.ts",
        "scripts/lib/env-manifest.ts",
        "scripts/lib/env-schema.ts",
      ].includes(path) ||
      path.startsWith("packages/env/src/vars/") ||
      (selected.includes("native") && (path.endsWith("package.json") || path === ".npmrc"))
    )
      paths.add(path);
  }
  assertClean(root, selected, paths);
  generateAndCheck(root, after, selected);
  assertConsumerInventory(after, selected);
  // New source outside the deletion set can already consume the chosen leaf.
  // Inspect only non-ignored code/config, never local environment files.
  assertUntrackedConsumers(root, selected);
  const changes = [...before]
    .filter(([path, bytes]) => !after.has(path) || !bytes.equals(after.get(path)))
    .map(([path, bytes]) => ({ path, before: bytes, after: after.get(path) ?? null }));
  // Files the plan ADDS — a recipe may replace a deleted doc with a successor
  // (e.g. patterns/add-ins/chat.md → patterns/removable/chat.md). They flow
  // through the same reviewed diff, journal, and confirmation as edits.
  for (const [path, bytes] of after)
    if (!before.has(path)) changes.push({ path, before: null, after: bytes });
  for (const { path } of changes) paths.add(path);
  assertClean(root, selected, paths);
  const inputDigest = digest(before);
  if (digest(trackedSnapshot(root)) !== inputDigest)
    throw new Error("Repository changed while preparing the plan; preview again");
  const token = createHash("sha256")
    .update(root)
    .update("\0")
    .update(selected.join(","))
    .update("\0")
    .update(inputDigest)
    .update(digest(after))
    .digest("hex");
  return { root, selected, changes, paths, inputDigest, token };
}

export function applyRemovalPlan(plan, confirmation) {
  if (confirmation !== plan.token)
    throw new Error("Confirmation does not match the reviewed plan; preview again");
  const gitDirectory = git(plan.root, "rev-parse", "--absolute-git-dir").trim();
  if (realpathSync(gitDirectory) !== gitDirectory)
    throw new Error("Symlink Git directory is unsupported");
  const lock = resolve(gitDirectory, "template-removal.lock");
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST")
      throw new Error(`Cannot create removal journal at ${lock}: ${error.message}`);
    throw new Error(
      `Another or interrupted removal owns ${lock}; inspect its journal and git diff before recovery`,
    );
  }
  let started = false;
  try {
    assertClean(plan.root, plan.selected, plan.paths);
    if (digest(trackedSnapshot(plan.root)) !== plan.inputDigest)
      throw new Error("Repository changed after preview; preview again");
    assertUntrackedConsumers(plan.root, plan.selected);
    for (const change of plan.changes) {
      const path = safeFile(plan.root, change.path, change.before === null);
      accessSync(
        change.after === null || change.before === null ? dirname(path) : path,
        constants.W_OK,
      );
    }
    // Durable intent comes before the first source edit. The journal contains
    // paths and hashes only, never file contents. It is not a multi-file commit.
    writeFileSync(
      fd,
      `${JSON.stringify({ version: 1, token: plan.token, modules: plan.selected, paths: plan.changes.map(({ path }) => path) })}\n`,
    );
    fsyncSync(fd);
    const directory = openSync(gitDirectory, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    started = true;
    for (const change of plan.changes) {
      const path = safeFile(plan.root, change.path, change.before === null);
      if (change.before === null) {
        // Plan-added file. O_CREAT|O_EXCL refuses an untracked file that
        // appeared at this path after preview instead of clobbering it.
        mkdirSync(dirname(path), { recursive: true });
        const created = openSync(path, "wx", 0o644);
        try {
          writeFileSync(created, change.after);
          fsyncSync(created);
        } finally {
          closeSync(created);
        }
      } else {
        if (!readFileSync(path).equals(change.before))
          throw new Error(`Concurrent edit at ${change.path}; stopping with journal retained`);
        if (change.after === null) unlinkSync(path);
        else {
          const target = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
          try {
            const current = lstatSync(path);
            const opened = fstatSync(target);
            if (opened.ino !== current.ino || opened.dev !== current.dev || opened.nlink !== 1)
              throw new Error(`Concurrent path replacement: ${change.path}`);
            // Writing via a checked descriptor preserves mode and never follows
            // a replaced symlink. A crash may leave this single file incomplete.
            writeFileSync(target, change.after);
            // truncate after writing because the replacement may be shorter.
            ftruncateSync(target, change.after.length);
            fsyncSync(target);
          } finally {
            closeSync(target);
          }
        }
      }
      writeFileSync(fd, `${JSON.stringify({ completed: change.path })}\n`);
      fsyncSync(fd);
    }
    closeSync(fd);
    fd = undefined;
    unlinkSync(lock);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (!started) unlinkSync(lock);
    else
      error.message += `; apply may be partial. Inspect the retained journal at ${lock} and git diff before recovery`;
    throw error;
  }
}

function printPlan(plan) {
  console.log(
    `Preview: remove ${plan.selected.join(" + ")}; ${plan.changes.length} tracked files change. No source or index changes.\n`,
  );
  const scratch = mkdtempSync(resolve(tmpdir(), "template-removal-diff-"));
  try {
    for (const change of plan.changes) {
      if (change.after === null) {
        console.log(`DELETE ${change.path}`);
        continue;
      }
      if (change.before === null) console.log(`ADD ${change.path}`);
      const oldPath = resolve(scratch, "before", change.path);
      const newPath = resolve(scratch, "after", change.path);
      mkdirSync(dirname(oldPath), { recursive: true });
      mkdirSync(dirname(newPath), { recursive: true });
      // A plan-added file has no before bytes; diff it against an empty file.
      writeFileSync(oldPath, change.before ?? Buffer.alloc(0));
      writeFileSync(newPath, change.after);
      console.log(
        run(
          scratch,
          "git",
          [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--",
            relative(scratch, oldPath),
            relative(scratch, newPath),
          ],
          [0, 1],
        ),
      );
    }
  } finally {
    clearScratch(scratch);
  }
  console.log(
    `After the owner reviews this entire plan, apply with:\nnode scripts/remove-template-module.mjs ${plan.selected.join(" ")} --apply --confirm ${plan.token}`,
  );
  console.log(
    `Apply leaves changes unstaged. Pause other writers. Files are changed individually; an interrupted apply retains a journal in the Git directory. After apply: pnpm install --offline --ignore-scripts${
      plan.selected.includes("chat")
        ? " && pnpm -F web build (regenerates apps/web/src/routeTree.gen.ts)"
        : ""
    } && pnpm verify.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || args.includes("--help")) {
      console.log(
        `Usage: node scripts/remove-template-module.mjs ${modules.join("|")} […]\nDefault: preview complete tracked deletions and dependent edits. Apply only after owner review, using --apply --confirm <preview hash>. Supported modules: ${modules.join(", ")}.\nUse --prepare-cache alone for explicit online metadata preparation in a temporary workspace; source and lockfile remain unchanged.`,
      );
    } else if (args.length === 1 && args[0] === "--prepare-cache") {
      prepareRemovalCache(process.cwd());
      console.log("Prepared offline removal metadata; source and lockfile are unchanged.");
    } else {
      const selected = args.filter((arg) => modules.includes(arg));
      const apply = args.includes("--apply");
      const confirmAt = args.indexOf("--confirm");
      const confirmation = confirmAt >= 0 ? args[confirmAt + 1] : undefined;
      const expected = [
        ...selected,
        ...(apply ? ["--apply"] : []),
        ...(confirmAt >= 0 ? ["--confirm", confirmation] : []),
      ];
      if (
        args.length !== expected.length ||
        args.some((arg) => !expected.includes(arg)) ||
        apply !== confirmAt >= 0
      )
        throw new Error("Unsupported arguments; use --help");
      const plan = createRemovalPlan(process.cwd(), selected);
      if (apply) {
        applyRemovalPlan(plan, confirmation);
        console.log(
          `Removed ${selected.join(" + ")} from tracked source; changes are unstaged. Ignored local data remains. Run pnpm install --offline --ignore-scripts${
            selected.includes("chat")
              ? ", then pnpm -F web build to regenerate apps/web/src/routeTree.gen.ts"
              : ""
          }, then pnpm verify before committing.`,
        );
      } else printPlan(plan);
    }
  } catch (error) {
    console.error(`Removal refused: ${error.message}`);
    process.exitCode = 1;
  }
}
