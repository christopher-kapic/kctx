import { beforeEach, describe, expect, it, vi } from "vitest";

const inertDatabaseUrl = [
  "post",
  "gresql://reader:",
  "inert@db.example.com:5432/starter?sslmode=require",
].join("");

const envState = {
  BACKUP_ENABLED: true,
  BACKUP_S3_BUCKET: "backups",
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: "monitor-key",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "monitor-secret",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_ENDPOINT: "https://r2.example.com",
  BACKUP_S3_PREFIX: "/database/",
  BACKUP_S3_FORCE_PATH_STYLE: false,
  BACKUP_MAX_AGE_HOURS: 36,
  DATABASE_URL: inertDatabaseUrl,
};

vi.mock("@starter/env/shared", () => ({ env: envState }));

const send = vi.fn();
const s3Clients = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(options: Record<string, unknown>) {
      s3Clients(options);
    }

    send = send;
  },
  ListObjectsV2Command: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

const {
  BACKUP_CHECKER_INTERVAL_HOURS,
  backupNamespace,
  backupFreshnessRedisKey,
  backupFreshnessEnabled,
  backupFreshnessNeedsAttention,
  checkBackupFreshness,
  evaluateBackupFreshness,
  misconfiguredBackupFreshness,
  readBackupFreshness,
  refreshBackupFreshness,
  setupMissingBackupFreshness,
  writeBackupFreshness,
} = await import("./backup-freshness");
const { backupMonitorConfigWarnings } = await import("@starter/env/backup-config");
const writerIdentity = await import(
  new URL("../../../../scripts/lib/backup-identity.mjs", import.meta.url).href
);

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("evaluateBackupFreshness", () => {
  it("keeps the writer and monitor namespace executable-conformant across URL aliases", () => {
    const cases = [
      ["database", "postgresql://writer:one@DB.EXAMPLE.com/starter"],
      ["/database/", "postgresql://rotated:two@db.example.com:5432/starter?sslmode=require"],
      ["team/backups", "postgresql://reader:three@db.example.com:6543/starter"],
      ["team/backups/", "postgresql://reader:four@db.example.com:6543/%73tarter"],
    ] as const;
    for (const [prefix, databaseUrl] of cases) {
      expect(backupNamespace(prefix, databaseUrl)).toBe(
        writerIdentity.backupNamespace(prefix, databaseUrl),
      );
    }
    // Credential rotation, casing/default-port aliases, and prefix slashes are
    // deliberately equal; a port change is deliberately a new provenance key.
    expect(backupNamespace("database", cases[0][1])).toBe(
      backupNamespace("/database/", cases[1][1]),
    );
    expect(backupNamespace("team/backups", cases[2][1])).toBe(
      backupNamespace("team/backups/", cases[3][1]),
    );
    expect(backupNamespace("database", cases[0][1])).not.toBe(
      backupNamespace("team/backups", cases[2][1]),
    );
  });

  it("keeps the inert monitor URL equivalent after source fragmentation", () => {
    const parsed = new URL(envState.DATABASE_URL);
    expect(parsed).toMatchObject({
      protocol: "postgresql:",
      username: "reader",
      password: "inert",
      hostname: "db.example.com",
      port: "5432",
      pathname: "/starter",
      search: "?sslmode=require",
    });
  });

  it("is fresh inside the window", () => {
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-08T03:00:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "fresh", ageHours: 9, maxAgeHours: 36 });
    expect(backupFreshnessNeedsAttention(status)).toBe(false);
  });

  it("is stale past the window", () => {
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-06T03:00:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "stale", ageHours: 57 });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });

  it("flags an empty bucket", () => {
    const status = evaluateBackupFreshness(null, NOW, 36);
    expect(status.state).toBe("empty");
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });

  it("tolerates a few minutes of clock skew", () => {
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-08T12:02:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "fresh", ageHours: 0 });
    expect(backupFreshnessNeedsAttention(status)).toBe(false);
  });

  it("is stale when the newest backup is dated in the future", () => {
    // Clamping a negative age to 0 would read as fresh forever — the newest
    // object never ages past the limit, so a stopped cron would never alert.
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-09T12:00:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({
      state: "stale",
      ageHours: 0,
      reason: "future-timestamp",
    });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });
});

describe("misconfiguration", () => {
  beforeEach(() => {
    send.mockReset();
    s3Clients.mockReset();
  });

  it("reports no misconfiguration when the backup config is usable", () => {
    expect(backupFreshnessEnabled()).toBe(true);
    expect(misconfiguredBackupFreshness(NOW)).toBeNull();
    expect(setupMissingBackupFreshness(NOW)).toBeNull();
  });

  it("uses the real monitor validator for invalid monitor profiles", () => {
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: undefined,
      }),
    ).toEqual([
      "BACKUP_S3_BUCKET is set but BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY are missing. The freshness worker needs a dedicated ListBucket-only monitor key.",
    ]);
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_S3_ACCESS_KEY_ID: "dump-key",
        BACKUP_S3_SECRET_ACCESS_KEY: "dump-secret",
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: "dump-key",
      }),
    ).toContain(
      "BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness worker needs a separate ListBucket-only key, not the dump read/write key.",
    );
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_S3_ENDPOINT: undefined,
      }),
    ).toContain(
      'BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset. The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
    );
  });
});

