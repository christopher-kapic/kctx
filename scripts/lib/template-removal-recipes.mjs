/** Maintained transforms for the shipped leaf clients and removable features. No arbitrary paths. */

export const modules = ["native", "cli", "chat"];

/**
 * Consumer-inventory patterns. One per module: any surviving line in a
 * non-markdown file that matches must be pinned in the engine's reviewed
 * `compatibility` map, so new or edited consumers fail preview until reviewed.
 */
export const references = {
  native:
    /apps\/native|@[^\s"']+\/(?:env|locales)\/native|EXPO_PUBLIC|doctor:native|ensureNativeEnvFile/,
  cli: /apps\/cli|cli-ci\.yml|release-preflight\.yml/,
  // Broad on purpose: every surviving "chat" line in a non-markdown file must
  // be pinned (translation's OpenAI `chat.completions` call) or removed.
  chat: /chat/i,
};

function kit(files) {
  const deleted = [];
  const edit = (path, pattern, replacement = "", count = 1) => {
    const before = files.get(path)?.toString("utf8");
    if (before === undefined) throw new Error(`Missing recipe input: ${path}`);
    const matches = [...before.matchAll(new RegExp(pattern.source, "gm"))];
    if (matches.length !== count) {
      throw new Error(
        `Recipe drift in ${path}: expected ${count} anchor(s), found ${matches.length}`,
      );
    }
    files.set(path, Buffer.from(before.replace(new RegExp(pattern.source, "gm"), replacement)));
  };
  // For "update X if present" steps: zero matches are fine, more than `count` is drift.
  const editOptional = (path, pattern, replacement = "", count = 1) => {
    const before = files.get(path)?.toString("utf8");
    if (before === undefined) return false; // a prior module in this plan may have removed the file
    const matches = [...before.matchAll(new RegExp(pattern.source, "gm"))];
    if (matches.length > count) {
      throw new Error(
        `Recipe drift in ${path}: expected at most ${count} anchor(s), found ${matches.length}`,
      );
    }
    if (!matches.length) return false;
    files.set(path, Buffer.from(before.replace(new RegExp(pattern.source, "gm"), replacement)));
    return true;
  };
  const remove = (path) => {
    if (!files.has(path)) throw new Error(`Missing removal input: ${path}`);
    files.delete(path);
    deleted.push(path);
  };
  const removeOptional = (path) => {
    if (files.has(path)) remove(path);
  };
  // Deletes a whole tracked subtree. The sentinel proves the sweep targets the
  // shipped feature (drift detection); everything under the prefix goes, so a
  // file the recipe failed to enumerate is still removed rather than dangled.
  const removeTree = (prefix, sentinel) => {
    if (!files.has(sentinel)) throw new Error(`Missing removal input: ${sentinel}`);
    let swept = 0;
    for (const path of [...files.keys()]) {
      if (path.startsWith(prefix)) {
        remove(path);
        swept++;
      }
    }
    if (!swept) throw new Error(`Removal sweep matched nothing under ${prefix}`);
  };
  const requireFile = (path) => {
    if (!files.has(path)) throw new Error(`Missing recipe input: ${path}`);
  };
  const absent = (path) => !files.has(path);
  const set = (path, content) => {
    if (!files.has(path)) throw new Error(`Missing recipe input: ${path}`);
    files.set(path, Buffer.from(content));
  };
  return {
    deleted,
    edit,
    editOptional,
    remove,
    removeOptional,
    removeTree,
    requireFile,
    absent,
    set,
  };
}

export function transformModule(files, module) {
  if (module === "chat") return transformChat(files);
  if (module === "native" || module === "cli") return transformLeafClient(files, module);
  throw new Error(`Unknown module: ${module}`);
}

function transformLeafClient(files, module) {
  const { deleted } = kit(files);
  const edit = (path, pattern, replacement = "", count = 1) => {
    const before = files.get(path)?.toString("utf8");
    if (before === undefined) throw new Error(`Missing recipe input: ${path}`);
    const matches = [...before.matchAll(new RegExp(pattern.source, "gm"))];
    if (matches.length !== count) {
      throw new Error(
        `Recipe drift in ${path}: expected ${count} anchor(s), found ${matches.length}`,
      );
    }
    files.set(path, Buffer.from(before.replace(new RegExp(pattern.source, "gm"), replacement)));
  };
  const remove = (path) => {
    if (!files.has(path)) throw new Error(`Missing removal input: ${path}`);
    files.delete(path);
    deleted.push(path);
  };
  const leaf = `apps/${module}/`;
  if (!files.has(`${leaf}${module === "native" ? "package.json" : "Cargo.toml"}`)) {
    throw new Error(`${module} is absent or already removed`);
  }
  for (const path of files.keys()) if (path.startsWith(leaf)) remove(path);

  // The removed module's own ignore file must not expose retained local data.
  // Keeping the whole absent leaf ignored also preserves unusual local patterns.
  const append = (path, text) => {
    if (!files.has(path)) throw new Error(`Missing recipe input: ${path}`);
    files.set(path, Buffer.from(`${files.get(path).toString().trimEnd()}\n\n${text}\n`));
  };
  if (module === "cli") edit(".gitignore", /^apps\/cli\/target\/\n/);
  append(".gitignore", `# Retained local data after explicit ${module} removal.\n/apps/${module}/`);
  if (module === "cli") {
    edit(".dockerignore", /^# Rust CLI —[^\n]*\n# context[^\n]*\napps\/cli\n/);
  }
  append(
    ".dockerignore",
    `# Retained local data from the removed ${module} client.\napps/${module}`,
  );

  if (module === "native") {
    for (const path of [
      "scripts/native-doctor.ts",
      "packages/env/src/native.ts",
      "packages/env/src/vars/native.ts",
      "packages/locales/src/native.ts",
      "packages/locales/src/native.test.ts",
    ])
      remove(path);
    const locales = [...files.keys()].filter((path) =>
      /^packages\/locales\/src\/[^/]+\/native\.json$/.test(path),
    );
    if (!locales.includes("packages/locales/src/en-US/native.json"))
      throw new Error("Native locale inventory drift");
    for (const path of locales) remove(path);
    for (const name of [
      "dev:native",
      "native:android",
      "native:ios",
      "native:web",
      "doctor:native",
    ]) {
      edit("package.json", new RegExp(`^    "${name}": "[^"\\n]+",\\n`));
    }
    for (const path of ["packages/env/package.json", "packages/locales/package.json"]) {
      edit(path, /^ {4}"\.\/native": "\.\/src\/native\.ts",\n/);
    }
    edit("scripts/setup.ts", /^ \* {3}3\. Copy apps\/native\/[^\n]*\n/);
    edit("scripts/setup.ts", /^const NATIVE_ENV(?:_EXAMPLE)?_PATH = [^\n]*\n/, "", 2);
    edit(
      "scripts/setup.ts",
      /^\/\/ -+\n\/\/ 3\. Copy apps\/native\/[^\n]*\n\/\/ -+\nfunction ensureNativeEnvFile\(\) \{[\s\S]*?^\}\n\n/,
    );
    edit("scripts/setup.ts", /^ {2}ensureNativeEnvFile\(\);\n/);
    edit("scripts/lib/env-manifest.ts", / \| "native"/);
    edit(
      "scripts/lib/env-manifest.ts",
      /^ {2}\/\/ --- apps\/native\/\.env[^\n]*\n {2}\{\n {4}id: "native",[\s\S]*?^ {2}\},\n/,
    );
    edit(
      "scripts/lib/env-manifest.ts",
      /^ {2}\/\/ --- apps\/native\/\.env[^\n]*\n {2}\{\n {4}key: "EXPO_PUBLIC_SERVER_URL",[\s\S]*?^ {2}\},\n/,
    );
    edit("scripts/lib/env-manifest.ts", /`, and `apps\/native\/\.env\.example`\./, "`.");
    edit(
      "scripts/lib/env-manifest.ts",
      /Those three files are GENERATED/,
      "Those files are GENERATED",
    );
    edit(
      "scripts/lib/env-manifest.ts",
      /server \+ worker, server = server-only, web = VITE_\*, native =\n \* {6}EXPO_PUBLIC_\*\)/,
      "server + worker, server = server-only, web = VITE_*)",
    );
    edit(
      "scripts/sync-env-example.ts",
      /^ {2}\{\n {4}file: "native",\n {4}path: "apps\/native\/\.env\.example",\n {4}header: \[\.\.\.GENERATED_BANNER\],\n {2}\},\n/,
    );
    edit(
      "scripts/sync-env-example.ts",
      /^\/\/ {4}the Expo app deletes apps\/native\/\.env\.example, and ripping out the web app\n/,
      "//    a client can remove its generated example; removing the web app\n",
    );
    for (const name of nativeCatalog) {
      edit(
        "pnpm-workspace.yaml",
        new RegExp(`^  "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": [^\\n]+\\n`),
      );
    }
    edit(
      "pnpm-workspace.yaml",
      /^ {2}# Auto-installed Metro peers must follow React Native in Expo SDK 57\.\n {2}"@react-native\/metro-config": 0\.86\.3\n/,
    );
    // Last native entry has no trailing comma in the shipped array.
    edit(
      "turbo.json",
      /,\n {8}"EXPO_\*",\n {8}"EXPO_PUBLIC_\*",\n {8}"ANDROID_HOME",\n {8}"ANDROID_SDK_ROOT",\n {8}"JAVA_HOME"/,
    );
    edit("knip.jsonc", /^ {4}"apps\/native": \{[\s\S]*?^ {4}\},\n/);
    edit(
      "docker-compose.agent.yml",
      /^ {6}- \$\{AGENT_VOLUME_ROOT\}\/nm_apps_native:\/app\/apps\/native\/node_modules\n/,
    );
    edit(
      ".github/dependabot.yml",
      /^ {2}# Expo\/React Native majors[^\n]*\n {2}# upgrades[^\n]*\n {2}# piecemeal[^\n]*\n/,
    );
    edit(".github/dependabot.yml", /^ {6}native-sdk:\n[\s\S]*?(?=^ {6}minor-and-patch:)/);
    for (const name of ["expo", "expo-*", "@expo/*", "react-native", "react-native-*"]) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      edit(
        ".github/dependabot.yml",
        new RegExp(
          `^      - dependency-name: "${escaped}"\\n        update-types: \\["version-update:semver-major"\\]\\n`,
        ),
      );
    }
    edit("AGENTS.md", /^### Native App — Expo Guardrails\n[\s\S]*?(?=^### )/);
    edit("AGENTS.md", /Expo native \(\[removable\/native\]\([^\n]+?\)\), /);
    edit("AGENTS.md", /^apps\/native\/[^\n]*\n/);
    edit("AGENTS.md", / Expo additionally has `native`\. <!-- removable-native:[^\n]*?-->/);
    edit("AGENTS.md", /^- Do not bypass `pnpm doctor:native`[^\n]*\n/);
    edit("AGENTS.md", / Native enables React Compiler[^\n]*?<!-- removable-native:[^\n]*?-->/);
    edit("README.md", /^- \*\*Expo mobile app\*\*[^\n]*\n/);
    edit("README.md", /^- creates `apps\/native\/[^\n]*\n/);
    edit(
      "README.md",
      /^The Expo app has its own public API URL:\n\n```bash\ncp apps\/native\/\.env\.example apps\/native\/\.env\n```\n\n/,
    );
    edit("README.md", /^#### Native \(`apps\/native\/\.env`\)\n[\s\S]*?(?=^### )/);
    edit("README.md", /^### 5\. Run the mobile app\n[\s\S]*?(?=^### )/);
    // Removable-modules line lists "the Expo app, the Rust CLI, i18n, …"; drop
    // this client's "X, " item. The trailing comma form stays order-independent
    // when a combined plan also removes the sibling item from the same list.
    edit("README.md", /the Expo app, /);
    edit("README.md", /^A note on `pnpm audit`:[^\n]*removable Expo app[^\n]*\n/);
    edit("patterns/README.md", /^\| Work on the Expo native app[^\n]*\n/);
    edit("patterns/getting-started.md", /^If the developer plans to run the mobile app,[^\n]*\n\n/);
    edit("patterns/getting-started.md", /^\| Expo mobile app[^\n]*\n/);
    remove("patterns/native.md");
    edit(
      "patterns/removable/i18n.md",
      /\[native\.md\]\(\.\.\/native\.md\)/,
      "[native removal recipe](./native.md)",
    );
    // The optional-clients triage prose names each client's carrying cost; drop
    // the Expo one (it cites `pnpm doctor:native`, which this removal deletes).
    // The includes() branch keeps this order-independent when a combined plan
    // also removes the Rust CLI clause from the same sentence.
    if (
      files
        .get("patterns/getting-started.md")
        .toString()
        .includes("to check; carrying an unused Rust CLI")
    ) {
      edit(
        "patterns/getting-started.md",
        /Carrying an unused Expo app means an Expo SDK to keep coordinated and a native env for `pnpm doctor:native` to check; carrying an unused Rust CLI/,
        "Carrying an unused Rust CLI",
      );
    } else {
      edit(
        "patterns/getting-started.md",
        /Carrying an unused Expo app means an Expo SDK to keep coordinated and a native env for `pnpm doctor:native` to check\. /,
      );
    }
  } else {
    for (const path of [".github/workflows/cli-ci.yml", ".github/workflows/release-preflight.yml"])
      remove(path);
    edit(
      ".github/dependabot.yml",
      /^ {2}# Cargo —[^\n]*\n {2}# block[^\n]*\n {2}- package-ecosystem: cargo\n[\s\S]*?(?=^ {2}# npm)/,
    );
    edit(".github/labeler.yml", /^ {10}- "apps\/cli\/Cargo\.(?:toml|lock)"\n/, "", 2);
    edit(
      ".github/labeler.yml",
      /^cli-change:\n {2}- changed-files:\n {6}- any-glob-to-any-file: "apps\/cli\/\*\*"\n/,
    );
    // A skipped reusable-workflow job still needs its referenced YAML file.
    // Strip the complete CLI branch before deleting release-preflight.yml.
    edit(
      ".github/workflows/release.yml",
      /^# Manual, versioned releases[\s\S]*?(?=^name: Release)/,
      "# Manual, versioned app, worker, and db-applier container releases to GHCR.\n# The companion CLI was removed; Node checks still gate publication.\n",
    );
    edit(".github/workflows/release.yml", /\. Must match apps\/cli\/Cargo\.toml\./, ".");
    edit(
      ".github/workflows/release.yml",
      /^ {6}# Whether apps\/cli\/Cargo\.toml exists,[\s\S]*?^ {6}cli_present: [^\n]*\n/,
    );
    edit(
      ".github/workflows/release.yml",
      /^ {10}if \[ -f apps\/cli\/Cargo\.toml \]; then\n[\s\S]*?^ {10}fi\n/,
    );
    edit(".github/workflows/release.yml", /^ {12}echo "cli_present=\$cli_present"\n/);
    edit(".github/workflows/release.yml", /^ {2}release-preflight:\n[\s\S]*?(?=^ {2}node-checks:)/);
    edit(
      ".github/workflows/release.yml",
      /^ {2}# ── CLI artifacts[^\n]*\n[\s\S]*?(?=^ {2}release-summary:)/,
    );
    edit(".github/workflows/release.yml", /^ {6}- release-preflight\n/);
    edit(
      ".github/workflows/release.yml",
      /^ {4}# `release-preflight` is skipped[\s\S]*?(?=^ {4}if:)/,
    );
    edit(".github/workflows/release.yml", /^ {6}&& \(needs\.release-preflight[^\n]*\n/);
    edit(".github/workflows/release.yml", /^ {6}- publish-cli-release\n/);
    edit(".github/workflows/release.yml", / && needs\.publish-cli-release\.result == 'success'/);
    edit(".github/workflows/release.yml", /^ {12}echo "- CLI artifacts:[^\n]*\n/);
    edit("AGENTS.md", /^### Rust CLI — Companion Command-Line Tool\n[\s\S]*?(?=^### )/);
    edit("AGENTS.md", /Rust CLI \(\[removable\/cli\]\([^\n]+?\)\), /);
    edit("AGENTS.md", /^apps\/cli\/[^\n]*\n/);
    edit("README.md", /^- \*\*Companion Rust CLI\*\*[^\n]*\n/);
    // Same removable-modules line; drop this client's "X, " item (see native).
    edit("README.md", /the Rust CLI, /);
    edit("README.md", /^│ {3}└── cli\/[^\n]*\n/);
    edit("patterns/README.md", /^\| Work on the companion Rust CLI[^\n]*\n/);
    edit("patterns/getting-started.md", /^\| Companion Rust CLI[^\n]*\n/);
    remove("patterns/cli.md");
    // The defer paragraph carries the only CLI-specific `cargo xtask init` note.
    edit(
      "patterns/getting-started.md",
      /, and note that the Rust CLI needs `cargo xtask init` before anyone uses it \(\[cli\.md\]\(\.\/cli\.md\)\)/,
    );
    // The triage prose names each client's carrying cost; drop the Rust CLI one.
    // Can follow native removal in the same reviewed plan or a later commit, so
    // the includes() branch keeps this order-independent with native removal of
    // the same sentence.
    if (
      files
        .get("patterns/getting-started.md")
        .toString()
        .includes("Carrying an unused Expo app means")
    ) {
      edit(
        "patterns/getting-started.md",
        /; carrying an unused Rust CLI means a second toolchain and a second CI pipeline/,
      );
    } else {
      edit(
        "patterns/getting-started.md",
        /Carrying an unused Rust CLI means a second toolchain and a second CI pipeline\. /,
      );
    }
  }
  return deleted;
}

/**
 * Remove the durable agentic chat module: the `@starter/agent-runtime`
 * package, the chat oRPC router + SSE routes, the BullMQ chat-run queues,
 * the web page/components/hooks/locales, the `chat` Prisma schema file, the
 * CHAT rate-limit family and its env surface, and the add-in docs.
 * Translation's OpenAI `chat.completions` call stays (pinned in the engine's
 * `compatibility` map). `routeTree.gen.ts` is stripped of its chat entries in
 * the plan so the tree stays coherent; `pnpm -F web build` regenerates it
 * authoritatively after apply.
 */
function transformChat(files) {
  const { deleted, edit, remove, removeTree, requireFile } = kit(files);
  if (!files.has("packages/agent-runtime/package.json"))
    throw new Error("chat is absent or already removed");

  // ---- Deletes: the runtime package, server routes, worker jobs, web UI. ----
  removeTree("packages/agent-runtime/", "packages/agent-runtime/package.json");
  for (const path of [
    "packages/api/src/routers/chat.ts",
    "packages/api/src/routers/chat.test.ts",
    "packages/api/src/lib/chat.ts",
    "packages/api/src/lib/chat.test.ts",
    "packages/api/src/lib/chat.contract.test.ts",
    "packages/api/src/lib/chat-enabled.ts",
    "packages/api/src/lib/chat-enabled.test.ts",
    "packages/api/src/lib/chat-rate-limit.ts",
    "packages/api/src/lib/chat-rate-limit.test.ts",
    "apps/server/src/chat-routes.ts",
    "apps/server/src/chat-routes.test.ts",
    "apps/server/src/chat-subscriber.ts",
    "apps/server/src/chat-subscriber.test.ts",
    "apps/worker/src/handlers/chat-run.ts",
    "apps/worker/src/handlers/chat-run.test.ts",
    "apps/worker/src/handlers/reap-stale-chat-runs.ts",
    "apps/worker/src/handlers/reap-stale-chat-runs.test.ts",
    "apps/worker/src/lib/chat-prompts.ts",
    "apps/worker/src/lib/chat-prompts.test.ts",
    "apps/worker/src/lib/chat-tools.ts",
    "apps/worker/src/lib/chat-tools.test.ts",
    "apps/worker/src/lib/result-store.ts",
    "apps/worker/src/lib/result-store.test.ts",
    "apps/web/src/routes/$lang/_app/_auth/chat.tsx",
    "apps/web/src/hooks/use-chat-enabled.ts",
    "apps/web/src/hooks/use-chat-stream.ts",
    "apps/web/src/hooks/use-chat-stream.test.ts",
    "apps/web/src/hooks/use-stick-to-bottom.ts",
    "apps/web/src/lib/chat-composer.ts",
    "apps/web/src/lib/chat-composer.test.ts",
    "apps/web/src/lib/chat-messages.ts",
    "apps/web/src/lib/chat-messages.test.ts",
    "apps/web/src/lib/chat-sessions.ts",
    "apps/web/src/lib/chat-sessions.test.ts",
    "packages/locales/src/en-US/chat.json",
    "packages/locales/src/es-MX/chat.json",
    "packages/db/prisma/schema/chat.prisma",
    "patterns/add-ins/chat.md",
    "patterns/agent-runtime.md",
  ])
    remove(path);
  removeTree("apps/web/src/components/chat/", "apps/web/src/components/chat/message-list.tsx");
  // The spend-limiter factory is shared (`auth.verifyEmailTransport` uses it).
  requireFile("packages/api/src/lib/procedure-budget.ts");

  // ---- oRPC router registration. ----
  edit("packages/api/src/routers/index.ts", /^import \{ chatRouter \} from "\.\/chat";\n/);
  edit("packages/api/src/routers/index.ts", /^ {2}chat: chatRouter,\n/);

  // ---- Queue package: job schemas, queue constructors, enqueue helpers. ----
  edit(
    "packages/queue/src/jobs.ts",
    /^\/\*\*\n \* Run one turn of a durable chat session[\s\S]*?^export type ChatRunJobData = z\.infer<typeof chatRunJobSchema>;\n\n/,
  );
  edit(
    "packages/queue/src/jobs.ts",
    /^\/\*\*\n \* The deterministic BullMQ job id `enqueueChatRun`[\s\S]*?^export const chatRunJobId = \(data: ChatRunJobData\) =>\n {2}`chat-run-\$\{data\.sessionId\}-\$\{data\.userMessageSeq\}-g\$\{data\.runGeneration\}`;\n\n/,
  );
  edit(
    "packages/queue/src/jobs.ts",
    /^\/\*\*\n \* Release chat sessions that are stuck[\s\S]*?^export type ReapStaleChatRunsJobData = z\.infer<typeof reapStaleChatRunsJobSchema>;\n\n/,
  );
  edit("packages/queue/src/jobs.ts", /^ {2}chatRun: "chat-run",\n/);
  edit("packages/queue/src/jobs.ts", /^ {2}reapStaleChatRuns: "reap-stale-chat-runs",\n/);
  edit(
    "packages/queue/src/jobs.ts",
    /^\/\*\* Stable BullMQ Job Scheduler ID for the stale-chat-run sweep\. \*\/\nexport const REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID = "reap-stale-chat-runs";\n\n\/\*\*\n \* Every 5 minutes\.[\s\S]*?^export const REAP_STALE_CHAT_RUNS_CRON_PATTERN = "\*\/5 \* \* \* \*";\n\n/,
  );
  edit(
    "packages/queue/src/index.ts",
    /^import \{ type ChatRunJobData, chatRunJobId, QUEUE_NAMES \} from "\.\/jobs\.js";\n/,
    'import { QUEUE_NAMES } from "./jobs.js";\n',
  );
  for (const line of [
    /^ {2}type ChatRunJobData,\n/,
    /^ {2}chatRunJobId,\n/,
    /^ {2}chatRunJobSchema,\n/,
    /^ {2}REAP_STALE_CHAT_RUNS_CRON_PATTERN,\n/,
    /^ {2}REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID,\n/,
    /^ {2}type ReapStaleChatRunsJobData,\n/,
    /^ {2}reapStaleChatRunsJobSchema,\n/,
  ])
    edit("packages/queue/src/index.ts", line);
  edit(
    "packages/queue/src/index.ts",
    /^\/\*\*\n \* Runs one turn of a durable chat session through the agent loop\.[\s\S]*?^export const chatRunQueue = new Queue\(QUEUE_NAMES\.chatRun, \{\n {2}connection: redisConnection,\n {2}defaultJobOptions: \{ \.\.\.defaultJobOptions, attempts: 2 \},\n\}\);\n\n/,
  );
  edit(
    "packages/queue/src/index.ts",
    /^\/\*\*\n \* Sweeps chat sessions wedged[\s\S]*?^export const reapStaleChatRunsQueue = new Queue\(QUEUE_NAMES\.reapStaleChatRuns, \{\n {2}connection: redisConnection,\n {2}defaultJobOptions: \{\n {4}\.\.\.defaultJobOptions,\n {4}attempts: 1,\n {2}\},\n\}\);\n\n/,
  );
  edit(
    "packages/queue/src/index.ts",
    /^\/\*\*\n \* Enqueue a chat turn[\s\S]*?^export const enqueueChatRun = \(data: ChatRunJobData\) =>\n {2}chatRunQueue\.add\("chat-run", data, \{ jobId: chatRunJobId\(data\) \}\);\n\n/,
  );
  edit(
    "packages/queue/src/index.ts",
    /^\/\*\*\n \* Withdraw a queued chat turn\.[\s\S]*?^export const cancelChatRun = async \(jobId: string\): Promise<boolean> => \{\n[\s\S]*?^\};\n/,
  );

  // ---- Worker runtime: imports, consumers, schedulers, and its tests. ----
  edit("apps/worker/src/runtime.ts", /^import \{ env \} from "@starter\/env\/shared";\n/);
  for (const line of [
    /^ {2}ChatRunJobData,\n/,
    /^ {2}ReapStaleChatRunsJobData,\n/,
    /^ {2}REAP_STALE_CHAT_RUNS_CRON_PATTERN,\n/,
    /^ {2}REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID,\n/,
    /^ {2}reapStaleChatRunsQueue,\n/,
    /^import \{ handleChatRunJob \} from "\.\/handlers\/chat-run\.js";\n/,
    /^import \{ handleReapStaleChatRunsJob \} from "\.\/handlers\/reap-stale-chat-runs\.js";\n/,
    /^import \{ closeResultStoreConnection \} from "\.\/lib\/result-store\.js";\n/,
    /^ {6}closeResultStoreConnection\(\);\n/,
  ])
    edit("apps/worker/src/runtime.ts", line);
  edit(
    "apps/worker/src/runtime.ts",
    /^ {4}\/\/ Durable chat — one job per user turn[\s\S]*?^ {6}void reportJobFailure\("chat-run", job, err\);\n {4}\}\);\n\n/,
  );
  edit(
    "apps/worker/src/runtime.ts",
    /^ {4}\/\/ Stale-chat-run sweep — releases sessions stuck[\s\S]*?^ {6}void reportJobFailure\("reap-stale-chat-runs", job, err\);\n {4}\}\);\n\n/,
  );
  edit(
    "apps/worker/src/runtime.ts",
    /^ {4}\/\/ Chat's stale-run sweep is registered unconditionally[\s\S]*?^ {4}\} catch \(err\) \{\n {6}console\.error\("\[reap-stale-chat-runs\] Failed to register job scheduler:", err\);\n {6}throw err;\n {4}\}\n\n/,
  );
  edit(
    "apps/worker/src/runtime.test.ts",
    /^vi\.mock\("@starter\/env\/shared", \(\) => \(\{\n {2}env: \{\n {4}CHAT_RUN_CONCURRENCY: 4,\n {2}\},\n\}\)\);\n/,
  );
  edit(
    "apps/worker/src/runtime.test.ts",
    /^ {4}reapStaleChatRunsQueue: \{ upsertJobScheduler: state\.scheduler \},\n/,
  );
  edit(
    "apps/worker/src/runtime.test.ts",
    /^vi\.mock\("\.\/lib\/result-store\.js", \(\) => \(\{\n {2}createRedisResultStore: vi\.fn\(\),\n {2}closeResultStoreConnection: \(\) => state\.events\.push\("result-store-close"\),\n\}\)\);\n/,
  );
  edit(
    "apps/worker/src/runtime.test.ts",
    /^vi\.mock\("\.\/handlers\/chat-run\.js", \(\) => \(\{ handleChatRunJob: vi\.fn\(\) \}\)\);\n/,
  );
  edit(
    "apps/worker/src/runtime.test.ts",
    /^vi\.mock\("\.\/handlers\/reap-stale-chat-runs\.js", \(\) => \(\{ handleReapStaleChatRunsJob: vi\.fn\(\) \}\)\);\n/,
  );
  edit("apps/worker/src/runtime.test.ts", /^ {6}jobs\.REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID,\n/);

  // ---- Hono server: routes, mounts, and the stream limiter. ----
  edit("apps/server/src/index.ts", /^import \{ mountChatRoutes \} from "\.\/chat-routes\.js";\n/);
  edit("apps/server/src/index.ts", /^ {2}chatStreamLimiter,\n/);
  edit("apps/server/src/index.ts", /^app\.use\("\/api\/chat\/\*", sessionMiddleware\);\n/);
  edit(
    "apps/server/src/index.ts",
    /^\/\/ Durable chat SSE stream\.[\s\S]*?^mountChatRoutes\(app\);\n\n/,
  );
  edit("apps/server/src/rate-limit.ts", /^ {2}chatRateFamily,\n/);
  edit(
    "apps/server/src/rate-limit.ts",
    /^const chatStreamBudget = chatRateFamily\(\{ points: 60, windowSeconds: 60 \}\);\n/,
  );
  edit(
    "apps/server/src/rate-limit.ts",
    /^\/\*\*\n \* Chat stream limiter — \/api\/chat\/\*\.[\s\S]*?\/\/ send costs real model spend where a stream costs a listener\.\n\n/,
  );
  edit(
    "apps/server/src/rate-limit.ts",
    /\/sw, so one chatty surface burned/,
    "/sw, so one busy surface burned",
  );

  // ---- Rate-limit family collapse: five budgets become four. ----
  edit(
    "packages/api/src/lib/rate-limit-families.ts",
    /the five-family collapse/,
    "the four-family collapse",
  );
  edit(
    "packages/api/src/lib/rate-limit-families.ts",
    /five named budgets, two knobs each: AUTH, RPC, UPLOAD,\n\/\/ EMAIL, CHAT\./,
    "four named budgets, two knobs each: AUTH, RPC, UPLOAD,\n// EMAIL.",
  );
  edit(
    "packages/api/src/lib/rate-limit-families.ts",
    /without ever hitting a chat budget/,
    "without ever hitting a family budget",
  );
  edit(
    "packages/api/src/lib/rate-limit-families.ts",
    /\n\n\/\*\*\n \* CHAT family[\s\S]*?^export const chatRateFamily = lazyFamily\(\{ points: 20, windowSeconds: 60 \}, \(\) => \(\{\n {2}points: env\.RATE_LIMIT_CHAT_POINTS,\n {2}windowSeconds: env\.RATE_LIMIT_CHAT_WINDOW_SECONDS,\n\}\)\);\n/,
  );
  for (const line of [
    /^ {4}RATE_LIMIT_CHAT_POINTS: 20,\n/,
    /^ {4}RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,\n/,
  ])
    edit("packages/api/src/lib/rate-limit-families.test.ts", line);
  edit("apps/server/src/rate-limit.test.ts", /^ {2}RATE_LIMIT_CHAT_POINTS: 20,\n/);
  edit("apps/server/src/rate-limit.test.ts", /^ {2}RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,\n/);
  edit("apps/server/src/signin-failure-limit.test.ts", /^ {4}RATE_LIMIT_CHAT_POINTS: 20,\n/);
  edit(
    "apps/server/src/signin-failure-limit.test.ts",
    /^ {4}RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,\n/,
  );
  edit("apps/server/src/rate-limit.test.ts", /^ {6}RATE_LIMIT_CHAT_POINTS: 20,\n/);
  edit("apps/server/src/rate-limit.test.ts", /^ {6}RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,\n/);
  edit(
    "apps/server/src/rate-limit.test.ts",
    /^ {4}expect\(l\.chatStreamLimiter\.points\)\.toBe\(60\);\n/,
  );
  edit(
    "apps/server/src/rate-limit.test.ts",
    /One chatty surface exhausted the entire API budget/,
    "One busy surface exhausted the entire API budget",
  );

  // ---- Idiom comments that pointed at the chat gate. ----
  edit(
    "packages/api/src/routers/push.ts",
    /Same shape as `assertChatEnabled\(\)` \(lib\/chat-enabled\.ts\);/,
    "Same shape as the asset endpoints' unconfigured 503;",
  );
  edit(
    "packages/api/src/lib/web-push.ts",
    /— the same idiom `chatEnabled\(\)` uses, so callers can refuse at/,
    "— so callers can refuse at",
  );

  // ---- Admin queue inspection router. ----
  edit("packages/api/src/routers/queue.ts", /^ {2}chatRunQueue,\n/);
  edit("packages/api/src/routers/queue.ts", /^ {2}reapStaleChatRunsQueue,\n/);
  edit("packages/api/src/routers/queue.ts", /^ {2}\[QUEUE_NAMES\.chatRun\]: chatRunQueue,\n/);
  edit(
    "packages/api/src/routers/queue.ts",
    /^ {2}\[QUEUE_NAMES\.reapStaleChatRuns\]: reapStaleChatRunsQueue,\n/,
  );
  edit("packages/api/src/routers/queue.ts", /^ {2}QUEUE_NAMES\.chatRun,\n/);
  edit("packages/api/src/routers/queue.ts", /^ {2}QUEUE_NAMES\.reapStaleChatRuns,\n/);
  edit("packages/api/src/routers/queue.test.ts", /^const reapGetJob = vi\.fn\(\);\n/);
  edit("packages/api/src/routers/queue.test.ts", /^ {4}chatRunQueue: fakeQueue,\n/);
  edit(
    "packages/api/src/routers/queue.test.ts",
    /^ {4}reapStaleChatRunsQueue: \{ \.\.\.fakeQueue, getJob: reapGetJob \},\n/,
  );
  edit("packages/api/src/routers/queue.test.ts", /^ {6}chatRun: "chat-run",\n/);
  edit(
    "packages/api/src/routers/queue.test.ts",
    /^ {6}reapStaleChatRuns: "reap-stale-chat-runs",\n/,
  );
  edit(
    "packages/api/src/routers/queue.test.ts",
    /^ {2}it\("includes reapStaleChatRuns in the admin queue map", async \(\) => \{[\s\S]*?^ {4}expect\(reapGetJob\)\.toHaveBeenCalledWith\("job-1"\);\n {2}\}\);\n\n/,
  );

  // ---- Cursor-pagination prose, boundary contracts, barrel tests. ----
  edit(
    "packages/api/src/lib/pagination.ts",
    /the active cursor — a chat\n \* session, a post, an asset/,
    "the active cursor — a feed\n * row, a post, an asset",
  );
  edit(
    "packages/api/src/routers/client-boundaries.contract.test.ts",
    /^import type \{ ChatMessageRow \} from "\.\.\/lib\/chat";\n/,
  );
  edit(
    "packages/api/src/routers/client-boundaries.contract.test.ts",
    /^import type \{ chatRouter \} from "\.\/chat";\n/,
  );
  edit(
    "packages/api/src/routers/client-boundaries.contract.test.ts",
    /^type ChatClient[\s\S]*?^>;\n\n/,
  );
  edit("packages/api/src/routers/index.test.ts", /^ {2}RATE_LIMIT_CHAT_POINTS: 20,\n/);
  edit("packages/api/src/routers/index.test.ts", /^ {2}RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,\n/);
  edit(
    "packages/api/src/routers/index.test.ts",
    /^\/\/ `@starter\/env\/shared` VALIDATES[\s\S]*?^\}\)\);\n/,
    [
      "// `@starter/env/shared` VALIDATES process.env at module load and throws when it",
      "// is empty — which is exactly CI, so importing the full router graph pulls it",
      "// in. Same module-load boundary rule as the queue mock below: see",
      "// patterns/testing.md.",
      'vi.mock("@starter/env/shared", () => ({',
      "  env: {},",
      "}));",
      "",
    ].join("\n"),
  );
  edit("packages/api/src/routers/index.test.ts", /^ {4}chatRunQueue: fakeQueue,\n/);
  edit("packages/api/src/routers/index.test.ts", /^ {4}reapStaleChatRunsQueue: fakeQueue,\n/);
  edit(
    "packages/api/src/routers/index.test.ts",
    /^ {4}\/\/ The chat spend limiter \(packages\/api\/src\/lib\/chat-rate-limit\.ts\) builds a\n {4}\/\/ Redis-backed limiter over this connection at module load\.\n {4}redisConnection: \{\},\n/,
    "    redisConnection: {},\n",
  );
  edit(
    "packages/api/package.json",
    /^ {4}"\.\/lib\/chat": \{\n {6}"default": "\.\/src\/lib\/chat\.ts"\n {4}\},\n/,
  );

  // ---- Prisma + env schema: chat tables, CHAT_* knobs, family docs. ----
  edit("packages/db/prisma/schema/auth.prisma", /^ {2}ChatSessions +ChatSession\[\]\n/);
  edit(
    "packages/env/src/vars/server.ts",
    /\/\/ ---- Rate limiting: five named budgets, two knobs each\./,
    "// ---- Rate limiting: four named budgets, two knobs each.",
  );
  edit(
    "packages/env/src/vars/server.ts",
    /^ {2}\/\/ CHAT family — the durable chat surface[\s\S]*?^ {2}RATE_LIMIT_CHAT_WINDOW_SECONDS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(60\),\n/,
  );
  edit(
    "packages/env/src/vars/shared.ts",
    /^ {2}\/\/ ---- Durable agentic chat \(optional\)\.[\s\S]*?^ {2}RESULT_STORE_TTL_SECONDS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(21600\),\n/,
  );
  edit(
    "packages/env/src/server.test.ts",
    /^ {4}expect\(mod\.env\.RATE_LIMIT_CHAT_POINTS\)\.toBe\(20\);\n/,
  );
  edit(
    "packages/env/src/server.test.ts",
    /^ {4}expect\(mod\.env\.RATE_LIMIT_CHAT_WINDOW_SECONDS\)\.toBe\(60\);\n/,
  );
  edit(
    "packages/env/src/server.test.ts",
    /importServerEnv\(\{ RATE_LIMIT_CHAT_POINTS: "0" \}\)/,
    'importServerEnv({ RATE_LIMIT_AUTH_POINTS: "0" })',
  );

  // ---- Env manifest: groups, entries, and budget-count prose. ----
  edit(
    "scripts/lib/env-manifest.ts",
    /^ {2}\{\n {4}id: "chat",\n {4}title: "Durable agentic chat — \[shared\]",\n[\s\S]*?^ {2}\},\n/,
  );
  edit(
    "scripts/lib/env-manifest.ts",
    /Five named budgets \(AUTH, RPC, UPLOAD, EMAIL, CHAT\), two knobs/,
    "Four named budgets (AUTH, RPC, UPLOAD, EMAIL), two knobs",
  );
  edit(
    "scripts/lib/env-manifest.ts",
    /^ {2}\/\/ --- chat \(tuning\)[^\n]*\n[\s\S]*?^ {2}\},\n\n {2}\/\/ --- ratelimit \(tuning\)/,
    "  // --- ratelimit (tuning)",
  );
  edit(
    "scripts/lib/env-manifest.ts",
    /^ {2}\/\/ Five named budgets, two knobs per family\./,
    "  // Four named budgets, two knobs per family.",
  );
  edit(
    "scripts/lib/env-manifest.ts",
    /^ {2}\{\n {4}key: "RATE_LIMIT_CHAT_POINTS",\n[\s\S]*?key: "RATE_LIMIT_CHAT_WINDOW_SECONDS",\n[\s\S]*?^ {2}\},\n/,
  );

  // ---- Turbo env passthrough, Dockerfile COPY lists, manifests. ----
  edit("turbo.json", /^ {8}"CHAT_\*",\n/);
  edit("turbo.json", /^ {8}"RESULT_STORE_\*",\n/);
  edit(
    "Dockerfile",
    /^COPY packages\/agent-runtime\/package\.json packages\/agent-runtime\/\n/,
    "",
    2,
  );
  edit(
    "Dockerfile.worker",
    /^COPY packages\/agent-runtime\/package\.json packages\/agent-runtime\/\n/,
    "",
    2,
  );
  edit("apps/worker/package.json", /^ {4}"@starter\/agent-runtime": "workspace:\*",\n/);
  // zod reached the worker only through the deleted chat handlers.
  edit(
    "apps/worker/package.json",
    /\n {4}"sharp": "catalog:",\n {4}"zod": "catalog:"\n/,
    '\n    "sharp": "catalog:"\n',
  );
  edit("apps/web/package.json", /^ {4}"react-markdown": "catalog:",\n/);
  edit(
    "apps/web/src/components/pull-to-refresh.tsx",
    /e\.g\. chat, whose transcript\n \* owns its own vertical gestures/,
    "e.g. an inner scroller that\n * owns its own vertical gestures",
  );
  edit(
    "pnpm-workspace.yaml",
    /^ {2}# Its postinstall is `node scripts\/check-types\.js \|\| true`[\s\S]*?^ {2}'@openrouter\/sdk': false\n/,
  );
  for (const entry of [
    /^ {2}"@tanstack\/ai": 0\.63\.0\n/,
    /^ {2}"@tanstack\/ai-openai": 0\.25\.1\n/,
    /^ {2}"@tanstack\/ai-openrouter": 0\.20\.1\n/,
    /^ {2}react-markdown: \^10\.1\.0\n/,
    /^ {2}# Keep the SDK version supported by @tanstack\/ai-openrouter; SDK 1's HTTPClient\n {2}# is incompatible with the adapter's SDK 0\.13\.20\. Direct dep so the runtime\n {2}# can inject Anthropic prompt-cache\n {2}# breakpoints[^\n]*\n {2}"@openrouter\/sdk": 0\.13\.20\n/,
  ])
    edit("pnpm-workspace.yaml", entry);
  edit(
    "scripts/access-matrix-pre-notes-baseline.json",
    /^ {2}"chat\.[^"]+": "authenticated",\n/,
    "",
    9,
  );
  edit(
    "scripts/check-queue-wiring.ts",
    / \* Gaps as of 2026-09-02\. `reapStaleChatRuns` was unwired then and has since\n \* been added to queuesByName \+ queueNameSchema — keep this empty\. Shrink only\./,
    " * Gaps as of 2026-09-02. Keep this empty. Shrink only.",
  );
  edit(
    "scripts/dev-tunnel.sh",
    /and NO Server-Sent Events — chat streaming will not\n# work through the URL\. The URL changes on every restart\./,
    "and NO Server-Sent Events. The URL changes\n# on every restart.",
  );
  edit(
    "scripts/dev-tunnel.sh",
    /\(chat streaming will not work through this URL\)/,
    "(Server-Sent Events will not work through this URL)",
  );

  // ---- Web app: namespaces, nav model, nav components, locales. ----
  edit("apps/web/src/i18n/config.ts", /^ {2}"chat",\n/);
  edit("apps/web/src/lib/nav-items.ts", /, MessageSquare/);
  edit("apps/web/src/lib/nav-items.ts", /^ {2}\| "\/chat"\n/);
  edit("apps/web/src/lib/nav-items.ts", /^ {2}\| "\/\$lang\/chat"\n/);
  edit("apps/web/src/lib/nav-items.ts", / \| "chat"/);
  edit(
    "apps/web/src/lib/nav-items.ts",
    /^ {2}\/\*\*\n {3}\* Server-reported chat enablement[\s\S]*?^ {2}chatEnabled\?: boolean;\n/,
  );
  edit(
    "apps/web/src/lib/nav-items.ts",
    /^ {2}\{\n {4}\/\/ Same placements and audience as `dashboard`[\s\S]*?^ {2}\},\n/,
  );
  edit(
    "apps/web/src/lib/nav-items.ts",
    /Pick<VisibleNavInput, "isAuthenticated" \| "role" \| "chatEnabled">/,
    'Pick<VisibleNavInput, "isAuthenticated" | "role">',
  );
  edit(
    "apps/web/src/lib/nav-items.ts",
    /^ {2}\/\/ A deployment without `CHAT_ENABLED` \+ `OPENROUTER_API_KEY` has no\n {2}\/\/ conversation to offer, so it should not advertise one\.\n/,
  );
  edit(
    "apps/web/src/lib/nav-items.ts",
    /^ {2}if \(item\.id === "chat" && input\.chatEnabled === false\) return false;\n/,
  );
  edit(
    "apps/web/src/lib/nav-items.test.ts",
    /\["\/", "\/dashboard", "\/projects", "\/chat", "\/settings"\]/,
    '["/", "/dashboard", "/projects", "/settings"]',
  );
  edit(
    "apps/web/src/lib/nav-items.test.ts",
    /\["\/", "\/dashboard", "\/projects", "\/chat", "\/settings", "\/admin"\]/,
    '["/", "/dashboard", "/projects", "/settings", "/admin"]',
  );
  edit(
    "apps/web/src/lib/nav-items.test.ts",
    /^ {2}\/\/ Regression guard\. Every authenticated app route belongs[\s\S]*?^ {2}\}\);\n\n/,
  );
  edit(
    "apps/web/src/lib/nav-items.test.ts",
    /^ {2}\/\/ Unlike chat it has no server-side enablement flag, so it is visible to every\n {2}\/\/ signed-in visitor and to no anonymous one\.\n/,
    "  // It is visible to every signed-in visitor and to no anonymous one.\n",
  );
  edit(
    "apps/web/src/lib/nav-items.test.ts",
    /^ {4}expect\(toLangRoute\("\/chat"\)\)\.toBe\("\/\$lang\/chat"\);\n/,
  );
  edit(
    "apps/web/src/lib/nav-items.test.ts",
    /^ {2}\/\/ A deployment without `CHAT_ENABLED`[\s\S]*?^ {2}\}\);\n(?=^\}\);)/,
  );
  edit(
    "apps/web/src/components/bottom-nav.tsx",
    /^import \{ useChatEnabled \} from "@\/hooks\/use-chat-enabled";\n/,
  );
  edit(
    "apps/web/src/components/bottom-nav.tsx",
    /^ {2}const chatEnabled = useChatEnabled\(authSession\.state\.status === "authenticated"\);\n/,
  );
  edit("apps/web/src/components/bottom-nav.tsx", /^ {4}chatEnabled,\n/);
  edit(
    "apps/web/src/components/main-nav.tsx",
    /^import \{ useChatEnabled \} from "@\/hooks\/use-chat-enabled";\n/,
  );
  edit(
    "apps/web/src/components/main-nav.tsx",
    /^ {2}\/\/ Above the pending\/error early return — Rules of Hooks\.\n {2}const chatEnabled = useChatEnabled\(authSession\.state\.status === "authenticated"\);\n/,
  );
  edit("apps/web/src/components/main-nav.tsx", /^ {4}chatEnabled,\n/);
  edit(
    "apps/web/src/components/user-menu-content.tsx",
    /^import \{ useChatEnabled \} from "@\/hooks\/use-chat-enabled";\n/,
  );
  edit(
    "apps/web/src/components/user-menu-content.tsx",
    /^ {2}\/\/ Above the defensive early return below — Rules of Hooks\.\n {2}const chatEnabled = useChatEnabled\(authSession\.state\.status === "authenticated"\);\n/,
  );
  edit("apps/web/src/components/user-menu-content.tsx", /^ {4}chatEnabled,\n/);
  edit("packages/locales/src/en-US/nav.json", /^ {4}"chat": "Chat",\n/);
  edit("packages/locales/src/es-MX/nav.json", /^ {4}"chat": "Chat",\n/);
  edit(
    "apps/web/src/routes/$lang/_app/_auth/projects.tsx",
    /the way a chat session/,
    "the way a feed row",
  );
  // Generated, never hand-edited in the working tree: the plan strips its chat
  // entries so checks stay green on the post-removal tree; the apply message
  // tells the owner to regenerate it with `pnpm -F web build`.
  edit(
    "apps/web/src/routeTree.gen.ts",
    /^import \{ Route as LangAppAuthChatRouteImport \} from '\.\/routes\/\$lang\/_app\/_auth\/chat'\n/,
  );
  edit(
    "apps/web/src/routeTree.gen.ts",
    /^const LangAppAuthChatRoute = LangAppAuthChatRouteImport\.update\(\{\n {2}id: '\/chat',\n {2}path: '\/chat',\n {2}getParentRoute: \(\) => LangAppAuthRoute,\n\} as any\)\n/,
  );
  edit(
    "apps/web/src/routeTree.gen.ts",
    /^ {2}'\/\$lang\/chat': typeof LangAppAuthChatRoute\n/,
    "",
    2,
  );
  edit(
    "apps/web/src/routeTree.gen.ts",
    /^ {2}'\/\$lang\/_app\/_auth\/chat': typeof LangAppAuthChatRoute\n/,
  );
  edit("apps/web/src/routeTree.gen.ts", /^ {4}\| '\/\$lang\/chat'\n/, "", 2);
  edit("apps/web/src/routeTree.gen.ts", /^ {4}\| '\/\$lang\/_app\/_auth\/chat'\n/);
  edit(
    "apps/web/src/routeTree.gen.ts",
    /^ {4}'\/\$lang\/_app\/_auth\/chat': \{\n {6}id: '\/\$lang\/_app\/_auth\/chat'\n {6}path: '\/chat'\n {6}fullPath: '\/\$lang\/chat'\n {6}preLoaderRoute: typeof LangAppAuthChatRouteImport\n {6}parentRoute: typeof LangAppAuthRoute\n {4}\}\n/,
  );
  edit("apps/web/src/routeTree.gen.ts", /^ {2}LangAppAuthChatRoute: typeof LangAppAuthChatRoute\n/);
  edit("apps/web/src/routeTree.gen.ts", /^ {2}LangAppAuthChatRoute: LangAppAuthChatRoute,\n/);

  // ---- Root docs: sitemap, AGENTS.md, README, infra notes. ----
  edit("sitemap.md", /^\| `\/\{lang\}\/chat`[^\n]*\n/);
  edit(
    "sitemap.md",
    /Dashboard, Projects, Chat, and Settings/,
    "Dashboard, Projects, and Settings",
    2,
  );
  edit("sitemap.md", /^- \*\*Chat\*\* hides itself when the server reports chat disabled[^\n]*\n/);
  // Separator-agnostic: a combined plan that also removes native/cli strips
  // the preceding list items, leaving "removable: S3 assets" without a comma.
  edit("AGENTS.md", / S3 assets, chat\./, " S3 assets.");
  edit("AGENTS.md", /`admin`, `chat`, `consent`,/, "`admin`, `consent`,");
  edit(
    "README.md",
    /^- \*\*Agentic chat\*\* — a durable, resumable streaming chat surface with its own rate budgets \(opt-in via `CHAT_ENABLED` \+ an LLM key\)\n/,
  );
  edit(
    "README.md",
    /and the admin seed trigger; add-in recipes for agentic chat \(ships off\), an admin MCP server/,
    "the admin seed trigger, and agentic chat; add-in recipes for an admin MCP server",
  );
  edit("README.md", /, `chat\.prisma`/, "");
  edit(
    "infra-notes.md",
    /Five named budgets \(`AUTH`, `RPC`, `UPLOAD`, `EMAIL`, `CHAT`;/,
    "Four named budgets (`AUTH`, `RPC`, `UPLOAD`, `EMAIL`;",
  );
  edit("infra-notes.md", /^- \*\*Chat\*\* \(`chat\.prisma`\)[^\n]*\n/);
  edit("infra-notes.md", /\(chat, translations\)/, "(translations)");

  // ---- Pattern docs: index rows, citation rewrites, chat-conditioned prose. ----
  edit(
    "patterns/launch-readiness.md",
    /dormant AI chat and upload infrastructure/,
    "dormant upload infrastructure",
  );
  edit(
    "patterns/launch-readiness.md",
    /^When enabling chat, retain[^\n]+Follow \[add-ins\/chat\]\(\.\/add-ins\/chat\.md\)/,
    "If adding an AI conversation feature, disclose that it is AI and can make mistakes before the first message and throughout the conversation. Review providers, conversation retention, tool-result storage, and every tool's data access and transfer. Put the actual behavior in the privacy notice; do not send sensitive data to a vendor without approval. The shipped chat feature has been removed; see [chat removal](./removable/chat.md)",
  );
  edit(
    "patterns/README.md",
    /^\| Turn ON durable agentic chat[^\n]*\n/,
    "| Remove agentic chat — code, queue, schema tables, and its rate family (it ships disabled; remove it when your app will never use it) | [removable/chat.md](./removable/chat.md) |\n",
  );
  edit("patterns/README.md", /^\| Build a tool-calling LLM agent[^\n]*\n/);
  edit(
    "patterns/durable-streaming.md",
    /The template's first consumer is chat \(`apps\/server\/src\/chat-routes\.ts`, `apps\/server\/src\/chat-subscriber\.ts`, `apps\/worker\/src\/handlers\/chat-run\.ts`\), but nothing/,
    "The template's first consumer was its shipped chat module (since removed via [removable/chat.md](./removable/chat.md)), but nothing",
  );
  edit(
    "patterns/durable-streaming.md",
    /^- \[add-ins\/chat\.md\]\(\.\/add-ins\/chat\.md\) — the chat feature that consumes this, and how to enable it\n/,
    "- [removable/chat.md](./removable/chat.md) — how the chat feature that consumed this was removed\n",
  );
  edit(
    "patterns/durable-streaming.md",
    /^- \[agent-runtime\]\(\.\/agent-runtime\.md\) — what generates the events in the chat case\n/,
  );
  edit(
    "patterns/add-ins/mcp-server.md",
    /\[agent-runtime § Untrusted content and prompt injection\]\(\.\.\/agent-runtime\.md#untrusted-content-and-prompt-injection\)/,
    "fence it as untrusted content (prompt-injection hygiene)",
  );
  edit(
    "patterns/add-ins/mcp-server.md",
    /^- \[agent-runtime\.md\]\(\.\.\/agent-runtime\.md\) — if your tools call a model, not just your procedures\.\n/,
  );
  edit(
    "patterns/add-ins/cms.md",
    /the `analyze-asset` or `chat-run` queues\./,
    "the `analyze-asset` queue.",
  );
  edit(
    "patterns/add-ins/cms.md",
    /`react-markdown` already ships \(chat transcripts\)\. Reuse it; do not add a second markdown library\./,
    "Add `react-markdown` to the pnpm catalog when you build this; do not add a second markdown library.",
  );
  edit(
    "patterns/add-ins/cms.md",
    /Untrusted markdown and fetched pages go through `wrapUntrustedContent` \(\[agent-runtime\.md\]\(\.\.\/agent-runtime\.md\)\)\./,
    "Untrusted markdown and fetched pages must be fenced as untrusted content before they reach a model.",
  );
  edit(
    "patterns/ssr-for-articles.md",
    /`react-markdown` ships \(the chat transcript uses it in `apps\/web\/src\/components\/chat\/message-parts\.tsx`\) and its default configuration is the safe one:/,
    "`react-markdown` (add it to the pnpm catalog when you build this) defaults to the safe configuration:",
  );
  edit(
    "patterns/mutations.md",
    /Reuse the chat shape from \[durable-streaming\]\(\.\/durable-streaming\.md\)/,
    "Reuse the SSE shape from [durable-streaming](./durable-streaming.md)",
  );
  edit("patterns/i18n.md", /`admin`, `chat`, `consent`,/, "`admin`, `consent`,");
  edit(
    "patterns/environment-variables.md",
    /`SMTP_\*`, `CHAT_\*`, translation keys/,
    "`SMTP_*`, translation keys",
  );
  edit(
    "patterns/performance-and-bundling.md",
    /The chat route's markdown renderer \(`react-markdown`, via `apps\/web\/src\/components\/chat\/message-parts\.tsx`\) and the 2FA QR encoder are/,
    "The 2FA QR encoder is",
  );
  edit(
    "patterns/performance-and-bundling.md",
    /e\.g\. the chat route's markdown renderer, a locale chunk/,
    "e.g. a route-only markdown renderer, a locale chunk",
  );
  edit(
    "patterns/auth-and-routing.md",
    /^ {8}│ {3}├── chat\.tsx +# \/\$lang\/chat — durable agentic chat \(removable\)\n/,
  );
  edit(
    "patterns/schema-guidelines.md",
    /^- `chat\.prisma` — chat sessions and messages \(removable\)\n/,
  );
  edit("patterns/schema-changes-recipe.md", /, `chat\.prisma` for chat models\)/, ")");
  edit(
    "patterns/schema-changes-recipe.md",
    /`auth\.prisma`, `assets\.prisma`, `chat\.prisma`\./,
    "`auth.prisma`, `assets.prisma`.",
  );
  edit("patterns/getting-started.md", /S3 assets, agentic chat, i18n/, "S3 assets, i18n");
  edit(
    "patterns/getting-started.md",
    /- \*\*LLM spend controls\.\*\* Two features can call an LLM, and neither is on by default: `pnpm i18n:translate` \(a build-time script that fills the locale bundles\) and the agentic chat surface \(`CHAT_ENABLED`\)\. Both read `OPENROUTER_API_KEY`\. If either is enabled, the developer creates an OpenRouter account and sets a \*\*credit limit in its dashboard\*\* before launch — this template documents cost expectations and rate-limits chat per user, but ships no in-app spend cap\. Chat is the one that scales with traffic; translation is a cost you pay once per batch of new keys\./,
    "- **LLM spend controls.** `pnpm i18n:translate` can call an LLM (a build-time script that fills the locale bundles) and is off until configured: it reads `OPENROUTER_API_KEY`. If enabled, the developer creates an OpenRouter account and sets a **credit limit in its dashboard** before launch — this template documents cost expectations but ships no in-app spend cap. Translation is a cost you pay once per batch of new keys.",
  );
  edit(
    "patterns/getting-started.md",
    /cleanup sweeps, chat runs, scheduled jobs/,
    "cleanup sweeps, scheduled jobs",
  );
  edit(
    "patterns/getting-started.md",
    /agentic chat \(`CHAT_ENABLED` \+ an LLM key\) and S3 uploads \(`S3_BUCKET`\)\./,
    "S3 uploads (`S3_BUCKET`).",
  );
  edit("patterns/deployment-vps.md", /asset cleanup, chat runs, seed/, "asset cleanup, seed");
  edit(
    "patterns/data-fetching.md",
    /— a chat session, a post, an asset —/,
    "— a feed row, a post, an asset —",
  );
  edit(
    "patterns/production-hardening.md",
    /`chatStreamLimiter`, `signinRecipientLimiter`,/,
    "`signinRecipientLimiter`,",
  );
  edit(
    "patterns/dev-tunnels.md",
    /^- \*\*Chat streaming will not work\.\*\* Quick tunnels do not support Server-Sent\n {2}Events, and the chat stream is SSE \(see \[durable-streaming\.md\]\(\.\/durable-streaming\.md\)\)\.\n/,
    "- **Server-Sent Events will not work.** Quick tunnels do not support them (see [durable-streaming.md](./durable-streaming.md)).\n",
  );
  edit(
    "patterns/removable/i18n.md",
    / — the chat add-in reads `OPENROUTER_API_KEY` too — /,
    " — translation is their remaining shipped consumer — ",
  );
  edit(
    "patterns/agent-tasks/rebrand.md",
    /^packages\/agent-runtime\/package\.json +→ @<scope>\/agent-runtime\n/,
  );
  edit(
    "patterns/agent-tasks/rebrand.md",
    /^apps\/worker\/package\.json +# @starter\/agent-runtime, /,
    "apps/worker/package.json              # ",
  );
  edit(
    "patterns/agent-tasks/rebrand.md",
    /^packages\/agent-runtime\/package\.json +# @starter\/config\n/,
  );
  edit("patterns/agent-tasks/rebrand.md", /^packages\/agent-runtime\/tsconfig\.json\n/);
  edit(
    "patterns/agent-tasks/update-dependencies.md",
    /packages\/\{agent-runtime,api,/,
    "packages/{api,",
  );

  // ---- patterns/rate-limiting.md: five budgets become four. ----
  edit(
    "patterns/rate-limiting.md",
    /tuned with five named budgets — `RATE_LIMIT_\{AUTH,RPC,UPLOAD,EMAIL,CHAT\}_POINTS`/,
    "tuned with four named budgets — `RATE_LIMIT_{AUTH,RPC,UPLOAD,EMAIL}_POINTS`",
  );
  edit(
    "patterns/rate-limiting.md",
    /\(see "The five budgets" below\)/,
    '(see "The four budgets" below)',
  );
  edit("patterns/rate-limiting.md", /^## The five budgets$/, "## The four budgets");
  edit(
    "patterns/rate-limiting.md",
    /The env surface is five named budgets/,
    "The env surface is four named budgets",
  );
  edit("patterns/rate-limiting.md", /^\| `RATE_LIMIT_CHAT_\*`[^\n]*\n/);
  edit(
    "patterns/rate-limiting.md",
    /the members are wired in `apps\/server\/src\/rate-limit\.ts` and `packages\/api\/src\/lib\/chat-rate-limit\.ts`\./,
    "the members are wired in `apps/server/src/rate-limit.ts`.",
  );
  edit(
    "patterns/rate-limiting.md",
    / — plus the chat-send procedure budget \(`rl:chat-send`\), which is not mounted at all and refuses in its own `catch`\)/,
    " — plus the procedure budgets, which are not mounted at all and refuse in their own `catch`)",
  );
  edit(
    "patterns/rate-limiting.md",
    /\(`rpcLimiter`, `imageLimiter`, `assetLimiter`, `readyLimiter`, `ssrLimiter`, `chatStreamLimiter`\)/,
    "(`rpcLimiter`, `imageLimiter`, `assetLimiter`, `readyLimiter`, `ssrLimiter`)",
  );
  edit("patterns/rate-limiting.md", /^\| `\/api\/chat\/\*` \(SSE stream\)[^\n]*\n/);
  edit(
    "patterns/rate-limiting.md",
    /^\| `chat\.send` \/ `chat\.retry` \(oRPC procedures\)[^\n]*\n/,
  );
  edit("patterns/rate-limiting.md", /^\| `chat\.createSession` \(oRPC procedure\)[^\n]*\n/);
  edit(
    "patterns/rate-limiting.md",
    /`chat\.send` and `chat\.retry` are the one case where that does not work/,
    "`auth.verifyEmailTransport` is the one case where that does not work",
  );
  edit(
    "patterns/rate-limiting.md",
    /a single POST to `\/rpc\/chat\/__batch__` \(up to `ORPC_BATCH_MAX_SIZE` of them\)\. Path-mounted middleware charges that one point no matter how many sends it carried\./,
    "a single POST to `/rpc/__batch__` (up to `ORPC_BATCH_MAX_SIZE` of them). Path-mounted middleware charges that one point no matter how many procedures it carried.",
  );
  edit(
    "patterns/rate-limiting.md",
    /`\/rpc\/chat\/\*` covers `listMessages` as much as `send`; a budget sized for one is wrong for the other\./,
    "`/rpc/*` covers cheap reads as much as the SMTP preflight; a budget sized for one is wrong for the other.",
  );
  edit(
    "patterns/rate-limiting.md",
    /^So the chat-send budget lives beside the procedures it guards, in `packages\/api\/src\/lib\/chat-rate-limit\.ts`, built with `createProcedureBudget` \(`packages\/api\/src\/lib\/procedure-budget\.ts`\); `chat\.send` \/ `chat\.retry` call `consumeChatSendBudget\(userId\)` before taking their claim\. `apps\/server\/src\/rate-limit\.ts` carries a pointer comment so the mount list stays honest\. It is otherwise an ordinary member of the strict family: own `keyPrefix` \(`rl:chat-send`\), the CHAT budget's reference member, no `insuranceLimiter`\.\n\n/,
    "So that budget lives beside the procedure it guards, in `packages/api/src/routers/auth.ts`, built with `createProcedureBudget` (`packages/api/src/lib/procedure-budget.ts`); `auth.verifyEmailTransport` consumes it before opening a real SMTP connection. It is otherwise an ordinary member of the strict family: own `keyPrefix` (`rl:auth-verify-email-transport`), no `insuranceLimiter`.\n\n",
  );
  edit(
    "patterns/rate-limiting.md",
    /^`chat\.createSession` sits in the same file[\s\S]*?means per \*\*cost\*\*, not per file\.\n\n/,
  );
  edit(
    "patterns/rate-limiting.md",
    /^\*\*What one point buys, and why it is not a request\.\*\*[\s\S]*?plus their retries\.\n\n/,
  );
  edit(
    "patterns/rate-limiting.md",
    /^\*\*Keyed on the user, and the caller-supplied-key rule does not fire here\.\*\*[\s\S]*?the mail limiters do\.\n\n/,
  );
  edit(
    "patterns/rate-limiting.md",
    /^\*\*Fail-closed, with almost no availability cost\.\*\*[\s\S]*?for minutes after a burst\.\n\n/,
  );
  edit(
    "patterns/rate-limiting.md",
    /each argues the case on its own terms — spend \(`rl:chat-send`\), a real SMTP connection \(`rl:auth-verify-email-transport`\), a row whose session is unusable without Redis anyway \(`rl:chat-session`\)\./,
    "each argues the case on its own terms — a real SMTP connection (`rl:auth-verify-email-transport`), for one.",
  );
  edit(
    "patterns/rate-limiting.md",
    /consumers \(`rate-limit\.ts` \/ `chat-rate-limit\.ts`\) as a code constant/,
    "consumers (`rate-limit.ts`) as a code constant",
  );
  edit(
    "patterns/rate-limiting.md",
    /per-surface knobs were collapsed to the five named budgets on purpose/,
    "per-surface knobs were collapsed to the four named budgets on purpose",
  );
  edit(
    "patterns/rate-limiting.md",
    /^\| "You're sending messages faster than they can be answered"[^\n]*\n/,
  );
  edit(
    "patterns/rate-limiting.md",
    /^\| "You're starting conversations faster than expected"[^\n]*\n/,
  );
  edit("patterns/rate-limiting.md", /^\| Chat sends 503 while the rest of the app works[^\n]*\n/);

  // ---- patterns/removable/queue.md: chat-conditioned prose. ----
  edit(
    "patterns/removable/queue.md",
    /^- If chat remains behind a replacement\/external executor,[^\n]*\n/,
  );
  edit(
    "patterns/removable/queue.md",
    /^### Chat runs and stale-run recovery stop\n\n[\s\S]*?^`chat-run` performs the streamed assistant run[\s\S]*?before deleting the queue\.\n/,
    "### Chat runs and stale-run recovery stop\n\nThe shipped agentic chat (`chat-run` plus the `reap-stale-chat-runs` sweep) is removable separately via [chat.md](./chat.md); once it is gone there is no chat consumer left to lose here.\n",
  );
  edit(
    "patterns/removable/queue.md",
    /`packages\/api\/src\/routers\/\{seed,chat,queue\}\.ts`/,
    "`packages/api/src/routers/{seed,queue}.ts`",
  );
  edit(
    "patterns/removable/queue.md",
    /Remove the owning chat feature or supply its fully tested replacement; apply the inline seed recipe;/,
    "Apply the inline seed recipe;",
  );
  edit(
    "patterns/removable/queue.md",
    /^await reapStaleChatRunsQueue\.removeJobScheduler\(REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID\);\n/,
  );
  edit(
    "patterns/removable/queue.md",
    /the chat consumers and the scheduled maintenance jobs/,
    "the scheduled maintenance jobs",
  );
  edit(
    "patterns/removable/queue.md",
    /Once every job producer and chat-specific Redis consumer has been removed/,
    "Once every job producer has been removed",
  );
  edit(
    "patterns/removable/queue.md",
    / If a replacement chat executor retains Redis publication or chat rate limiting, keep the API dependency\./,
    "",
  );
  edit(
    "patterns/removable/queue.md",
    /in the server \(and retained chat code\) are expected\./,
    "in the server are expected.",
  );
  edit(
    "patterns/removable/queue.md",
    /are expected for server security\/readiness and any retained chat pub\/sub path\./,
    "are expected for server security/readiness.",
  );

  // ---- patterns/testing.md: swap the chat mock examples for surviving ones. ----
  edit(
    "patterns/testing.md",
    /^import type \{ serializeChatSession \} from "\.\/chat";\n/,
    'import type { RouterClient } from "@orpc/server";\nimport type { projectsRouter } from "./projects";\n',
  );
  edit(
    "patterns/testing.md",
    /^export type ChatSessionContract = Assert<\n {2}IsExact<\n {4}ReturnType<typeof serializeChatSession>,\n {4}\{\n {6}id: string;\n {6}title: string;\n {6}status: string;\n {4}\}\n {2}>\n>;\n/,
    [
      "type ProjectsClient = RouterClient<typeof projectsRouter>;",
      'type Project = Awaited<ReturnType<ProjectsClient["list"]>>["items"][number];',
      "export type ProjectsRouterListContract = Assert<",
      "  IsExact<Project, { id: string; name: string; notes: string | null; createdAt: Date }>",
      ">;",
    ].join("\n"),
  );
  edit("patterns/testing.md", /, chat \+ translation keys/, ", translation keys");
  edit(
    "patterns/testing.md",
    /The canonical worked example is `packages\/api\/src\/routers\/chat\.test\.ts`:$/,
    "The canonical worked example is `packages/api/src/routers/index.test.ts`:",
  );
  edit(
    "patterns/testing.md",
    /^\/\/ transitively \(db \/ storage \/ queue \/ the chat gate\)\. Mocking\n\/\/ @starter\/env\/server alone does not suppress it\.\nvi\.mock\("@starter\/env\/shared", \(\) => \(\{\n {2}env: \{ CHAT_ENABLED: true, OPENROUTER_API_KEY: "test-key" \},\n\}\)\);$/,
    [
      "// transitively (db / storage / queue). Mocking",
      "// @starter/env/server alone does not suppress it.",
      'vi.mock("@starter/env/shared", () => ({',
      "  env: {},",
      "}));",
    ].join("\n"),
  );
  edit(
    "patterns/testing.md",
    /^Put real values in the shared mock when a gate reads them — `lib\/chat-enabled\.ts` is `CHAT_ENABLED && OPENROUTER_API_KEY`, so an empty `env: \{\}` silently disables chat and every procedure assertion fails on a `SERVICE_UNAVAILABLE` instead of the behaviour under test\.$/,
    "Put real values in the shared mock when the code under test reads them — an empty `env: {}` fails loudly the moment an assertion depends on a flag's value.",
  );
  edit(
    "patterns/testing.md",
    /, `routers\/chat\.ts` \(the chat producer and the Redis-backed spend limiter\),/,
    ",",
  );
  edit(
    "patterns/testing.md",
    /^ {4}chatRunQueue: fakeQueue,\n {4}reapStaleChatRunsQueue: fakeQueue,\n/,
  );
  edit(
    "patterns/testing.md",
    /^ {4}\/\/ The chat spend limiter \(packages\/api\/src\/lib\/chat-rate-limit\.ts\) builds a\n {4}\/\/ Redis-backed limiter over this connection at module load\.\n {4}redisConnection: \{\},\n/,
    "    redisConnection: {},\n",
  );
  edit(
    "patterns/testing.md",
    /^A narrower test that imports one router only needs the queues that router actually uses\. `packages\/api\/src\/routers\/chat\.test\.ts` mocks `enqueueChatRun` \/ `cancelChatRun` \/ `redisConnection` and nothing else, and deliberately leaves `@starter\/queue\/jobs` — the Redis-free half of the package — unmocked so the real `chatRunJobId` derivation is under test rather than stubbed past\. Narrow your import graph and the mock block shrinks with it\.$/,
    "A narrower test that imports one router only needs the queues that router actually uses. `packages/api/src/routers/queue.test.ts` mocks the specific queues and `redisConnection` it walks, and nothing else. Narrow your import graph and the mock block shrinks with it.",
  );

  // ---- The removal doc itself (patterns/README.md links to it). ----
  files.set("patterns/removable/chat.md", Buffer.from(CHAT_REMOVAL_DOC, "utf8"));

  return deleted;
}

const CHAT_REMOVAL_DOC = `# Removable: Agentic chat

Remove the durable agentic chat feature — the \`@starter/agent-runtime\` package, the \`chat\` oRPC router, the \`/api/chat/:sessionId/stream\` SSE endpoint, the BullMQ \`chat-run\` / \`reap-stale-chat-runs\` queues, the \`/$lang/chat\` page with its components/hooks/locales, the \`chat_session\` / \`chat_message\` Prisma tables, and the CHAT rate-limit family with its \`RATE_LIMIT_CHAT_*\` / \`CHAT_*\` env knobs.

Chat ships **disabled** (\`CHAT_ENABLED\` defaults to false, and it needs \`OPENROUTER_API_KEY\` besides), so leaving it in costs nothing at runtime. Removal is worth it when your app will never offer an LLM chat surface: the agent runtime and its \`@openrouter/sdk\` / \`@tanstack/ai\` / \`react-markdown\` dependencies leave the image and the lockfile, two schema tables and their \`User\` back-relations leave the database, two queue names and a cron sweep leave the worker, and one rate-limit family and a dozen env knobs leave the tuning surface.

## What removing loses

The shipped chat UI (session rail, streaming transcript, rename/delete, retry after a failed run), the resumable SSE streaming endpoint, and the tool-calling agent loop. \`pnpm i18n:translate\` keeps working — it reads \`OPENROUTER_API_KEY\` independently and does not touch any of this. The SSE pattern itself is not lost: [durable-streaming.md](../durable-streaming.md) documents the contracts for any feature you build later.

## Removal steps

### Maintained helper (recommended)

After the owner explicitly chooses removal, preview the complete change:

\`\`\`bash
pnpm template:remove chat
\`\`\`

The preview lists every tracked deletion and shows dependent edits, including
generated agent mirrors and the pnpm lockfile. It prepares and checks these in
a temporary snapshot using the installed tools and cached packages, without
changing the source tree or Git index. Review the whole preview with the owner,
then run its printed \`--apply --confirm <hash>\` command. It can be combined
with the other modules (\`native cli chat\`).

The helper refuses overlapping staged, unstaged, and untracked work, unsafe or
symlink paths, missing recipe anchors, unknown chat consumers, and stale
confirmation hashes. Keep other writers paused during apply.

### What the plan deletes

- \`packages/agent-runtime/\` — the whole agent-loop package
- \`packages/api/src/routers/chat.ts\` (+ tests) and \`packages/api/src/lib/chat*.ts\` (\`chat.ts\`, \`chat-enabled.ts\`, \`chat-rate-limit.ts\` and tests; \`lib/procedure-budget.ts\` stays — the email-transport preflight uses it)
- \`apps/server/src/chat-routes.ts\`, \`chat-subscriber.ts\` (+ tests) and their mounts/limiter in \`apps/server/src/index.ts\` / \`rate-limit.ts\`
- \`apps/worker/src/handlers/chat-run.ts\`, \`reap-stale-chat-runs.ts\`, \`lib/chat-prompts.ts\`, \`chat-tools.ts\`, \`result-store.ts\` (+ tests) and their wiring in \`runtime.ts\`
- The \`chatRun\` / \`reapStaleChatRuns\` queue names, schemas, constructors, and cron constants in \`packages/queue/\`
- \`apps/web/src/routes/$lang/_app/_auth/chat.tsx\`, \`components/chat/\`, the \`use-chat-*\` / \`use-stick-to-bottom\` hooks, \`lib/chat-*.ts\`, and the \`chat\` i18n namespace + nav entry
- \`packages/db/prisma/schema/chat.prisma\` and the \`ChatSessions\` back-relation on \`User\`
- The CHAT rate-limit family (four budgets remain: AUTH, RPC, UPLOAD, EMAIL), the \`CHAT_*\` / \`RATE_LIMIT_CHAT_*\` env vars, the \`@openrouter/sdk\` build script entry, and the \`@tanstack/ai*\` / \`react-markdown\` / \`@openrouter/sdk\` catalog entries
- The access-matrix baseline \`chat.*\` rows, the Dockerfile \`COPY packages/agent-runtime\` lines, and the chat rows across \`sitemap.md\`, \`AGENTS.md\`, \`README.md\`, \`infra-notes.md\`, and the pattern docs

### Post-apply steps the agent MUST run

1. \`pnpm install --offline --ignore-scripts\` — prune \`@openrouter/sdk\`, the \`@tanstack/ai\` trio, and \`react-markdown\` from the lockfile.
2. \`pnpm -F web build\` — regenerate \`apps/web/src/routeTree.gen.ts\`. The removal strips its chat entries so the tree stays coherent, but the file is generated and never hand-edited; the build rewrites it authoritatively.
3. \`pnpm db:push\` — **this DROPS the \`chat_session\` and \`chat_message\` tables and their data. That is destructive and irreversible.** Prisma refuses the drop without an explicit data-loss acknowledgement; locally that acknowledgement is \`pnpm db:push:dangerous\` (your own local Postgres only). Never point it at a shared or production database. For a **deployed** app, follow [schema-changes-recipe's "Remove a deployed feature's tables" section](../schema-changes-recipe.md#remove-a-deployed-features-tables) instead: keep the tables through the code-only release, then drop them in a separate approved contract release (\`APPLY_SCHEMA=dangerous\` on the schema leader with its confirmation two-step — see [infra-notes.md](../../infra-notes.md)).
4. \`pnpm verify\` — lint, policy greps, typecheck, and tests must all pass with zero remaining chat references.

## Sanity checks

- \`rg -i 'chat|agent-runtime|openrouter' apps packages scripts\` returns only the translation provider's OpenAI \`chat.completions\` API call in \`packages/i18n-translate/\`.
- \`pnpm -F web build\` succeeds and \`apps/web/src/routeTree.gen.ts\` no longer lists a \`/$lang/chat\` route.
- \`pnpm policy:access-matrix\` and \`pnpm policy:queue-wiring\` pass (the baseline \`chat.*\` rows and the \`chatRun\` / \`reapStaleChatRuns\` queue names are gone).
- The four remaining rate-limit budgets (\`AUTH\`, \`RPC\`, \`UPLOAD\`, \`EMAIL\`) still default to their shipped numbers.
`;

export const nativeCatalog = [
  "@better-auth/expo",
  "@expo/metro-runtime",
  "@expo/vector-icons",
  "@gorhom/bottom-sheet",
  "expo",
  "expo-constants",
  "expo-font",
  "expo-haptics",
  "expo-linking",
  "expo-localization",
  "expo-network",
  "expo-router",
  "expo-secure-store",
  "expo-status-bar",
  "expo-web-browser",
  "heroui-native",
  "react-native",
  "react-native-gesture-handler",
  "react-native-keyboard-controller",
  "react-native-reanimated",
  "react-native-safe-area-context",
  "react-native-screens",
  "react-native-svg",
  "react-native-web",
  "react-native-worklets",
  "tailwind-variants",
  "uniwind",
];
