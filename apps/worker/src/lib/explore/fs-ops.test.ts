import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exploreGlob, exploreGrep, exploreRead } from "./fs-ops.js";

const temps: string[] = [];

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kc3-explore-ops-"));
  temps.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "examples"));
  fs.writeFileSync(
    path.join(root, "src", "api.ts"),
    ["export function greet(name: string) {", "  return `hello ${name}`;", "}", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "examples", "basic.ts"),
    'import { greet } from "../src/api";\nconsole.log(greet("world"));\n',
  );
  fs.mkdirSync(path.join(root, "node_modules", "leftpad"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("exploreGlob", () => {
  it("finds source files and skips node_modules", () => {
    const root = makeFixture();
    const result = exploreGlob(root, "**/*.ts");
    expect(result.matches).toEqual(["examples/basic.ts", "src/api.ts"]);
    expect(result.truncated).toBe(false);
  });
});

describe("exploreGrep", () => {
  it("returns file:line matches for an API symbol", () => {
    const root = makeFixture();
    const result = exploreGrep(root, "function greet");
    expect(result.matches).toEqual([
      { path: "src/api.ts", line: 1, text: "export function greet(name: string) {" },
    ]);
  });

  it("rejects invalid regex", () => {
    const root = makeFixture();
    expect(() => exploreGrep(root, "(")).toThrow(/Invalid grep pattern/);
  });
});

describe("exploreRead", () => {
  it("returns numbered lines with paging metadata", () => {
    const root = makeFixture();
    const result = exploreRead(root, "src/api.ts", { offset: 1, limit: 2 });
    expect(result.path).toBe("src/api.ts");
    // Trailing newline from the fixture yields an empty final line.
    expect(result.totalLines).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("1|export function greet");
    expect(result.content).toContain("2|  return");
  });
});
