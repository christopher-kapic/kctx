import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@starter/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

const reapGetJob = vi.fn();
const authTokenGetJob = vi.fn();
const echoGetJob = vi.fn();
const redisGet = vi.fn();
const backupEnabled = vi.fn(() => true);
const backupMisconfiguration = vi.fn((): { state: "misconfigured"; reason: string } | null => null);
const backupSetupMissing = vi.fn((): { state: "setup-missing"; reason: string } | null => null);

vi.mock("@starter/queue", () => {
  const fakeQueue = { add: vi.fn(), getJob: vi.fn(), getJobs: vi.fn().mockResolvedValue([]) };
  return {
    echoJobSchema: { parse: (v: unknown) => v },
    echoQueue: { ...fakeQueue, getJob: echoGetJob },
    analyzeAssetQueue: fakeQueue,
    cleanupAssetsQueue: fakeQueue,
    translateContentQueue: fakeQueue,
    seedQueue: fakeQueue,
    chatRunQueue: fakeQueue,
    reapStaleChatRunsQueue: { ...fakeQueue, getJob: reapGetJob },
    reapExpiredAuthTokensQueue: { ...fakeQueue, getJob: authTokenGetJob },
    checkBackupFreshnessQueue: fakeQueue,
    QUEUE_NAMES: {
      echo: "echo",
      analyzeAsset: "analyze-asset",
      cleanupAssets: "cleanup-assets",
      seed: "seed",
      chatRun: "chat-run",
      reapStaleChatRuns: "reap-stale-chat-runs",
      reapExpiredAuthTokens: "reap-expired-auth-tokens",
      checkBackupFreshness: "check-backup-freshness",
    },
    redisConnection: { get: redisGet },
  };
});

vi.mock("../lib/backup-freshness", () => ({
  backupFreshnessEnabled: () => backupEnabled(),
  misconfiguredBackupFreshness: () => backupMisconfiguration(),
  setupMissingBackupFreshness: () => backupSetupMissing(),
  readBackupFreshness: async (redis: { get: (key: string) => Promise<string | null> }) => {
    const raw = await redis.get("backup:freshness");
    return raw ? JSON.parse(raw) : null;
  },
}));

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@starter/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

const { queueRouter } = await import("./queue");

function buildContext(role: "admin" | "user"): Context {
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

describe("queueRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backupEnabled.mockReturnValue(true);
    backupMisconfiguration.mockReturnValue(null);
    backupSetupMissing.mockReturnValue(null);
  });

  it("includes reapStaleChatRuns in the admin queue map", async () => {
    reapGetJob.mockResolvedValue(null);
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(
      client.getJob({ jobId: "job-1", queue: "reap-stale-chat-runs" }),
    ).resolves.toBeNull();
    expect(reapGetJob).toHaveBeenCalledWith("job-1");
  });

  it("includes reapExpiredAuthTokens in the admin queue map", async () => {
    authTokenGetJob.mockResolvedValue(null);
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(
      client.getJob({ jobId: "job-1", queue: "reap-expired-auth-tokens" }),
    ).resolves.toBeNull();
    expect(authTokenGetJob).toHaveBeenCalledWith("job-1");
  });

  it("reports backups as not configured without touching Redis", async () => {
    backupEnabled.mockReturnValue(false);
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({ configured: false, status: null });
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("returns the recorded freshness verdict when backups are configured", async () => {
    backupEnabled.mockReturnValue(true);
    const verdict = {
      state: "stale",
      checkedAt: "2026-09-08T00:00:00.000Z",
      latestKey: "database/backup-1.dump",
      latestAt: "2026-09-05T03:00:00.000Z",
      ageHours: 69,
      maxAgeHours: 36,
    };
    redisGet.mockResolvedValue(JSON.stringify(verdict));
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({ configured: true, status: verdict });
    expect(redisGet).toHaveBeenCalledWith("backup:freshness");
  });

  it('reports enabled backups without a bucket as setup-missing rather than as "off"', async () => {
    backupEnabled.mockReturnValue(true);
    backupSetupMissing.mockReturnValue({
      state: "setup-missing",
      checkedAt: "2026-09-08T00:00:00.000Z",
      maxAgeHours: 36,
      reason: "BACKUP_S3_BUCKET is not set.",
    });
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({
      configured: true,
      status: {
        state: "setup-missing",
        checkedAt: "2026-09-08T00:00:00.000Z",
        maxAgeHours: 36,
        reason: "BACKUP_S3_BUCKET is not set.",
      },
    });
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('reports a set-but-unusable bucket as misconfigured rather than as "off"', async () => {
    // Hiding this behind `configured: false` means the admin card disappears
    // and the operator never learns that no backups are being taken.
    backupEnabled.mockReturnValue(true);
    backupMisconfiguration.mockReturnValue({
      state: "misconfigured",
      reason: "BACKUP_S3_REGION must be a real AWS region.",
    });
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({
      configured: true,
      status: { state: "misconfigured", reason: "BACKUP_S3_REGION must be a real AWS region." },
    });
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("hides backup status from non-admins", async () => {
    const client = createRouterClient(queueRouter, { context: buildContext("user") });
    await expect(client.backupStatus()).rejects.toBeInstanceOf(ORPCError);
  });

  it("rejects an unknown queue name", async () => {
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });
    await expect(client.getJob({ jobId: "job-1", queue: "not-a-queue" })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });
});
