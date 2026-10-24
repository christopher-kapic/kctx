import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatRepoMapForPrompt, generateRepoMap } from "./repo-map.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateRepoMap", () => {
  it("detects languages, examples, and manifests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kc3-map-"));
    temps.push(root);
    fs.writeFileSync(path.join(root, "README.md"), "# hello\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n');
    fs.mkdirSync(path.join(root, "examples"));
    fs.writeFileSync(path.join(root, "examples", "basic.ts"), "export {}\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1\n");

    const map = generateRepoMap(root);
    expect(map.languages).toContain("typescript");
    expect(map.examplePaths).toContain("examples");
    expect(map.manifests).toContain("package.json");
    expect(map.entrypoints).toContain("README.md");
    expect(formatRepoMapForPrompt(map)).toContain("examplePaths");
  });
});
