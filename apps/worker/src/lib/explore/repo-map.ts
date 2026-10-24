import fs from "node:fs";
import path from "node:path";

import { SKIP_DIR_NAMES } from "./paths.js";

export type RepoMap = {
  generatedAt: string;
  rootName: string;
  languages: string[];
  manifests: string[];
  entrypoints: string[];
  examplePaths: string[];
  docPaths: string[];
  topLevel: string[];
  notablePackages: string[];
  hints: string[];
};

const ENTRY_CANDIDATES = [
  "README.md",
  "readme.md",
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/lib.rs",
  "src/main.rs",
  "lib/index.ts",
  "packages",
  "crates",
  "examples",
  "docs",
  "doc",
];

/**
 * Deterministic, cheap repo map — no LLM.
 *
 * Intended to be injected into the system prompt so the answer agent starts
 * oriented (layout, examples, entrypoints, languages) without spending tool
 * rounds on discovery.
 */
export function generateRepoMap(root: string): RepoMap {
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const rootName = path.basename(rootReal);
  const topLevel = listDirNames(rootReal).slice(0, 40);
  const manifests: string[] = [];
  const examplePaths: string[] = [];
  const docPaths: string[] = [];
  const entrypoints: string[] = [];
  const notablePackages: string[] = [];
  const languageVotes = new Map<string, number>();

  walkLimited(rootReal, rootReal, 0, 4, (absolute, relative, dirent) => {
    if (dirent.isDirectory()) {
      const base = dirent.name.toLowerCase();
      if (base === "examples" || base === "example" || base === "samples") {
        examplePaths.push(relative === "" ? dirent.name : `${relative}/${dirent.name}`);
      }
      if (base === "docs" || base === "doc" || base === "documentation") {
        docPaths.push(relative === "" ? dirent.name : `${relative}/${dirent.name}`);
      }
      return;
    }

    const name = dirent.name;
    const relFile = relative === "" ? name : `${relative}/${name}`;
    if (
      name === "package.json" ||
      name === "Cargo.toml" ||
      name === "go.mod" ||
      name === "pyproject.toml" ||
      name === "CMakeLists.txt" ||
      name.endsWith(".csproj")
    ) {
      if (manifests.length < 40) manifests.push(relFile);
    }

    voteLanguage(languageVotes, name);

    if (ENTRY_CANDIDATES.includes(relFile) || ENTRY_CANDIDATES.includes(name)) {
      if (entrypoints.length < 25) entrypoints.push(relFile);
    }
  });

  for (const workspace of ["packages", "crates", "apps"]) {
    const dir = path.join(rootReal, workspace);
    if (!fs.existsSync(dir)) continue;
    for (const name of listDirNames(dir).slice(0, 25)) {
      notablePackages.push(`${workspace}/${name}`);
    }
  }

  for (const candidate of ENTRY_CANDIDATES) {
    const absolute = path.join(rootReal, candidate);
    if (fs.existsSync(absolute) && !entrypoints.includes(candidate)) {
      entrypoints.unshift(candidate);
    }
  }

  const languages = [...languageVotes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([lang]) => lang);

  const hints: string[] = [];
  if (examplePaths.length > 0) {
    hints.push("Prefer exploring examplePaths before deep src/ dives for usage questions.");
  }
  if (notablePackages.length > 0) {
    hints.push(
      "This is a monorepo — identify the relevant package/crate before grepping the whole tree.",
    );
  }
  if (languages.includes("rust")) {
    hints.push("Rust: start with README, examples/, and src/lib.rs / crate roots.");
  }
  if (languages.includes("typescript") || languages.includes("javascript")) {
    hints.push("TS/JS: start with package.json exports, examples/, and packages/*/src/index.ts.");
  }

  return {
    generatedAt: new Date().toISOString(),
    rootName,
    languages,
    manifests: unique(manifests).slice(0, 40),
    entrypoints: unique(entrypoints).slice(0, 25),
    examplePaths: unique(examplePaths).slice(0, 20),
    docPaths: unique(docPaths).slice(0, 15),
    topLevel,
    notablePackages: unique(notablePackages).slice(0, 40),
    hints,
  };
}

/** Compact JSON for system-prompt injection (bounded). */
export function formatRepoMapForPrompt(map: RepoMap, maxChars = 6000): string {
  const body = JSON.stringify(map, null, 2);
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n…[truncated]`;
}

function listDirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !SKIP_DIR_NAMES.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function walkLimited(
  root: string,
  current: string,
  depth: number,
  maxDepth: number,
  visit: (absolute: string, relative: string, dirent: fs.Dirent) => void,
): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  const relative = path.relative(root, current).split(path.sep).join("/");
  for (const dirent of entries) {
    if (dirent.name.startsWith(".")) continue;
    if (dirent.isDirectory() && SKIP_DIR_NAMES.has(dirent.name)) continue;
    const absolute = path.join(current, dirent.name);
    visit(absolute, relative, dirent);
    if (dirent.isDirectory()) {
      walkLimited(root, absolute, depth + 1, maxDepth, visit);
    }
  }
}

function voteLanguage(votes: Map<string, number>, filename: string): void {
  const ext = path.extname(filename).toLowerCase();
  const table: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".rs": "rust",
    ".go": "go",
    ".py": "python",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".md": "markdown",
  };
  const lang = table[ext];
  if (!lang) return;
  votes.set(lang, (votes.get(lang) ?? 0) + 1);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
