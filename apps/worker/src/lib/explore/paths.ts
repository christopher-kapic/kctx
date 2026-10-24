import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a model-supplied path so it cannot escape `root`.
 *
 * Uses `realpathSync.native` when the path exists so a symlink planted inside
 * the tree cannot walk out; for non-existent targets (create paths, missing
 * files) falls back to lexical resolution under the real root.
 */
export function resolveWithinRoot(root: string, relativePath = "."): string {
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const candidate = path.resolve(rootReal, relativePath);

  // Lexical check first — cheap reject before touching the filesystem.
  assertInside(rootReal, candidate);

  try {
    const real = fs.realpathSync.native(candidate);
    assertInside(rootReal, real);
    return real;
  } catch (error) {
    if (isNotFound(error)) {
      // Parent must still be inside the root (handles `../secret` via missing leaf).
      const parentReal = fs.realpathSync.native(path.dirname(candidate));
      assertInside(rootReal, parentReal);
      return candidate;
    }
    throw error;
  }
}

export function toRelativeRootPath(root: string, absolutePath: string): string {
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const real = fs.realpathSync.native(path.resolve(absolutePath));
  assertInside(rootReal, real);
  const relative = path.relative(rootReal, real);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function assertInside(rootReal: string, candidate: string): void {
  if (candidate === rootReal) return;
  if (candidate.startsWith(rootReal + path.sep)) return;
  throw new Error(`Path escapes explore root: ${candidate}`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/** Directories we never descend into while exploring a dependency checkout. */
export const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);