describe("checkBackupFreshness", () => {
  beforeEach(() => {
    send.mockReset();
    s3Clients.mockReset();
  });

  it("pages through the listing and picks the newest dump by date, not key order", async () => {
    send
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextContinuationToken: "t1",
        Contents: [
          {
            Key: "database/target/backup-zzz.dump",
            LastModified: new Date("2026-09-01T03:00:00Z"),
          },
          {
            Key: "database/target/backup-aaa.dump",
            LastModified: new Date("2026-09-08T03:00:00Z"),
          },
          {
            Key: "database/target/backup-notes.txt",
            LastModified: new Date("2026-09-08T11:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Contents: [
          {
            Key: "database/target/backup-mmm.dump",
            LastModified: new Date("2026-09-07T03:00:00Z"),
          },
        ],
      });

    const status = await checkBackupFreshness(NOW);

    expect(status).toMatchObject({ state: "fresh", latestKey: "database/target/backup-aaa.dump" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      Bucket: "backups",
      Prefix: expect.stringMatching(/^database\/[a-f0-9]{24}\/backup-$/),
    });
    expect(send.mock.calls[1]?.[0]?.input).toMatchObject({ ContinuationToken: "t1" });
    expect(s3Clients).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "monitor-key",
          secretAccessKey: "monitor-secret",
        },
      }),
    );
  });

  it("turns a listing failure into an error verdict instead of throwing", async () => {
    send.mockReset();
    send.mockRejectedValueOnce(new Error("AccessDenied"));

    const status = await checkBackupFreshness(NOW);

    expect(status).toMatchObject({ state: "error", message: "AccessDenied" });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });
});

describe("refreshBackupFreshness", () => {
  it("recomputes stale from wall-clock age even when the cache still says fresh", () => {
    const cached = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-06T12:00:00.000Z") },
      new Date("2026-09-07T12:00:00.000Z"),
      36,
    );
    expect(cached.state).toBe("fresh");

    const refreshed = refreshBackupFreshness(cached, new Date("2026-09-08T12:00:00.000Z"));
    expect(refreshed).toMatchObject({ state: "stale", ageHours: 48 });
  });

  it("marks a fresh verdict stale when the checker has not run within its interval", () => {
    const cached = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-08T10:00:00.000Z") },
      new Date("2026-09-08T11:00:00.000Z"),
      36,
    );
    const refreshed = refreshBackupFreshness(
      cached,
      new Date(
        new Date("2026-09-08T11:00:00.000Z").getTime() +
          (BACKUP_CHECKER_INTERVAL_HOURS + 1) * 3_600_000,
      ),
    );
    expect(refreshed?.state).toBe("stale");
  });

  it("treats malformed cache JSON as unknown on read", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(backupFreshnessRedisKey(), "{not json");
    await expect(readBackupFreshness(redis)).resolves.toBeNull();
  });

  it("rejects structured cache missing maxAgeHours even when otherwise recent", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "2026-09-08T11:00:00.000Z",
        latestKey: "database/backup-a.dump",
        ageHours: 1,
      }),
    );
    await expect(
      readBackupFreshness(redis, new Date("2026-09-08T14:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("reconciles a cached 720h threshold to the current configured limit", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "2026-09-06T12:00:00.000Z",
        latestKey: "database/backup-a.dump",
        ageHours: 48,
        maxAgeHours: 720,
      }),
    );
    await expect(
      readBackupFreshness(redis, new Date("2026-09-08T14:00:00.000Z")),
    ).resolves.toMatchObject({ state: "stale", maxAgeHours: 36 });
  });

  it("rejects structured cache with future checkedAt", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2099-01-01T00:00:00.000Z",
        latestAt: "2026-09-01T12:00:00.000Z",
        latestKey: "database/backup-a.dump",
        ageHours: 1,
        maxAgeHours: 36,
      }),
    );
    await expect(readBackupFreshness(redis)).resolves.toBeNull();
  });

  it("rejects structured cache with invalid latestAt", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "not-a-date",
        latestKey: "database/backup-a.dump",
        ageHours: 1,
        maxAgeHours: 36,
      }),
    );
    await expect(readBackupFreshness(redis)).resolves.toBeNull();
  });
});

describe("freshness store", () => {
  it("does not trust an unbound verdict left under the former shared cache key", async () => {
    const store = new Map([
      [
        "backup:freshness",
        JSON.stringify({
          state: "fresh",
          checkedAt: NOW.toISOString(),
          latestAt: NOW.toISOString(),
          latestKey: "database/other-target/backup.dump",
          ageHours: 0,
          maxAgeHours: 36,
        }),
      ],
    ]);
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    await expect(readBackupFreshness(redis, NOW)).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledWith(backupFreshnessRedisKey());
    expect(backupFreshnessRedisKey()).not.toBe("backup:freshness");
  });

  it("round-trips through Redis with a TTL and treats garbage as unknown", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
    };
    const status = evaluateBackupFreshness(null, NOW, 36);

    await writeBackupFreshness(redis, status);
    expect(redis.set).toHaveBeenCalledWith(
      backupFreshnessRedisKey(),
      JSON.stringify(status),
      "EX",
      3 * 24 * 60 * 60,
    );
    const read = await readBackupFreshness(redis, NOW);
    expect(read).toEqual(status);
  });
});
