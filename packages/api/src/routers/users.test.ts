import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@starter/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Mock @starter/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@starter/env/server", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
  ADMIN_EMAILS: new Set<string>(),
}));

// Mock @starter/auth so the router's `auth.api.createUser` call hits a stub
// instead of pulling in the real better-auth (which needs an env, prisma, etc).
vi.mock("@starter/auth", () => ({
  auth: {
    api: {
      createUser: vi.fn(),
    },
  },
}));

// Mock @starter/mailer so invites don't try to open SMTP. Tests assert on the
// call shape via the mock instead. `renderInviteUser` is stubbed to return a
// stable subject/html so the router can pass them straight through to
// `sendEmail` — the actual rendering is tested in the mailer package.
vi.mock("@starter/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({
    subject: "You've been invited",
    html: "<html><body>invite</body></html>",
  })),
}));

const { default: prisma } = await import("@starter/db");
const { auth } = await import("@starter/auth");
const { sendEmail } = await import("@starter/mailer");

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
    findMany: MockInstance;
    count: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  session: { deleteMany: MockInstance };
  $transaction: MockInstance;
};

const authApi = auth as unknown as {
  api: { createUser: MockInstance };
};
const sendEmailMock = sendEmail as unknown as MockInstance;

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };
  return {
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("usersRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("auth gates", () => {
    it("list throws NOT_FOUND when no session", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext(null) });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("list throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("invite throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.invite({ email: "x@example.com", name: "X" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns users + nextCursor without a search filter", async () => {
      db.user.findMany.mockResolvedValue([
        { id: "1", email: "a@x.com", name: "A", role: "user", createdAt: new Date("2025-01-01") },
      ]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(res.users).toHaveLength(1);
      expect(res.nextCursor).toBeNull();
      // No cursor on the first page: the filter stands alone in the AND.
      expect(db.user.findMany.mock.calls[0]?.[0].where).toEqual({ AND: [{}] });
      // Never a per-page count — the UI is an infinite list.
      expect(db.user.count).not.toHaveBeenCalled();
    });

    it("takes limit + 1 to detect hasMore and mints a cursor for a full page", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({
        id: `u-${i}`,
        email: `u${i}@x.com`,
        name: `U ${i}`,
        role: "user",
        createdAt: new Date("2025-01-01"),
      }));
      db.user.findMany.mockResolvedValue(rows);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list({ limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
      expect(res.users).toHaveLength(10);
      expect(res.nextCursor).toEqual(expect.any(String));
    });

    it("applies a case-insensitive OR search across name and email", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ search: "alice", limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            OR: [
              { email: { contains: "alice", mode: "insensitive" } },
              { name: { contains: "alice", mode: "insensitive" } },
            ],
          },
        ],
      });
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
    });

    it("rejects a malformed cursor", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(db.user.findMany).not.toHaveBeenCalled();
    });

    it("filters archived users in the database (banned=true)", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ banned: true }] });
    });

    it("treats active as not-banned, including NULL banned", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "active" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ OR: [{ banned: false }, { banned: null }] }] });
    });

    it("combines status and search with AND", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived", search: "alice" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            AND: [
              { banned: true },
              {
                OR: [
                  { email: { contains: "alice", mode: "insensitive" } },
                  { name: { contains: "alice", mode: "insensitive" } },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  describe("invite", () => {
    it("creates the user via better-auth and emails them on success", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "NEW@example.com",
        name: "New User",
        role: "user",
      });

      expect(res.userId).toBe("new-user-id");
      expect(res.tempPassword).toEqual(expect.any(String));
      expect(res.tempPassword.length).toBeGreaterThan(8);
      expect(res.emailSent).toBe(true);
      // Email should be lowercased by the input zod schema.
      expect(authApi.api.createUser).toHaveBeenCalledWith({
        body: {
          email: "new@example.com",
          name: "New User",
          password: res.tempPassword,
          role: "user",
        },
      });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@example.com" }),
      );
    });

    it("returns emailSent=false when SMTP throws but the user was still created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("SMTP not configured"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
      });

      expect(res.emailSent).toBe(false);
      expect(res.userId).toBe("new-user-id");
    });

    it("translates a duplicate-email error into a CONFLICT", async () => {
      authApi.api.createUser.mockRejectedValue(new Error("User already exists"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "dup@example.com", name: "Dup" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("CONFLICT");
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        new Error("Sign-up is currently disabled. Contact an admin if you need access."),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "new@example.com", name: "New User" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("BAD_REQUEST");
          expect(e.message).toMatch(/account creation is disabled/i);
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("setRole", () => {
    it("updates the role on a different user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "other-user-id", role: "admin" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { role: "admin" },
      });
    });

    it("blocks the admin from demoting themselves", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "admin-user-id", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          expect(e.message).toMatch(/own admin role/i);
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("allows promoting yourself to admin (no-op safety net)", async () => {
      // Even though the admin is already admin, the schema allows the call.
      // We only block demotion of self — promoting yourself is harmless.
      db.user.findUnique.mockResolvedValue({ id: "admin-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "admin-user-id", role: "admin" });
      expect(res).toEqual({ success: true });
    });

    it("throws NOT_FOUND for an unknown user id", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "missing", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });

  describe("archive", () => {
    it("bans the user and revokes their sessions in a transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.$transaction.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true });
      expect(db.$transaction).toHaveBeenCalledOnce();
    });

    it("blocks self-archive", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.archive({ userId: "admin-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          return true;
        },
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("unarchive", () => {
    it("clears banned + banReason + banExpires", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { banned: false, banReason: null, banExpires: null },
      });
    });
  });

  describe("remove", () => {
    it("hard-deletes when no FK constraint blocks it", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "other-user-id" } });
    });

    it("blocks self-delete", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "admin-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("converts a Prisma FK constraint error into a CONFLICT with archive guidance", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(
        new Error("Foreign key constraint violated on the field: `Post_authorId_fkey`"),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        expect(e.message).toMatch(/archive/i);
        return true;
      });
    });
  });
});
