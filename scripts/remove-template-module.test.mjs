import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { applyRemovalPlan, createRemovalPlan } from "./remove-template-module.mjs";

const source = resolve(import.meta.dirname, "..");
const run = (cwd, command, args) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
};
const git = (root, ...args) => run(root, "git", args);
const read = (root, path) => readFileSync(resolve(root, path), "utf8");
function write(root, path, text) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
}
function cleanup(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) cleanup(path);
    else unlinkSync(path);
  }
  rmdirSync(directory);
}
function checkpoint(root) {
  git(root, "add", "--all");
  git(
    root,
    "-c",
    "user.name=Removal fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Disposable fixture snapshot",
  );
}
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "template-removal-test-"));
  t.after(() => cleanup(root));
  const paths = git(source, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  for (const path of paths) {
    if (/(?:^|\/)\.env(?:$|\.)/.test(path) && !/\.env\.(?:example|docker\.defaults)$/.test(path))
      continue;
    const origin = resolve(source, path);
    if (!existsSync(origin) || !lstatSync(origin).isFile()) continue;
    write(root, path, readFileSync(origin));
    chmodSync(resolve(root, path), lstatSync(origin).mode & 0o777);
  }
  git(root, "init", "-q");
  git(root, "config", "core.hooksPath", "/dev/null");
  checkpoint(root);
  // External dependencies reuse the existing store. Every workspace package
  // resolves to THIS fixture, so checks cannot silently inspect original source
  // or load the owner's real .env through an original workspace import.
  const manifests = paths.filter(
    (path) => path === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path),
  );
  const workspaces = new Map(
    manifests.map((path) => [JSON.parse(read(root, path)).name, dirname(path)]),
  );
  for (const manifest of manifests) {
    const installed = resolve(source, dirname(manifest), "node_modules");
    if (!existsSync(installed)) continue;
    const target = resolve(root, dirname(manifest), "node_modules");
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(installed)) {
      const names = entry.startsWith("@")
        ? readdirSync(resolve(installed, entry)).map((name) => `${entry}/${name}`)
        : [entry];
      for (const name of names) {
        const destination = resolve(target, name);
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(
          workspaces.has(name) ? resolve(root, workspaces.get(name)) : resolve(installed, name),
          destination,
        );
      }
    }
  }
  assert.equal(
    realpathSync(resolve(root, "node_modules/@starter/env")),
    resolve(root, "packages/env"),
  );
  return root;
}
function snapshot(root) {
  const hash = createHash("sha256");
  for (const path of git(root, "ls-files", "-z").split("\0").filter(Boolean)) {
    hash.update(path).update(readFileSync(resolve(root, path)));
  }
  return hash.digest("hex");
}

test("empty/default invocation explains preview and rejects unknown scope", () => {
  const result = run(source, process.execPath, ["scripts/remove-template-module.mjs"]);
  assert.match(result, /Default: preview/);
  assert.throws(() => createRemovalPlan(source, ["server"]), /Choose/);
});

test("cache preparation isolates lockfile writes and cleans up after success or failure", (t) => {
  const root = fixture(t);
  const bin = mkdtempSync(resolve(tmpdir(), "template-removal-pnpm-stub-"));
  t.after(() => cleanup(bin));
  const original = snapshot(root);
  const trace = resolve(bin, "trace.json");
  write(root, ".env", "LOCAL_TEST_MARKER=private\n");
  for (const status of [0, 1]) {
    const command = resolve(bin, "pnpm");
    writeFileSync(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), hasEnv: fs.existsSync(".env") }));
