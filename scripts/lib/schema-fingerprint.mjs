// Canonical byte fingerprint shared by the shell command and startup gate.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function schemaFingerprint(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile() && entry.name.endsWith(".prisma")) files.push(next);
    }
  }
  await visit(directory);
  // Match find -print0 | LC_ALL=C sort -z, without following symlinks.
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const hash = createHash("sha256");
  for (const file of files) {
    for await (const bytes of createReadStream(file)) hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 16);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      await schemaFingerprint(
        process.env.PRISMA_SCHEMA_DIR ||
          resolve(fileURLToPath(new URL("../..", import.meta.url)), "packages/db/prisma/schema"),
      ),
    );
  } catch {
    console.error("FATAL: Could not fingerprint the image schema.");
    process.exitCode = 1;
  }
}
