import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildExploreTools } from "./tools.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildExploreTools", () => {
  it("registers glob, grep, and read against a real root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kc3-explore-tools-"));
    temps.push(root);
    fs.writeFileSync(path.join(root, "hello.ts"), "export const hello = 1;\n");

    const tools = buildExploreTools(root);
    expect(tools.map((tool) => tool.name)).toEqual(["glob", "grep", "read"]);

    const signal = new AbortController().signal;
    const glob = tools.find((tool) => tool.name === "glob");
    const grep = tools.find((tool) => tool.name === "grep");
    const read = tools.find((tool) => tool.name === "read");

    expect(await glob?.execute({ pattern: "**/*.ts" }, signal)).toMatchObject({
      matches: ["hello.ts"],
    });
    expect(await grep?.execute({ pattern: "hello" }, signal)).toMatchObject({
      matches: [{ path: "hello.ts", line: 1 }],
    });
    expect(await read?.execute({ path: "hello.ts" }, signal)).toMatchObject({
      path: "hello.ts",
      content: expect.stringContaining("1|export const hello"),
    });
  });

  it("fails closed when the root does not exist", () => {
    expect(() => buildExploreTools("/tmp/kc3-explore-does-not-exist-ever")).toThrow();
  });
});