fs.writeFileSync("pnpm-lock.yaml", "scratch-only lockfile change");
process.exit(${status});
`,
    );
    chmodSync(command, 0o755);
    const result = spawnSync(
      process.execPath,
      [resolve(source, "scripts/remove-template-module.mjs"), "--prepare-cache"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, status, result.stderr);
    const prepared = JSON.parse(readFileSync(trace, "utf8"));
    assert.notEqual(prepared.cwd, root);
    assert.equal(prepared.hasEnv, false);
    assert.equal(existsSync(prepared.cwd), false, "temporary workspace must be removed");
    assert.ok(prepared.args.includes("--ignore-scripts"));
    assert.ok(prepared.args.includes("--lockfile-only"));
    assert.equal(snapshot(root), original, "source, manifests and lockfile must stay intact");
    assert.equal(git(root, "status", "--porcelain"), "", "index must stay intact");
  }
});

test("native preview and confirmed apply include every dependent consumer", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  if (!existsSync(resolve(root, "apps/native/package.json"))) {
    assert.throws(() => createRemovalPlan(root, ["native"]), /absent|removed/);
    return;
  }
  write(root, "apps/native/.env", "LOCAL_TEST_MARKER=preserve\n");
  write(root, "apps/native/.expo/local-state", "preserve cache\n");
  write(root, "apps/native/custom.p12", "preserve local artifact\n");
  const original = snapshot(root);
  const plan = createRemovalPlan(root, ["native"]);
  assert.equal(snapshot(root), original, "preview must not change tracked source");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.throws(() => applyRemovalPlan(plan, "not-reviewed"), /Confirmation/);
  assert.equal(snapshot(root), original);
  applyRemovalPlan(plan, plan.token);
  assert.equal(existsSync(resolve(root, "apps/native/package.json")), false);
  assert.equal(existsSync(resolve(root, "packages/env/src/vars/native.ts")), false);
  assert.equal(existsSync(resolve(root, "packages/locales/src/en-US/native.json")), false);
  assert.doesNotMatch(read(root, "scripts/setup.ts"), /ensureNativeEnvFile|NATIVE_ENV/);
  for (const path of ["packages/env/package.json", "packages/locales/package.json"])
    assert.doesNotMatch(read(root, path), /"\.\/native"/);
  assert.doesNotMatch(read(root, "pnpm-lock.yaml"), /apps\/native:/);
  assert.match(read(root, "pnpm-workspace.yaml"), /tailwind-merge/);
  assert.match(read(root, "pnpm-workspace.yaml"), /@orpc\/tanstack-query/);
  assert.doesNotMatch(read(root, "pnpm-workspace.yaml"), /@react-native\/metro-config/);
  assert.doesNotMatch(read(root, "docker-compose.agent.yml"), /nm_apps_native/);
  assert.equal(read(root, "apps/native/.env"), "LOCAL_TEST_MARKER=preserve\n");
  assert.equal(read(root, "apps/native/.expo/local-state"), "preserve cache\n");
  git(root, "check-ignore", "apps/native/custom.p12", "apps/native/.expo/local-state");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "", "apply must not stage anything");
  assert.throws(() => createRemovalPlan(root, ["native"]), /overlaps|absent|removed/);
  // Separate removals remain supported after the owner reviews and commits.
  checkpoint(root);
  if (existsSync(resolve(root, "apps/cli/Cargo.toml"))) {
    const cli = createRemovalPlan(root, ["cli"]);
    applyRemovalPlan(cli, cli.token);
    assert.equal(existsSync(resolve(root, "apps/cli/Cargo.toml")), false);
    assert.equal(existsSync(resolve(root, ".github/workflows/release.yml")), true);
  }
});

test("chat removal deletes the runtime, queue, rate family, and route tree entry end to end", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  if (!existsSync(resolve(root, "packages/agent-runtime/package.json"))) {
    assert.throws(() => createRemovalPlan(root, ["chat"]), /absent|removed/);
    return;
  }
  const original = snapshot(root);
  const plan = createRemovalPlan(root, ["chat"]);
  assert.equal(snapshot(root), original, "preview must not change tracked source");
  assert.equal(git(root, "status", "--porcelain"), "");
  applyRemovalPlan(plan, plan.token);
  for (const path of [
    "packages/agent-runtime/package.json",
    "packages/api/src/routers/chat.ts",
    "packages/api/src/lib/chat.ts",
    "apps/server/src/chat-routes.ts",
    "apps/worker/src/handlers/chat-run.ts",
    "apps/web/src/routes/$lang/_app/_auth/chat.tsx",
    "packages/locales/src/en-US/chat.json",
    "packages/db/prisma/schema/chat.prisma",
    "patterns/add-ins/chat.md",
    "patterns/agent-runtime.md",
  ])
    assert.equal(existsSync(resolve(root, path)), false);
  assert.equal(existsSync(resolve(root, "packages/api/src/lib/procedure-budget.ts")), true);
  assert.equal(existsSync(resolve(root, "patterns/removable/chat.md")), true);
  assert.doesNotMatch(read(root, "apps/web/src/routeTree.gen.ts"), /chat/i);
  assert.doesNotMatch(read(root, "packages/queue/src/jobs.ts"), /chat/i);
  assert.doesNotMatch(read(root, "packages/api/src/lib/rate-limit-families.ts"), /chat/i);
  assert.doesNotMatch(read(root, "scripts/lib/env-manifest.ts"), /chat/i);
  assert.doesNotMatch(
    read(root, "pnpm-workspace.yaml"),
    /openrouter\/sdk|react-markdown|@tanstack\/ai/,
  );
  assert.doesNotMatch(read(root, "pnpm-lock.yaml"), /agent-runtime/);
  assert.match(read(root, "pnpm-lock.yaml"), /sharp/);
  assert.match(read(root, "patterns/README.md"), /removable\/chat\.md/);
  assert.doesNotMatch(read(root, ".env.example"), /CHAT_/);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "", "apply must not stage anything");
  checkpoint(root);
  assert.throws(() => createRemovalPlan(root, ["chat"]), /overlaps|absent|removed/);
  run(root, process.execPath, [
    resolve(source, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.scripts.json",
    "--incremental",
    "false",
  ]);
  run(root, process.execPath, [resolve(source, "node_modules/knip/bin/knip.js")]);
});

test("CLI and combined removal preserve container releases and ignored artifacts", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  if (!existsSync(resolve(root, "apps/cli/Cargo.toml"))) {
    assert.throws(() => createRemovalPlan(root, ["cli"]), /absent|removed/);
    return;
  }
  write(root, "apps/cli/target/local-object", "retain target\n");
  write(root, "apps/cli/dist-output/local-release", "retain release\n");
  const cli = createRemovalPlan(root, ["cli"]);
  applyRemovalPlan(cli, cli.token);
  const release = read(root, ".github/workflows/release.yml");
  assert.doesNotMatch(release, /cli_present|apps\/cli|release-preflight|publish-cli-release/);
  assert.match(release, /needs\.node-checks\.result == 'success'/);
  for (const name of ["app", "worker", "db-applier"])
    assert.match(release, new RegExp(`- name: ${name}\\n`));
  assert.equal(read(root, "apps/cli/target/local-object"), "retain target\n");
  assert.equal(read(root, "apps/cli/dist-output/local-release"), "retain release\n");
  git(root, "check-ignore", "apps/cli/target/local-object", "apps/cli/dist-output/local-release");
  assert.doesNotMatch(read(root, ".github/dependabot.yml"), /package-ecosystem: cargo/);
  assert.doesNotMatch(read(root, ".github/labeler.yml"), /apps\/cli|cli-change/);
  assert.equal(existsSync(resolve(root, ".github/workflows/cli-ci.yml")), false);
  assert.equal(existsSync(resolve(root, ".github/workflows/release-preflight.yml")), false);
  checkpoint(root);
  if (existsSync(resolve(root, "apps/native/package.json"))) {
    const native = createRemovalPlan(root, ["native"]);
    applyRemovalPlan(native, native.token);
    assert.equal(existsSync(resolve(root, "apps/native/package.json")), false);
  }
});

test("dirty, staged, untracked, symlink, and drift inputs fail before mutation", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  const path = "apps/cli/Cargo.toml";
  if (!existsSync(resolve(root, path))) {
    assert.throws(() => createRemovalPlan(root, ["cli"]), /absent|removed/);
    return;
  }
  const original = read(root, path);
  write(root, path, `${original}\n# owned change\n`);
  assert.throws(() => createRemovalPlan(root, ["cli"]), /overlaps/);
  git(root, "add", "--", path);
  assert.throws(() => createRemovalPlan(root, ["cli"]), /overlaps/);
  write(root, path, original);
  assert.throws(() => createRemovalPlan(root, ["cli"]), /overlaps/);
  git(root, "add", "--", path);
  write(root, "apps/cli/new-source.rs", "// owner work\n");
  assert.throws(() => createRemovalPlan(root, ["cli"]), /overlaps/);
  unlinkSync(resolve(root, "apps/cli/new-source.rs"));
  const recipe = read(root, ".github/labeler.yml");
  write(root, ".github/labeler.yml", recipe.replace("cli-change:", "renamed-cli-label:"));
  checkpoint(root);
  const before = snapshot(root);
  assert.throws(() => createRemovalPlan(root, ["cli"]), /Recipe drift/);
  assert.equal(snapshot(root), before);
  write(root, ".github/labeler.yml", recipe);
  checkpoint(root);
  const plan = createRemovalPlan(root, ["cli"]);
  write(root, "README.md", `${read(root, "README.md")}\nOwner change after preview.\n`);
  assert.throws(() => applyRemovalPlan(plan, plan.token), /overlaps|changed/);
  assert.equal(existsSync(resolve(root, path)), true);
  checkpoint(root);
  unlinkSync(resolve(root, ".github/labeler.yml"));
  symlinkSync(resolve(root, "README.md"), resolve(root, ".github/labeler.yml"));
  assert.throws(() => createRemovalPlan(root, ["cli"]), /Unsafe symlink/);
});

