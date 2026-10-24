/** Shared live-comparison lifetime: CLI exit is insufficient without native drain. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { boundedChild } from "./bounded-child.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export async function collectPrisma(args, environment, signal, { timeout = 0 } = {}) {
  if (signal.aborted) return null;
  const bin = environment.PRISMA_BIN || resolve(root, "packages/db/node_modules/.bin/prisma");
  // Both the pnpm shim and the applier symlink have this sibling CLI target.
  const cli = bin.endsWith("/.bin/prisma") ? resolve(bin, "../../prisma/build/index.js") : bin;
  const owner = boundedChild(
    process.execPath,
    [resolve(root, "scripts/lib/prisma-diff-owner.mjs"), cli, ...args],
    {
      env: environment,
      cwd: environment.PRISMA_CWD || resolve(root, "packages/db"),
      signal,
      timeout,
      cooperative: true,
      // stderr is inherited so the owner's contract-rejection diagnostics reach
      // the CI/deploy log; stdout stays piped as the sole schema-diff channel.
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    },
  );
  let drained = false;
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  owner.child.on("message", (message) => {
    if (message?.schemaDiffDrained === true) drained = true;
  });
  owner.child.stdout.on("data", (chunk) => {
    if (overflow) return;
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) {
      overflow = true;
      chunks.length = 0;
      owner.stop();
    } else chunks.push(chunk);
  });
  const succeeded = await owner.done.then(
    () => true,
    () => false,
  );
  if (!drained)
    throw new Error(
      "Schema comparison could not verify comparison shutdown; continuation refused.",
    );
  if (!succeeded || overflow || signal.aborted) return null;
  // Pipe boundaries are arbitrary bytes. Decode the complete bounded output
  // only after native drain; malformed or incomplete UTF-8 must not become SQL.
  // ignoreBOM preserves a leading BOM instead of silently removing its bytes.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, bytes),
    );
  } catch {
    throw new Error("Schema comparison returned invalid UTF-8; continuation refused.");
  }
}
