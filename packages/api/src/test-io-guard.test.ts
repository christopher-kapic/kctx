import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testIoGuardKey = Symbol.for("starter.test-io-guard");

describe("test I/O guard", () => {
  it("loads the non-restorable TCP guard before test imports", () => {
    const state = Reflect.get(globalThis, testIoGuardKey) as
      | { active?: unknown; connectionAttempts?: unknown }
      | undefined;

    expect(state?.active).toBe(true);
    expect(state?.connectionAttempts).toBe(0);
    expect(Reflect.get(net.Socket.prototype.connect, testIoGuardKey)).toBe(true);
  });

  it("fails the suite when code catches a blocked TCP attempt", () => {
    const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const repoRoot = path.resolve(apiRoot, "../..");
    const vitestEntrypoint = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
    const fixture = path.join(apiRoot, "src/test-io-guard-caught.fixture.ts");
    const config = path.join(repoRoot, "scripts/vitest-test-io-guard-fixture.config.ts");
    const result = spawnSync(
      process.execPath,
      [vitestEntrypoint, "run", fixture, "--config", config],
      {
        cwd: apiRoot,
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Test I/O guard blocked 1 TCP connection attempt(s)",
    );
  });
});
