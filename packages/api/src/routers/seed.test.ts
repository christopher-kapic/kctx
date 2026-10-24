import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@starter/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — handlers read env.NODE_ENV at call time, so flipping this
// between tests exercises the dev vs production confirm-phrase branches.
const envMock = { NODE_ENV: "development" as "development" | "production" | "test" };
vi.mock("@starter/env/server", () => ({
  env: envMock,
}));

// @starter/queue opens IORedis sockets at import time — must be mocked or the
// suite hangs in CI (no Redis). See patterns/testing.md § Designing tests for CI.
const ensureRunnableJob = vi.fn();
vi.mock("@starter/queue", () => ({
  seedQueue: { add: vi.fn() },
  ensureRunnableJob,
}));

// `../index` imports the Prisma client at module load (the force-2FA gate in
// adminOr404Procedure reads appSetting), so the db boundary must be mocked or
// @starter/db's createEnv() chain throws "Invalid environment variables" in CI
// (no DATABASE_URL/REDIS_URL). The mock defaults appSetting.findMany to [] so
// the role-scoped 2FA policy resolves false and leaves these confirm-phrase tests unaffected.
vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

const { seedRouter, requiredConfirmPhrase } = await import("./seed");

function buildContext(role: "admin" | "user" | null): Context {
  if (role === null) return { session: null };
  return {
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role,
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
      session: {
        id: "test-session-id",
        userId: "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
    } as Session,
  };
}

describe("requiredConfirmPhrase", () => {
  it("is the loud phrase in production, the lighter one otherwise", () => {
    expect(requiredConfirmPhrase("production")).toBe("SEED PRODUCTION");
    expect(requiredConfirmPhrase("development")).toBe("seed");
    expect(requiredConfirmPhrase("test")).toBe("seed");
  });
});

describe("seedRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.NODE_ENV = "development";
  });

  describe("info", () => {
    it("reports the dev confirm phrase and isProduction=false", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      expect(await client.info()).toEqual({
        isProduction: false,
        requiredConfirmPhrase: "seed",
      });
    });

    it("reports the production phrase and isProduction=true in prod", async () => {
      envMock.NODE_ENV = "production";
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      expect(await client.info()).toEqual({
        isProduction: true,
        requiredConfirmPhrase: "SEED PRODUCTION",
      });
    });

    it("404s for non-admins (the surface must not be discoverable)", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("user") });
      await expect(client.info()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });
  });

  describe("run", () => {
    it("enqueues a seed job when the confirm phrase matches", async () => {
      ensureRunnableJob.mockResolvedValue({ id: "seed" });
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      const result = await client.run({ confirm: "seed" });

      expect(result).toEqual({ jobId: "seed" });
      expect(ensureRunnableJob).toHaveBeenCalledWith(
        expect.anything(),
        "seed",
        { requestedBy: "admin-user-id" },
        "seed",
      );
    });

    it("reports a missing job id as null instead of echoing the requested one", async () => {
      ensureRunnableJob.mockResolvedValue({ id: undefined });
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "seed" })).resolves.toEqual({ jobId: null });
    });

    it("trims surrounding whitespace before comparing the phrase", async () => {
      ensureRunnableJob.mockResolvedValue({ id: "seed" });
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "  seed  " })).resolves.toEqual({ jobId: "seed" });
    });

    it("rejects a wrong confirm phrase without enqueuing", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "yes" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(ensureRunnableJob).not.toHaveBeenCalled();
    });

    it("requires the loud production phrase in prod (the dev phrase is rejected)", async () => {
      envMock.NODE_ENV = "production";
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "seed" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(ensureRunnableJob).not.toHaveBeenCalled();

      ensureRunnableJob.mockResolvedValue({ id: "seed" });
      await expect(client.run({ confirm: "SEED PRODUCTION" })).resolves.toEqual({
        jobId: "seed",
      });
    });

    it("404s for non-admins", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("user") });
      await expect(client.run({ confirm: "seed" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });
  });
});
