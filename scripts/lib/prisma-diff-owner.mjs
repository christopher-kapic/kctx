// Own the pinned Prisma CLI's native schema-engine processes, not a process
// group. This is a CLI lifecycle adapter, not a sandbox for arbitrary configs.
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { boundedChild } from "./bounded-child.mjs";

const exit = process.exit.bind(process);
const abort = new AbortController();
// Prisma's migrate diff drives the pinned engine binary more than once: it runs
// `schema-engine --version` to verify the (possibly freshly cached) binary
// before it spawns the long-lived diff engine it speaks JSON-RPC to. Both are
// native schema-engine processes we must own and drain so a CLI exit can never
// orphan one holding the database — so we track every one, not just the first.
const engines = [];
let finishing = false;

// A rejected child is otherwise an opaque `null` two processes away. Name the
// offending child on stderr (collect-prisma inherits it) so a changed Prisma or
// runtime contract is diagnosable from a CI/deploy log rather than guessed at.
function report(reason, file, args, options) {
  console.error(
    `prisma-diff-owner: ${reason}: ${basename(String(file))} ${JSON.stringify(args ?? [])}` +
      `${options?.shell ? " [shell]" : ""}${options?.detached ? " [detached]" : ""}`,
  );
}

async function finish(code = 1) {
  if (finishing) return;
  finishing = true;
  // A CLI exit while any owned engine still runs is not a successful comparison.
  for (const engine of engines)
    if (engine.child.exitCode === null && engine.child.signalCode === null) {
      code = 1;
      abort.abort();
    }
  // Close is acknowledged only after every owned native client has drained.
  // Parent death or a fatal signal cannot manufacture this acknowledgement.
  const drains = await Promise.all(
    engines.map((engine) =>
      engine.done.then(
        () => true,
        () => false,
      ),
    ),
  );
  if (drains.some((drained) => !drained)) code = 1;
  if (process.connected) process.send({ schemaDiffDrained: true }, () => exit(code));
  else exit(code);
}

const cancel = () => {
  abort.abort();
  void finish(1);
};
for (const name of ["SIGTERM", "SIGINT", "SIGHUP", "disconnect"]) process.on(name, cancel);
process.channel?.unref();
process.on("uncaughtException", cancel);
process.on("unhandledRejection", cancel);
process.once("beforeExit", (code) => void finish(code));
process.exit = (code) => void finish(Number(code ?? process.exitCode ?? 0));

// Every native schema-engine Prisma spawns — the `--version` probe and the diff
// engine alike — is owned and drained here. Anything else through async spawn
// (a renamed/wrapped engine, an unexpected descendant) fails closed: silently
// returning a bogus (empty) diff to apply to a database is exactly the costly
// mistake this guard exists to prevent. A shell/detached engine, or a spawn
// after shutdown, is likewise a changed contract and fails closed.
childProcess.spawn = (file, args, options) => {
  if (
    finishing ||
    abort.signal.aborted ||
    !basename(String(file)).startsWith("schema-engine-") ||
    options?.shell ||
    options?.detached
  ) {
    report("refused unowned spawn", file, args, options);
    throw new Error("Unsupported schema comparison child contract.");
  }
  const engine = boundedChild(file, args, { ...options, signal: abort.signal });
  engines.push(engine);
  return engine.child;
};

// Prisma probes the host for its engine's binary target through short-lived,
// read-only helpers run via child_process.exec/execFile and their sync forms —
// `ldconfig -p`, `openssl version`, `uname -m`. These buffer their output and
// exit on their own; they never stream the engine and hold no database
// connection, and Node's exec/execFile reach spawn through an internal binding
// (not this module's export), so they cannot slip an unowned engine past the
// guard above. Leaving them as the real implementations lets platform detection
// succeed across environments instead of failing closed on a host layout Prisma
// has to probe for. Only `fork` stays refused: a node fork in the diff path is
// not a probe surface, so it is a changed contract and fails closed.
childProcess.fork = (modulePath, args) => {
  report("refused fork", modulePath, Array.isArray(args) ? args : []);
  throw new Error("Unsupported schema comparison child contract.");
};

try {
  const [, , cli, ...args] = process.argv;
  if (!process.send || !cli || args[0] !== "migrate" || args[1] !== "diff")
    throw new Error("Invalid schema comparison owner invocation.");
  process.env.CHECKPOINT_DISABLE = "1";
  process.argv = [process.execPath, resolve(cli), ...args];
  createRequire(import.meta.url)(resolve(cli));
} catch (error) {
  report("owner invocation failed", process.argv[2] ?? "", [error?.message ?? String(error)]);
  cancel();
}