const consumerPaths = [
  "scripts/publish-client.sh",
  ".github/workflows/new-client.yml",
  ".clientrc",
  "client.config.json",
  "Dockerfile.client",
  "scripts/publish-client.bash",
  "tools/publish-client",
  "config/client.toml",
  "tools/client.py",
];

test("tracked shell, workflow, root configuration, and sibling consumers refuse preview", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  const selected = existsSync(resolve(root, "apps/cli/Cargo.toml")) ? ["cli"] : ["native"];
  if (!existsSync(resolve(root, `apps/${selected[0]}`))) {
    t.skip("Both optional clients are absent");
    return;
  }
  for (const path of consumerPaths) {
    const content = `# Literal client consumer\ncd apps/${selected[0]}\ncargo build --locked\n`;
    write(root, path, content);
    checkpoint(root);
    const before = snapshot(root);
    assert.throws(
      () => createRemovalPlan(root, selected),
      (error) => error.message === `Unreviewed remaining client consumer: ${path}`,
      path,
    );
    assert.equal(snapshot(root), before, `${path}: refusal must preserve tracked source`);
    assert.equal(git(root, "status", "--porcelain"), "");
    unlinkSync(resolve(root, path));
    checkpoint(root);
  }
});

test("untracked consumers refuse preview and confirmed apply across the same inventory", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  const selected = existsSync(resolve(root, "apps/cli/Cargo.toml")) ? ["cli"] : ["native"];
  if (!existsSync(resolve(root, `apps/${selected[0]}`))) {
    t.skip("Both optional clients are absent");
    return;
  }
  const before = snapshot(root);
  const plan = createRemovalPlan(root, selected);
  // Workflow reproduction first: this passed the old directory filter.
  for (const path of [consumerPaths[1], ...consumerPaths.filter((_, index) => index !== 1)]) {
    const content = `working-directory: apps/${selected[0]}\n`;
    write(root, path, content);
    const refused = (error) => error.message === `Unreviewed remaining client consumer: ${path}`;
    assert.throws(() => createRemovalPlan(root, selected), refused, path);
    assert.throws(() => applyRemovalPlan(plan, plan.token), refused, path);
    assert.equal(snapshot(root), before, `${path}: refusal must precede source mutation`);
    assert.equal(read(root, path), content, `${path}: preserve the owner's new file`);
    assert.equal(existsSync(resolve(root, ".git/template-removal.lock")), false);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    unlinkSync(resolve(root, path));
  }
  // A failed inventory preflight releases its ownership and permits a clean retry.
  applyRemovalPlan(plan, plan.token);
  assert.equal(existsSync(resolve(root, `apps/${selected[0]}/package.json`)), false);
  assert.equal(existsSync(resolve(root, `apps/${selected[0]}/Cargo.toml`)), false);
});

