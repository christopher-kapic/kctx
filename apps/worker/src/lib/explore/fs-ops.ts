import fs from "node:fs";
import path from "node:path";

import { resolveWithinRoot, SKIP_DIR_NAMES, toRelativeRootPath } from "./paths.js";

const DEFAULT_MAX_MATCHES = 40;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;
const MAX_FILE_BYTES = 512_000;
const MAX_GLOB_RESULTS = 200;

export type GlobResult = {
  matches: string[];
  truncated: boolean;
};

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
};

export type GrepResult = {
  matches: GrepMatch[];
  truncated: boolean;
};

export type ReadResult = {
  path: string;
  offset: number;
  limit: number;
  totalLines: number;
  content: string;
  truncated: boolean;
};

export function exploreGlob(root: string, pattern: string, searchPath = "."): GlobResult {
  const base = resolveWithinRoot(root, searchPath);
  const matches: string[] = [];
  let truncated = false;

  // Node's fs.glob walks from `cwd`; patterns are relative to that base.
  for (const entry of fs.globSync(pattern, {
    cwd: base,
    withFileTypes: true,
    exclude: (dirent) => dirent.isDirectory() && SKIP_DIR_NAMES.has(dirent.name),
  })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    try {
      matches.push(toRelativeRootPath(root, absolute));
    } catch {
      // Symlink escaped — skip.
      continue;
    }
    if (matches.length >= MAX_GLOB_RESULTS) {
      truncated = true;
      break;
    }
  }

  matches.sort();
  return { matches, truncated };
}

export function exploreGrep(
  root: string,
  pattern: string,
  options: {
    searchPath?: string;
    caseInsensitive?: boolean;
    maxMatches?: number;
  } = {},
): GrepResult {
  const maxMatches = Math.min(Math.max(options.maxMatches ?? DEFAULT_MAX_MATCHES, 1), 100);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.caseInsensitive ? "i" : undefined);
  } catch (error) {
    throw new Error(
      `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const base = resolveWithinRoot(root, options.searchPath ?? ".");
  const matches: GrepMatch[] = [];
  let truncated = false;

  walkFiles(base, (absolute) => {
    if (truncated) return false;
    if (!isProbablyTextFile(absolute)) return true;

    let text: string;
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_FILE_BYTES) return true;
      text = fs.readFileSync(absolute, "utf8");
    } catch {
      return true;
    }
    if (text.includes("\u0000")) return true;

    const relative = toRelativeRootPath(root, absolute);
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!regex.test(line)) continue;
      matches.push({
        path: relative,
        line: index + 1,
        text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
      });
      if (matches.length >= maxMatches) {
        truncated = true;
        return false;
      }
    }
    return true;
  });

  return { matches, truncated };
}

export function exploreRead(
  root: string,
  relativePath: string,
  options: { offset?: number; limit?: number } = {},
): ReadResult {
  const absolute = resolveWithinRoot(root, relativePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File too large to read (${stat.size} bytes; max ${MAX_FILE_BYTES}): ${relativePath}`,
    );
  }

  const text = fs.readFileSync(absolute, "utf8");
  if (text.includes("\u0000")) {
    throw new Error(`Refusing to read binary file: ${relativePath}`);
  }

  const lines = text.split(/\r?\n/);
  const offset = Math.max(options.offset ?? 1, 1);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);
  const startIndex = offset - 1;
  const slice = lines.slice(startIndex, startIndex + limit);
  const truncated = startIndex + slice.length < lines.length;

  const numbered = slice.map((line, index) => `${startIndex + index + 1}|${line}`).join("\n");

  return {
    path: toRelativeRootPath(root, absolute),
    offset,
    limit,
    totalLines: lines.length,
    content: numbered,
    truncated,
  };
}

function walkFiles(base: string, visit: (absolute: string) => boolean): void {
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      try {
        const real = fs.realpathSync.native(absolute);
        if (!real.startsWith(base + path.sep) && real !== base) continue;
        if (!fs.statSync(real).isFile()) continue;
        if (!visit(real)) return;
      } catch {
        // dangling / escaped symlink
      }
    }
  }
}

function isProbablyTextFile(absolute: string): boolean {
  const ext = path.extname(absolute).toLowerCase();
  if (
    [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".ico",
      ".pdf",
      ".zip",
      ".gz",
      ".tar",
      ".woff",
      ".woff2",
      ".ttf",
      ".otf",
      ".mp4",
      ".mp3",
      ".wasm",
      ".so",
      ".dylib",
      ".dll",
      ".exe",
      ".bin",
    ].includes(ext)
  ) {
    return false;
  }
  return true;
}
