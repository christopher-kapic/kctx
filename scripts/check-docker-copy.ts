/**
 * Guards the hand-enumerated `COPY <app-or-package>/package.json` lists in the
 * two Dockerfiles against the actual set of workspace members on disk.
 *
 *   pnpm docker:check-copy   — verify without writing (CI gate; non-zero exit on drift)
 *
 * Why this exists: `Dockerfile` and `Dockerfile.worker` copy each workspace
 * member's `package.json` individually BEFORE `pnpm install --frozen-lockfile`
 * (so workspace symlinks + the lockfile's importers resolve) and BEFORE
 * `COPY . .`. Add a new `packages/*` or `apps/*` workspace member and forget to
 * add its COPY line and the install step fails inside `docker build` — a failure
 * that never shows up in `pnpm build`, tests, or typecheck. This script makes
 * that omission a fast, CI-visible error instead.
 *
 * The invariants it enforces (see AGENTS.md § Dockerfiles — keep server and
 * worker in sync):
 *
 *   1. Each `builder` stage installs the whole workspace (`pnpm install
 *      --frozen-lockfile`, no filter), so it MUST list every on-disk workspace
 *      member except the intentional exclusions below — and both Dockerfiles'
 *      builder lists must therefore be identical.
 *   2. Each `prod-deps` stage installs a filtered subset (`--filter=web...` /
 *      `--filter=worker...`), so its list must be a NON-EMPTY SUBSET of the same
 *      file's builder list — never referencing a member the builder omits or one
 *      that no longer exists on disk. Non-empty because a subset check alone is
 *      satisfied by the empty set: deleting every COPY line would otherwise read
 *      as "in sync".
 *   3. Within a stage, every COPY line must appear BEFORE that stage's
 *      `pnpm install`. This is the ordering the whole scheme depends on, so it
 *      is checked rather than assumed — a COPY that drifts below the install
 *      breaks `docker build` and passes every other check in CI.
 *
 * What it still cannot tell you: whether `prod-deps` is missing a member the
 * image needs at RUNTIME. Which members belong there is a judgment call per
 * image (see AGENTS.md), so adding that line when you add a workspace member
 * remains a manual step.
 *
 * Intentional exclusions (allowlisted, never expected in a COPY list):
 *   - apps/cli          — excluded from the Docker build context via .dockerignore
 *                         (the Rust CLI never ships in the container images).
 *   - apps/native       — the Expo app enters the builder only via `COPY . .`; it
 *                         is never installed ahead of time and never reaches a runner.
 *   - packages/db-applier — runtime closure for Dockerfile.db-applier only; the web
 *                         and worker images never install or ship it.
 *
 * The runner stages are deliberately NOT checked for workspace members: they
 * copy only the minimal set of manifests a running image needs, not the install
 * closure. They ARE checked for runtime SCRIPTS (see the bottom of this file):
 * every sibling script a shipped shell script shells out to must be COPY'd into
 * the same image — for all three Dockerfiles, Dockerfile.db-applier included.
 * Both app images' HEALTHCHECK `--start-period` is also checked against the
 * schema startup gate (SCHEMA_WAIT_TIMEOUT_SECONDS default + apply budget),
 * because Docker only exempts failed probes during the start-period window.
 *
 * Node builtins only — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check`.
 */

import { deepStrictEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Workspace members that legitimately have no pre-install COPY line.
const ALLOWLIST = new Set(["apps/cli", "apps/native", "packages/db-applier"]);

// Stages whose COPY lists we verify. The runner stages are intentionally left
// out (they copy only what a running image needs, not the install closure).
const BUILDER = "builder";
const PROD_DEPS = "prod-deps";

const DOCKERFILES = ["Dockerfile", "Dockerfile.worker"];

// Beyond the schema-wait default, the HEALTHCHECK start-period must also fund
// the apply leader's own startup: the pre-apply backup, plan re-verification,
// and DDL of `APPLY_SCHEMA=safe/dangerous` can run past a follower's full wait
// window, and the app still needs time to boot once the gate opens. 120s of
// apply budget keeps the shipped 480s start-period correct for the 300s
// default (480 > 300 + 120) with boot headroom.
const APPLY_BUDGET_SLACK = 120;

/** Discover on-disk workspace members: `apps/*` / `packages/*` with a package.json. */
function discoverMembers(): Set<string> {
  const members = new Set<string>();
  for (const group of ["apps", "packages"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = `${group}/${name}`;
      try {
        readFileSync(resolve(ROOT, group, name, "package.json"));
        members.add(id);
      } catch {
        // no package.json → not a workspace member (e.g. an assets-only dir)
      }
    }
  }
  return members;
}

/**
 * Yield Dockerfile *logical* lines: physical lines with trailing-backslash
 * continuations folded into one, reported at the line number the instruction
 * starts on. Without this, any multi-line `RUN`/`COPY` reads as several
 * unrelated fragments — see `installRe` for why that matters.
 */
function* logicalLines(text: string): Generator<{ line: string; lineNo: number }> {
  const physical = text.split("\n");
  let buffer = "";
  let startLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = (physical[i] ?? "").trim();
    // A `\` continues the instruction onto the next physical line.
    const continues = raw.endsWith("\\");
    const piece = continues ? raw.slice(0, -1).trim() : raw;

    if (buffer === "") startLine = i + 1;
    buffer = buffer === "" ? piece : `${buffer} ${piece}`;

    if (continues) continue;
    yield { line: buffer, lineNo: startLine };
    buffer = "";
  }
  // A file ending on a dangling continuation still yields what it accumulated.
  if (buffer !== "") yield { line: buffer, lineNo: startLine };
}

/**
 * Split a Dockerfile into stages keyed by their `AS <name>` label and collect
 * the `COPY <group>/<name>/package.json <group>/<name>/` members in each.
 */
function parseStages(dockerfile: string): Map<string, Set<string>> {
  const text = readFileSync(resolve(ROOT, dockerfile), "utf8");
  const stages = new Map<string, Set<string>>();
  let current: Set<string> | null = null;

  // `FROM --platform=… <image> AS <stage>`: the flags between FROM and the
  // image are optional, and `AS` is case-insensitive in Dockerfile syntax.
  const stageRe = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i;
  const copyRe =
    /^COPY\s+((?:apps|packages)\/[^/]+)\/package\.json\s+((?:apps|packages)\/[^/]+)\//i;
  // The whole point of the hand-enumerated COPY lines is that they land before
  // the install, so the lockfile's importers and workspace symlinks resolve
  // against real package.json files. A COPY that drifts below this breaks
  // `docker build` at install time and nothing else in CI would catch it.
  //
  // Matched against JOINED logical lines (see below), not physical ones. The
  // install is single-line today, but the standard BuildKit cache-mount form
  // splits it:
  //
  //     RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  //         pnpm install --frozen-lockfile
  //
  // A physical-line match would silently stop finding the install there, and
  // invariant 3 would check nothing while still reporting "in sync" — the exact
  // vacuous pass the other two invariants guard against.
  const installRe = /^RUN\s[\s\S]*pnpm\s+install/i;

  let currentStage = "";
  let installSeenAt = -1;

  for (const { line, lineNo } of logicalLines(text)) {
    const stageMatch = stageRe.exec(line);
    if (stageMatch) {
      current = new Set<string>();
      currentStage = stageMatch[1] ?? "";
      installSeenAt = -1;
      stages.set(currentStage, current);
      continue;
    }
    if (!current) continue;
    if (installRe.test(line)) {
      installSeenAt = lineNo;
      continue;
    }
    const copyMatch = copyRe.exec(line);
    if (copyMatch) {
      if (installSeenAt !== -1) {
        errors.push(
          `${dockerfile} (${currentStage}): COPY line for "${copyMatch[1]}" on line ${lineNo} ` +
            `comes AFTER \`pnpm install\` on line ${installSeenAt}. It must precede the install, ` +
            `or the install resolves against a missing package.json and \`docker build\` fails.`,
        );
      }
      // Both sides of the COPY must reference the same member; a mismatch is a
      // typo worth surfacing (e.g. a bad copy/paste of the destination path).
      if (copyMatch[1] !== copyMatch[2]) {
        errors.push(
          `${dockerfile}: COPY line mismatch — source "${copyMatch[1]}" but destination "${copyMatch[2]}".`,
        );
      }
      current.add(copyMatch[1] ?? "");
    }
  }
  return stages;
}

