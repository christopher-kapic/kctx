import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — emailEnabled reads SMTP_HOST/SMTP_FROM (via the mailer's
// isEmailConfigured, mocked below against this same object) at call time, so
// flipping them between tests exercises both branches of the flag.
const envMock = {
  SMTP_HOST: undefined as string | undefined,
  SMTP_FROM: undefined as string | undefined,
  SSO_PROVIDER_NAME: "SSO",
  SSO_ENABLED: false,
  FORCE_SSO: false,
  SIGNUP_ENABLED: true,
  RATE_LIMIT_AUTH_POINTS: 30,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
  RATE_LIMIT_RPC_POINTS: 100,
  RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
  RATE_LIMIT_UPLOAD_POINTS: 200,
  RATE_LIMIT_UPLOAD_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMAIL_POINTS: 3,
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
  RATE_LIMIT_CHAT_POINTS: 20,
  RATE_LIMIT_CHAT_WINDOW_SECONDS: 60,
};
const adminEmailsMock = new Set<string>();
vi.mock("@starter/env/server", () => ({
  env: envMock,
  get SSO_ENABLED() {
    return envMock.SSO_ENABLED;
  },
  get FORCE_SSO() {
    return envMock.FORCE_SSO;
  },
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
  ADMIN_EMAILS: adminEmailsMock,
}));

// `@starter/env/shared` VALIDATES process.env at module load and throws when it
// is empty — which is exactly CI. The chat gate (`lib/chat-enabled.ts`) reads
// it, so importing the full router graph pulls it in. Same module-load boundary
// rule as the queue mock below: see patterns/testing.md.
vi.mock("@starter/env/shared", () => ({
  env: { CHAT_ENABLED: true, OPENROUTER_API_KEY: "test-key" },
}));

// Mock @starter/db so importing the full appRouter graph never touches Postgres.
vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// @starter/queue opens IORedis sockets at import time — mock every producer the
// import graph touches or the suite hangs in CI (no Redis). See
// patterns/testing.md § Designing tests for CI.
vi.mock("@starter/queue", () => {
  const fakeQueue = { add: vi.fn() };
  return {
    analyzeAssetQueue: fakeQueue,
    chatRunQueue: fakeQueue,
    cleanupAssetsQueue: fakeQueue,
    echoQueue: fakeQueue,
    seedQueue: fakeQueue,
    reapStaleChatRunsQueue: fakeQueue,
    reapExpiredAuthTokensQueue: fakeQueue,
    checkBackupFreshnessQueue: fakeQueue,
    echoJobSchema: { parse: (v: unknown) => v },
    ensureRunnableJob: vi.fn(),
    QUEUE_NAMES: {},
    // The chat spend limiter (packages/api/src/lib/chat-rate-limit.ts) builds a
    // Redis-backed limiter over this connection at module load.
    redisConnection: {},
  };
});

// @starter/auth builds the Better-Auth instance (prismaAdapter, plugins) at
// import time — stub it so the graph loads without that machinery.
vi.mock("@starter/auth", () => ({
  auth: { api: {} },
}));

// @starter/mailer would open SMTP — stub the surface the import graph uses.
// isEmailConfigured mirrors the real implementation against the env mock.
vi.mock("@starter/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
  isEmailConfigured: () => Boolean(envMock.SMTP_HOST && envMock.SMTP_FROM),
}));

// The storage lib constructs an S3 client. Stub it.
vi.mock("../lib/storage", () => ({
  createMultipartUpload: vi.fn(),
  presignUploadPart: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
  headStorageObject: vi.fn(),
  putStorageObject: vi.fn(),
  deleteStorageObject: vi.fn(),
  listStorageObjects: vi.fn(),
}));

const { appRouter } = await import("./index");

const publicContext: Context = { session: null };

describe("health", () => {
  it("exposes only the cheap check — no RPC readiness probe on the datastore", () => {
    // A DB-touching `ready` procedure was removed as an anonymous
    // datastore-drain vector bounded only by the generic /rpc limiter;
    // readiness is the HTTP /ready route with its own readyLimiter bucket.
    expect(Object.keys(appRouter.health)).toEqual(["check"]);
  });

  it("answers check without a session", async () => {
    const client = createRouterClient(appRouter, { context: publicContext });

    await expect(client.health.check()).resolves.toBe("OK");
  });
});

describe("appConfig", () => {
  beforeEach(() => {
    envMock.SMTP_HOST = undefined;
    envMock.SMTP_FROM = undefined;
    envMock.SSO_ENABLED = false;
    envMock.FORCE_SSO = false;
    envMock.SIGNUP_ENABLED = true;
    envMock.SSO_PROVIDER_NAME = "SSO";
    adminEmailsMock.clear();
  });

  it("reports emailEnabled=false when SMTP_HOST is unset", async () => {
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(false);
  });

  it("reports emailEnabled=true when SMTP_HOST and SMTP_FROM are configured", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    envMock.SMTP_FROM = "App <no-reply@example.com>";
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(true);
  });

  it("reports emailEnabled=false when SMTP_HOST is set without SMTP_FROM", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(false);
  });

  it("surfaces the SSO and signup flags alongside emailEnabled", async () => {
    envMock.SSO_ENABLED = true;
    envMock.FORCE_SSO = true;
    envMock.SIGNUP_ENABLED = false;
    envMock.SSO_PROVIDER_NAME = "Okta";
    envMock.SMTP_HOST = "smtp.example.com";
    envMock.SMTP_FROM = "App <no-reply@example.com>";

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config).toEqual({
      ssoEnabled: true,
      forceSso: true,
      ssoProviderName: "Okta",
      signupEnabled: false,
      adminBootstrapSignupEnabled: false,
      emailEnabled: true,
    });
  });

  it("surfaces the admin bootstrap signup carve-out when signup is otherwise disabled", async () => {
    envMock.SIGNUP_ENABLED = false;
    adminEmailsMock.add("admin@example.com");

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.adminBootstrapSignupEnabled).toBe(true);
  });
});
