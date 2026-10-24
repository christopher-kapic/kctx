import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server.ts validates process.env and runs its startup guards as import-time
// side effects, so every case re-imports a freshly reset module under a fully
// controlled environment. The helper snapshots and restores process.env so
// cases cannot leak state into each other or the surrounding test run.

type EnvMap = Record<string, string | undefined>;

const BASE_ENV: EnvMap = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  // Strong enough for the entropy check: >10 distinct characters, no
  // placeholder words, no repeating pattern.
  BETTER_AUTH_SECRET: "kV3mQ7xZ2bN9wL5pR8tY4cJ6hF1dS0gU",
  // https, so the production-only http:// guards stay out of the way.
  BETTER_AUTH_URL: "https://app.example.com",
  // Every optional key the startup guards read starts explicitly undefined,
  // so a value exported in the developer's shell cannot skew a case.
  ADMIN_EMAILS: undefined,
  SIGNUP_ENABLED: undefined,
  SSO_ENABLED: undefined,
  SSO_CLIENT_ID: undefined,
  SSO_CLIENT_SECRET: undefined,
  SSO_ISSUER: undefined,
  FORCE_SSO: undefined,
  VAPID_PUBLIC_KEY: undefined,
  VAPID_PRIVATE_KEY: undefined,
  VAPID_SUBJECT: undefined,
  SMTP_HOST: undefined,
  SMTP_FROM: undefined,
  S3_BUCKET: undefined,
  DATABASE_POOL_MAX: undefined,
};

const ENV_SNAPSHOT: EnvMap = { ...process.env };

async function importServerEnv(overrides: EnvMap = {}): Promise<typeof import("./server.js")> {
  const effective: EnvMap = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(effective)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await import("./server.js");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in ENV_SNAPSHOT)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(ENV_SNAPSHOT)) {
      process.env[key] = value;
    }
  }
}

function lockoutMessage(warn: Mock) {
  return warn.mock.calls.some((call) =>
    call.join(" ").includes("SIGNUP_ENABLED=false and ADMIN_EMAILS is empty"),
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server env — rate-limit budget defaults", () => {
  it("defaults every budget to its family reference (collapse is behavior-neutral)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.env.RATE_LIMIT_AUTH_POINTS).toBe(30);
    expect(mod.env.RATE_LIMIT_AUTH_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_RPC_POINTS).toBe(100);
    expect(mod.env.RATE_LIMIT_RPC_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_UPLOAD_POINTS).toBe(200);
    expect(mod.env.RATE_LIMIT_UPLOAD_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_EMAIL_POINTS).toBe(3);
    expect(mod.env.RATE_LIMIT_EMAIL_WINDOW_SECONDS).toBe(3600);
    expect(mod.env.RATE_LIMIT_CHAT_POINTS).toBe(20);
    expect(mod.env.RATE_LIMIT_CHAT_WINDOW_SECONDS).toBe(60);
  });

  it("accepts 0 points for RATE_LIMIT_EMAIL_POINTS — the documented family disable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ RATE_LIMIT_EMAIL_POINTS: "0" });
    expect(mod.env.RATE_LIMIT_EMAIL_POINTS).toBe(0);
  });

  it("rejects a non-positive budget points/window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importServerEnv({ RATE_LIMIT_CHAT_POINTS: "0" })).rejects.toThrow();
    await expect(importServerEnv({ RATE_LIMIT_AUTH_WINDOW_SECONDS: "0" })).rejects.toThrow();
  });
});

describe("shared env — DATABASE_POOL_MAX", () => {
  it("defaults to the node-postgres default of 10", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.env.DATABASE_POOL_MAX).toBe(10);
  });

  it("accepts a positive integer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ DATABASE_POOL_MAX: "25" });
    expect(mod.env.DATABASE_POOL_MAX).toBe(25);
  });

  it("rejects zero, negative, and non-numeric values", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importServerEnv({ DATABASE_POOL_MAX: "0" })).rejects.toThrow();
    await expect(importServerEnv({ DATABASE_POOL_MAX: "-5" })).rejects.toThrow();
    await expect(importServerEnv({ DATABASE_POOL_MAX: "many" })).rejects.toThrow();
  });
});