/** Require the actual source-to-destination mapping in the final runner stage. */
function runtimeScriptCopies(text: string): Set<string> {
  const copied = new Set<string>();
  let runner = false;
  for (const { line } of logicalLines(text)) {
    if (/^FROM\s/i.test(line)) {
      runner = /\sAS\s+runner$/i.test(line);
      continue;
    }
    if (!runner || !/^COPY\s/i.test(line)) continue;
    const body = line.replace(/^COPY\s+/i, "").replace(/^(?:--\S+\s+)*/, "");
    const parts: string[] = body.startsWith("[") ? JSON.parse(body) : body.split(/\s+/);
    const destination = parts.pop();
    if (!destination) continue;
    for (const source of parts) {
      const script = source.replace(/^\/app\//, "").replace(/^\.\//, "");
      if (!/^scripts\/.+\.(?:mjs|sh|ts)$/.test(script)) continue;
      const target = resolve(
        "/app",
        destination,
        parts.length > 1 || destination.endsWith("/") ? basename(source) : "",
      );
      const expected =
        script === "scripts/docker-entrypoint.sh"
          ? "/usr/local/bin/docker-entrypoint.sh"
          : `/app/${script}`;
      if (target === expected) copied.add(script);
    }
  }
  return copied;
}

/** Inventory shell siblings, Node root-relative helpers, and local ESM imports. */
function runtimeScriptReferences(script: string, text: string): Set<string> {
  const references = new Set<string>();
  for (const match of text.matchAll(
    /(?:\$\(dirname "\$0"\)|\$ROOT\/scripts|\/app\/scripts)\/((?:lib\/)?[A-Za-z0-9._-]+\.(?:mjs|sh|ts))/g,
  )) {
    references.add(`scripts/${match[1]}`);
  }
  for (const match of text.matchAll(
    /["'](scripts\/(?:lib\/)?[A-Za-z0-9._-]+\.(?:mjs|sh|ts))["']/g,
  )) {
    references.add(match[1]!);
  }
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.(?:mjs|sh|ts))["']/g,
  )) {
    references.add(relative(ROOT, resolve(ROOT, dirname(script), match[1]!)));
  }
  return references;
}

/**
 * HEALTHCHECK `--start-period=<N>s` in seconds, or null when the directive (or
 * the flag) is absent. Reads logical lines so the standard two-line
 * `HEALTHCHECK … \ CMD …` form parses as one instruction.
 */
function healthcheckStartPeriod(text: string): number | null {
  for (const { line } of logicalLines(text)) {
    if (!/^HEALTHCHECK\s/i.test(line)) continue;
    const seconds = line.match(/--start-period=(\d+)s/i)?.[1];
    return seconds ? Number(seconds) : null;
  }
  return null;
}

/**
 * The SCHEMA_WAIT_TIMEOUT_SECONDS default, parsed from wait-for-schema.mjs
 * source (`Number(environment.SCHEMA_WAIT_TIMEOUT_SECONDS || 300)`). Parsed
 * rather than hardcoded here so raising the real default flips this check
 * instead of silently diverging from it.
 */
function schemaWaitDefaultSeconds(text: string): number | null {
  const seconds = text.match(/SCHEMA_WAIT_TIMEOUT_SECONDS\s*\|\|\s*(\d+)/)?.[1];
  return seconds ? Number(seconds) : null;
}

/**
 * The HEALTHCHECK start-period must EXCEED the schema startup gate: the
 * SCHEMA_WAIT_TIMEOUT_SECONDS default plus APPLY_BUDGET_SLACK. Both app images
 * sit in the entrypoint's schema gate before the CMD process exists, and Docker
 * only exempts failed probes during --start-period — a start-period inside the
 * gate window marks a follower that is legitimately mid-wait as unhealthy.
 * Pure (returns error strings rather than pushing) so --self-test can drive it
 * with fixtures before `errors` exists.
 */