test("combined preview, shared work, hidden edits, and interrupted-owner lock", {
  timeout: 180_000,
}, (t) => {
  const root = fixture(t);
  const selected = ["native", "cli"].filter((name) =>
    existsSync(resolve(root, `apps/${name}/${name === "native" ? "package.json" : "Cargo.toml"}`)),
  );
  if (!selected.length) {
    assert.throws(() => createRemovalPlan(root, []), /Choose/);
    return;
  }
  const before = snapshot(root);
  const plan = createRemovalPlan(root, selected);
  write(root, ".git/template-removal.lock", "Interrupted owner; reviewed paths remain pending\n");
  assert.throws(() => applyRemovalPlan(plan, plan.token), /interrupted removal/);
  assert.equal(snapshot(root), before);
  unlinkSync(resolve(root, ".git/template-removal.lock"));
  const readme = read(root, "README.md");
  git(root, "update-index", "--assume-unchanged", "README.md");
  write(root, "README.md", `${readme}\nHidden owner edit.\n`);
  assert.throws(() => applyRemovalPlan(plan, plan.token), /Hidden/);
  assert.equal(existsSync(resolve(root, ".git/template-removal.lock")), false);
  write(root, "README.md", readme);
  git(root, "update-index", "--no-assume-unchanged", "README.md");
  write(root, "scripts/new-client-consumer.mjs", `const client = "apps/${selected[0]}";\n`);
  assert.throws(() => createRemovalPlan(root, selected), /Unreviewed remaining client consumer/);
  unlinkSync(resolve(root, "scripts/new-client-consumer.mjs"));
  const sharedPath = selected.includes("native") ? "package.json" : "README.md";
  const sharedContent = read(root, sharedPath);
  write(root, sharedPath, `${sharedContent}\n`);
  assert.throws(() => createRemovalPlan(root, selected), /overlaps/);
  write(root, sharedPath, sharedContent);
  write(root, "owner-note.txt", "Keep this unrelated work.\n");
  applyRemovalPlan(plan, plan.token);
  assert.equal(read(root, "owner-note.txt"), "Keep this unrelated work.\n");
  for (const name of selected)
    assert.equal(
      existsSync(
        resolve(root, `apps/${name}/${name === "native" ? "package.json" : "Cargo.toml"}`),
      ),
      false,
    );
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  run(root, process.execPath, [
    resolve(source, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.scripts.json",
    "--incremental",
    "false",
  ]);
  run(root, process.execPath, [resolve(source, "node_modules/knip/bin/knip.js")]);
});