describe("server env startup guards — admin lockout", () => {
  it("warns (never throws) in production when signup is disabled and ADMIN_EMAILS is unset — provisioned installs keep their DB admins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "production" });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("treats an empty-string ADMIN_EMAILS as unset (lockout still warns)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "production", ADMIN_EMAILS: "" });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("still warns with SSO fully configured — SSO is not an admin escape hatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({
      NODE_ENV: "production",
      SSO_ENABLED: "true",
      SSO_CLIENT_ID: "client-id",
      SSO_CLIENT_SECRET: "sS0oW9eA1kZ3cR4eT5vB6nM7qP8xY2zQ4uV0wE",
      SSO_ISSUER: "https://sso.example.com",
      FORCE_SSO: "true",
    });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("does not throw when SIGNUP_ENABLED=true (the signup path exists)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({
      NODE_ENV: "production",
      SIGNUP_ENABLED: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "App <no-reply@example.com>",
    });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(false);
    // The pre-existing non-lockout warning still fires for this shape.
    expect(
      warn.mock.calls.some((call) =>
        call.join(" ").includes("no users will have admin privileges"),
      ),
    ).toBe(true);
  });

  it("does not throw in dev — the lockout shape only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "development" });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("boots fine with a populated ADMIN_EMAILS, trimmed and lowercased", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAILS: "  Admin@Example.com , ,bob@example.com  ",
    });
    expect(mod.ADMIN_EMAILS).toEqual(new Set(["admin@example.com", "bob@example.com"]));
    expect(warn.mock.calls.some((call) => call.join(" ").includes("ADMIN_EMAILS"))).toBe(false);
  });
});

describe("server env — resolveAppName", () => {
  it("defaults to App when unset or empty (Docker exports empty-string ARGs)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.resolveAppName(undefined)).toBe("App");
    expect(mod.resolveAppName("")).toBe("App");
  });

  it("passes through a configured name via the canonical web schema", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.resolveAppName("Acme")).toBe("Acme");
  });

  it("fails fast on names the client schema rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(() => mod.resolveAppName("x".repeat(81))).toThrow();
  });
});

describe("server env startup guards — SSO_CLIENT_SECRET entropy", () => {
  const STRONG_SSO_SECRET = "sS0oW9eA1kZ3cR4eT5vB6nM7qP8xY2zQ4uV0wE";

  function ssoWarning(warn: Mock) {
    return warn.mock.calls.some((call) => call.join(" ").includes("SSO_CLIENT_SECRET is weak"));
  }

  // One import per case: server.ts runs its guards as import-time side
  // effects, so a second import in the same test would hit the module cache
  // and never re-run them.
  it.each([["changeme"], ["my-secret-value"], ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]])(
    "warns in dev for placeholder SSO secret %s",
    async (placeholder) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await importServerEnv({ NODE_ENV: "development", SSO_CLIENT_SECRET: placeholder });
      expect(ssoWarning(warn)).toBe(true);
    },
  );

  it("throws in production for placeholder SSO secrets", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importServerEnv({ NODE_ENV: "production", SSO_CLIENT_SECRET: "changeme" }),
    ).rejects.toThrowError("SSO_CLIENT_SECRET is weak");
  });

  it("stays silent when SSO_CLIENT_SECRET is unset (SSO inert)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importServerEnv({ NODE_ENV: "development" });
    expect(ssoWarning(warn)).toBe(false);
  });

  it("stays silent for a strong SSO secret in dev and prod", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importServerEnv({
      NODE_ENV: "development",
      SSO_CLIENT_SECRET: STRONG_SSO_SECRET,
    });
    expect(ssoWarning(warn)).toBe(false);
    warn.mockClear();
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAILS: "admin@example.com",
      SSO_CLIENT_SECRET: STRONG_SSO_SECRET,
    });
    expect(mod.env.SSO_CLIENT_SECRET).toBe(STRONG_SSO_SECRET);
    expect(ssoWarning(warn)).toBe(false);
  });
});