function healthcheckStartPeriodErrors(
  dockerfile: string,
  text: string,
  waitDefaultSeconds: number,
): string[] {
  const startPeriod = healthcheckStartPeriod(text);
  if (startPeriod === null) {
    return [
      `${dockerfile}: no \`HEALTHCHECK … --start-period=<N>s\` found — the startup budget that ` +
        `must cover the schema wait plus apply time cannot be verified.`,
    ];
  }
  const required = waitDefaultSeconds + APPLY_BUDGET_SLACK;
  if (startPeriod > required) return [];
  return [
    `${dockerfile}: HEALTHCHECK --start-period=${startPeriod}s is not greater than the schema ` +
      `startup gate: SCHEMA_WAIT_TIMEOUT_SECONDS default ${waitDefaultSeconds}s ` +
      `(scripts/wait-for-schema.mjs) + ${APPLY_BUDGET_SLACK}s apply budget = ${required}s. ` +
      `A follower legitimately waiting on the schema gate would be marked unhealthy mid-wait. ` +
      `Raise --start-period in ${DOCKERFILES.join(" and ")}, or lower the default in ` +
      `scripts/wait-for-schema.mjs.`,
  ];
}

if (process.argv.includes("--self-test")) {
  deepStrictEqual(
    [
      ...runtimeScriptCopies(`FROM base AS builder
COPY scripts/builder.mjs ./scripts/
FROM base AS runner
# COPY scripts/comment.mjs ./scripts/
RUN echo scripts/mentioned.mjs
COPY scripts/wrong.mjs /wrong/
COPY scripts/renamed.mjs ./scripts/other.mjs
COPY --chown=node:node scripts/apply-schema.mjs ./scripts/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/lib/schema-diff.mjs scripts/lib/backup-env.sh ./scripts/lib/
COPY ["scripts/json.mjs", "./scripts/"]
`),
    ].sort(),
    [
      "scripts/apply-schema.mjs",
      "scripts/docker-entrypoint.sh",
      "scripts/json.mjs",
      "scripts/lib/backup-env.sh",
      "scripts/lib/schema-diff.mjs",
    ],
  );
  deepStrictEqual(
    [
      ...runtimeScriptReferences(
        "scripts/apply-schema.mjs",
        `import { classifyDiff } from "./lib/schema-diff.mjs";
run("bash", [resolve(root, "scripts/db-applier.sh")]);
node "$ROOT/scripts/wait-for-schema.mjs"
`,
      ),
    ].sort(),
    ["scripts/db-applier.sh", "scripts/lib/schema-diff.mjs", "scripts/wait-for-schema.mjs"],
  );
  // HEALTHCHECK start-period vs schema-wait coupling. The fixture mirrors the
  // real Dockerfiles' continuation-folded directive shape.
  const healthcheckFixture = (startPeriod: number) => `FROM base AS runner
HEALTHCHECK --interval=10s --timeout=5s --start-period=${startPeriod}s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:3001').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
`;
  deepStrictEqual(
    schemaWaitDefaultSeconds(
      "const seconds = Number(environment.SCHEMA_WAIT_TIMEOUT_SECONDS || 300);",
    ),
    300,
  );
  // Passing: the shipped values — 480s start-period vs 300s default + 120s slack.
  deepStrictEqual(healthcheckStartPeriodErrors("Dockerfile", healthcheckFixture(480), 300), []);
  // Violating: start-period too small (exactly wait + slack; the check is strict).
  deepStrictEqual(healthcheckStartPeriodErrors("Dockerfile", healthcheckFixture(420), 300), [
    "Dockerfile: HEALTHCHECK --start-period=420s is not greater than the schema startup gate: " +
      "SCHEMA_WAIT_TIMEOUT_SECONDS default 300s (scripts/wait-for-schema.mjs) + 120s apply budget " +
      "= 420s. A follower legitimately waiting on the schema gate would be marked unhealthy " +
      "mid-wait. Raise --start-period in Dockerfile and Dockerfile.worker, or lower the default " +
      "in scripts/wait-for-schema.mjs.",
  ]);
  // Violating: wait default raised beyond what the shipped start-period covers
  // (parsed through schemaWaitDefaultSeconds to exercise the source regex).
  const raisedWait = schemaWaitDefaultSeconds(
    "const seconds = Number(environment.SCHEMA_WAIT_TIMEOUT_SECONDS || 400);",
  );
  deepStrictEqual(raisedWait, 400);
  deepStrictEqual(
    healthcheckStartPeriodErrors("Dockerfile.worker", healthcheckFixture(480), raisedWait ?? 0),
    [
      "Dockerfile.worker: HEALTHCHECK --start-period=480s is not greater than the schema startup " +
        "gate: SCHEMA_WAIT_TIMEOUT_SECONDS default 400s (scripts/wait-for-schema.mjs) + 120s apply " +
        "budget = 520s. A follower legitimately waiting on the schema gate would be marked unhealthy " +
        "mid-wait. Raise --start-period in Dockerfile and Dockerfile.worker, or lower the default in " +
        "scripts/wait-for-schema.mjs.",
    ],
  );
  console.log("Docker runtime COPY regression checks passed.");
  process.exit(0);
}

const errors: string[] = [];

const members = discoverMembers();
const expectedBuilder = new Set([...members].filter((m) => !ALLOWLIST.has(m)).sort());

const builderLists = new Map<string, Set<string>>();

for (const dockerfile of DOCKERFILES) {
  const stages = parseStages(dockerfile);

  const builder = stages.get(BUILDER);
  if (!builder) {
    errors.push(
      `${dockerfile}: no \`${BUILDER}\` stage found (expected a \`FROM … AS ${BUILDER}\`).`,
    );
  } else {
    builderLists.set(dockerfile, builder);
    // Invariant 1: builder must list every on-disk member minus the allowlist.
    const missing = [...expectedBuilder].filter((m) => !builder.has(m));
    const extra = [...builder].filter((m) => !members.has(m) || ALLOWLIST.has(m));
    for (const m of missing) {
      errors.push(
        `${dockerfile} (${BUILDER}): missing COPY line for "${m}". Add:\n    COPY ${m}/package.json ${m}/`,
      );
    }
    for (const m of extra) {
      const why = ALLOWLIST.has(m)
        ? "it is an intentional exclusion (allowlisted)"
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${BUILDER}): unexpected COPY line for "${m}" — ${why}.`);
    }
  }

  const prodDeps = stages.get(PROD_DEPS);
  if (!prodDeps) {
    errors.push(
      `${dockerfile}: no \`${PROD_DEPS}\` stage found (expected a \`FROM … AS ${PROD_DEPS}\`).`,
    );
  } else if (builder) {
    // Invariant 2: prod-deps must be a non-empty subset of this file's builder
    // list. Subset-checking alone passes vacuously on an empty set, so wiping
    // every COPY line would read as "in sync" — assert it kept some.
    if (prodDeps.size === 0) {
      errors.push(
        `${dockerfile} (${PROD_DEPS}): no workspace COPY lines found. This stage must copy the ` +
          `package.json of every member the image needs at runtime; an empty list passes the ` +
          `subset check vacuously but fails \`docker build\`.`,
      );
    }
    const notInBuilder = [...prodDeps].filter((m) => !builder.has(m));
    for (const m of notInBuilder) {
      const why = members.has(m)
        ? `it is absent from the ${BUILDER} stage (the two lists drifted)`
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${PROD_DEPS}): COPY line for "${m}" — ${why}.`);
    }
  }
}

// Invariant 1 (corollary): both builder lists resolve to the same expected set,
// so they must be identical. Report any divergence explicitly for clarity.
if (builderLists.size === DOCKERFILES.length) {
  const [a, b] = DOCKERFILES as [string, string];
  const setA = builderLists.get(a)!;
  const setB = builderLists.get(b)!;
  const onlyA = [...setA].filter((m) => !setB.has(m));
  const onlyB = [...setB].filter((m) => !setA.has(m));
  for (const m of onlyA) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${a} but not ${b}.`);
  }
  for (const m of onlyB) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${b} but not ${a}.`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  packageManager?: string;
};
const pnpmPin = packageJson.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)/)?.[1];
if (pnpmPin) {
  for (const dockerfile of [...DOCKERFILES, "Dockerfile.dev", "Dockerfile.db-applier"]) {
    const path = resolve(ROOT, dockerfile);
    if (!existsSync(path)) {
      if (dockerfile === "Dockerfile.db-applier") {
        errors.push(`${dockerfile} is missing (the backup/restore/schema-apply image).`);
      }
      continue;
    }
    const text = readFileSync(path, "utf8");
    const prepared = [...text.matchAll(/pnpm@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    for (const version of prepared) {
      if (version !== pnpmPin) {
        errors.push(
          `${dockerfile} pins pnpm@${version} but package.json packageManager is pnpm@${pnpmPin}.`,
        );
      }
    }
    if (dockerfile !== "Dockerfile.dev" && !/tini/.test(text)) {
      errors.push(`${dockerfile} does not install or use tini as PID 1.`);
    }
  }
}

const dockerignore = existsSync(resolve(ROOT, ".dockerignore"))
  ? readFileSync(resolve(ROOT, ".dockerignore"), "utf8")
  : "";
for (const required of ["backups", "notes"]) {
  if (
    !dockerignore
      .split("\n")
      .some((line) => line.trim() === required || line.trim() === `${required}/`)
  ) {
    errors.push(
      `.dockerignore must exclude ${required}/ so local dumps and notes never enter the build context.`,
    );
  }
}

if (!existsSync(resolve(ROOT, "Dockerfile.db-applier"))) {
  errors.push("Dockerfile.db-applier is missing.");
} else {
  const applier = readFileSync(resolve(ROOT, "Dockerfile.db-applier"), "utf8");
  if (!/postgresql-client/.test(applier) || !/pg_dump|db-applier/.test(applier)) {
    errors.push("Dockerfile.db-applier must ship postgresql-client and the db-applier scripts.");
  }

  // The image's runtime deps must stay lockfile-governed. `pnpm deploy` of the
  // packages/db-applier member is what pins them from pnpm-lock.yaml; a bare
  // `npm install` would float every transitive dependency outside the repo's
  // supply-chain gates, in the one image that holds DB credentials and may
  // pg_restore. Guard against a regression back to that — but only look at
  // instruction lines, so this file's own prose about `npm install` (and the
  // Dockerfile's explanatory comments) don't trip it.
  const applierInstructions = applier
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  if (!/pnpm[\s\S]*?\bdeploy\b/.test(applierInstructions)) {
    errors.push(
      "Dockerfile.db-applier must build its node_modules via `pnpm deploy` (lockfile-pinned), " +
        "not a bare `npm install`.",
    );
  }
  if (/\bnpm\s+install\b/.test(applierInstructions)) {
    errors.push(
      "Dockerfile.db-applier uses `npm install`, which floats transitive deps outside the pnpm " +
        "lockfile. Declare deps in packages/db-applier/package.json and `pnpm deploy` them.",
    );
  }
  if (!existsSync(resolve(ROOT, "packages/db-applier/package.json"))) {
    errors.push(
      "packages/db-applier/package.json is missing — it declares the db-applier image's " +
        "lockfile-pinned runtime dependency closure.",
    );
  }
}

// --- Postgres client major: the three Dockerfiles must agree ---
//
// `pg_dump` can dump a server OLDER than itself but never a NEWER one, so if a
// Dockerfile's `ARG PG_MAJOR` falls behind the database server's major, every
// backup fails at 3am with a message nobody reads. The three images pin the
// client from the PGDG apt repo. Drift between any of them is the bug, so
// require one identical major everywhere.
const PG_MAJOR_SOURCES = [...DOCKERFILES, "Dockerfile.db-applier"];
const pgMajors = new Map<string, string>();

for (const dockerfile of PG_MAJOR_SOURCES) {
  const path = resolve(ROOT, dockerfile);
  if (!existsSync(path)) continue;
  const major = readFileSync(path, "utf8").match(/^ARG\s+PG_MAJOR=(\d+)/m)?.[1];
  if (!major) {
    errors.push(
      `${dockerfile}: no \`ARG PG_MAJOR=<major>\` found. The postgresql-client major must be ` +
        `pinned (PGDG), not inherited from Debian's default repo.`,
    );
    continue;
  }
  pgMajors.set(dockerfile, major);
}

const pgMajor = [...new Set(pgMajors.values())][0];
if (new Set(pgMajors.values()).size > 1) {
  const listed = [...pgMajors].map(([source, major]) => `${source} → ${major}`).join(", ");
  errors.push(
    `Postgres major drift: ${listed}. The client shipped in the images must be the same major as ` +
      `(or newer than) the server, and this repo keeps them identical — set the same value in ` +
      `\`ARG PG_MAJOR\` in ${PG_MAJOR_SOURCES.join(", ")}.`,
  );
}

// --- HEALTHCHECK start-period vs the schema startup gate ---
//
// Both app images sit in the entrypoint's schema gate before the CMD process
// exists: followers poll scripts/wait-for-schema.mjs for up to
// SCHEMA_WAIT_TIMEOUT_SECONDS, and the apply leader spends additional backup +
// DDL time on top (APPLY_BUDGET_SLACK). Docker only exempts failed probes
// during --start-period, so a start-period inside that window marks a
// legitimately-waiting follower unhealthy. The wait default is parsed from the
// script's own source — a hardcoded copy here would drift exactly the way this
// check exists to catch.
const schemaWaitDefault = schemaWaitDefaultSeconds(
  readFileSync(resolve(ROOT, "scripts/wait-for-schema.mjs"), "utf8"),
);
if (schemaWaitDefault === null) {
  errors.push(
    "scripts/wait-for-schema.mjs: cannot parse the SCHEMA_WAIT_TIMEOUT_SECONDS default — update " +
      "schemaWaitDefaultSeconds() in scripts/check-docker-copy.ts to match the source shape.",
  );
} else {
  for (const dockerfile of DOCKERFILES) {
    errors.push(
      ...healthcheckStartPeriodErrors(
        dockerfile,
        readFileSync(resolve(ROOT, dockerfile), "utf8"),
        schemaWaitDefault,
      ),
    );
  }
}

// --- Runtime scripts: every sibling a shipped shell script invokes must be
// COPY'd too. backup.sh shells out to `node "$(dirname "$0")/x.mjs"` and
// db-applier.sh to `bash "$ROOT/scripts/x.sh"`; an image that ships the caller
// without the callee fails at the moment of a backup, not at build time — which
// is how Dockerfile.db-applier once shipped backup.sh without
// backup-heartbeat.mjs. Scan each image's entrypoint-reachable scripts for such
// references and require every one to appear in that image's runner-stage COPY
// lines. Per image, because the entrypoints differ: only db-applier ships
// db-applier-entrypoint.sh (and the write-db-applier-env.mjs it calls), and the
// app images must NOT ship it.
const RUNTIME_SCRIPT_ROOTS: Record<string, string[]> = {
  Dockerfile: ["scripts/docker-entrypoint.sh", "scripts/db-applier.sh", "scripts/backup.sh"],
  "Dockerfile.worker": [
    "scripts/docker-entrypoint.sh",
    "scripts/db-applier.sh",
    "scripts/backup.sh",
  ],
  "Dockerfile.db-applier": [
    "scripts/db-applier-entrypoint.sh",
    "scripts/db-applier.sh",
    "scripts/backup.sh",
  ],
};
for (const [dockerfile, roots] of Object.entries(RUNTIME_SCRIPT_ROOTS)) {
  const dockerfilePath = resolve(ROOT, dockerfile);
  if (!existsSync(dockerfilePath)) continue;
  const referencedScripts = new Set<string>(roots);
  for (const rel of referencedScripts) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    for (const dependency of runtimeScriptReferences(rel, readFileSync(path, "utf8"))) {
      referencedScripts.add(dependency);
    }
  }
  const copiedScripts = runtimeScriptCopies(readFileSync(dockerfilePath, "utf8"));
  for (const script of [...referencedScripts].sort()) {
    if (!existsSync(resolve(ROOT, script))) {
      errors.push(`${script} is referenced from a runtime script but does not exist in the repo.`);
      continue;
    }
    if (!copiedScripts.has(script)) {
      errors.push(
        `${dockerfile} does not COPY ${script}, but a shipped runtime script invokes it — add it to the runner-stage COPY list.`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Dockerfile COPY-list drift detected:\n");
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    "\nEdit the COPY lists in the builder/prod-deps stages of both Dockerfiles to match the workspace,",
  );
  console.error(
    "or update the ALLOWLIST in scripts/check-docker-copy.ts if an exclusion is genuinely intentional.",
  );
  process.exit(1);
}

// Report only the allowlist entries that still exist on disk. Both are
// removable modules (patterns/removable/{cli,native}.md), so naming a directory
// the developer already deleted reads as "this check still expects apps/native
// back" — the opposite of the truth.
//
// Tested against the filesystem, not `members`: apps/cli is a cargo workspace
// with no package.json, so it is deliberately never a discovered member even
// though it is very much present.
const excluded = [...ALLOWLIST].filter((member) => existsSync(resolve(ROOT, member))).sort();

console.log(
  `Dockerfile COPY lists are in sync with ${members.size} workspace members` +
    (excluded.length > 0
      ? ` (${excluded.length} intentionally excluded: ${excluded.join(", ")})`
      : "") +
    (pgMajor ? `; Postgres major ${pgMajor} across images.` : "."),
);
