import { createRouterClient, type ORPCError } from "@orpc/server";
import type { Session } from "@starter/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@starter/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));
// The worker-safe env is a distinct module `@starter/db` pulls in
// transitively; mocking `@starter/env/server` alone does not suppress it.
vi.mock("@starter/env/shared", () => ({ env: {} }));

const { default: db } = await import("@starter/db");
const { projectsRouter } = await import("./projects");
const { invalidateForceTwoFactorSettingsCache } = await import("../lib/two-factor-policy");

const now = new Date("2026-09-17T00:00:00Z");

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  id: "project-1",
  name: "Repaint the shed",
  notes: null,
  createdAt: now,
  ...overrides,
});

function client(userId = "test-user-id") {
  const context: Context = {
    session: {
      user: {
        id: userId,
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: "auth-session",
        userId,
        token: "token",
        expiresAt: new Date("2027-01-01"),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
        updatedAt: now,
      },
    } as Session,
  };
  return createRouterClient(projectsRouter, { context });
}

async function expectNotFound(action: () => Promise<unknown>) {
  await expect(action()).rejects.toSatisfy((error: ORPCError) => error.code === "NOT_FOUND");
}

describe("projectsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `protectedProcedure` runs the forced-2FA policy, which reads AppSetting
    // through an in-process TTL cache — clear it so one test's rows cannot
    // satisfy the next test's gate.
    invalidateForceTwoFactorSettingsCache();
    db.appSetting.findMany.mockResolvedValue([]);
  });

  it("rejects an unauthenticated caller before touching the database", async () => {
    const anonymous = createRouterClient(projectsRouter, { context: { session: null } });
    await expect(anonymous.list({ limit: 20 })).rejects.toSatisfy(
      (error: ORPCError) => error.code === "UNAUTHORIZED",
    );
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  // The two properties that make a list safe: it is scoped in the QUERY, and it
  // is bounded by construction. Both are asserted on the args Prisma received,
  // because both live in the `where`/`take` rather than in the handler body.
  it("scopes the list to the caller and bounds it on a total order", async () => {
    db.project.findMany.mockResolvedValue([projectRow()]);

    const result = await client().list({ limit: 20 });

    // The `select` below is the disclosure boundary, and it is asserted as an
    // argument rather than inferred from the result: Prisma applies the
    // projection, so a deep mock hands back whatever the test put in. A
    // response assertion alone would pass for a handler that selected `*`.
    expect(result.items).toEqual([projectRow()]);
    expect(result.nextCursor).toBeNull();
    expect(db.project.findMany).toHaveBeenCalledWith({
      where: { AND: [{ ownerId: "test-user-id" }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // `limit + 1`: the lookahead row is how `hasMore` is detected.
      take: 21,
      select: { id: true, name: true, notes: true, createdAt: true },
    });
  });

  it("caps the page size at the input schema's ceiling", async () => {
    await expect(client().list({ limit: 500 })).rejects.toThrow();
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  // A keyset cursor compares values, so the page boundary survives deletion of
  // the row that anchored it — and the owner clause stays the first `AND`
  // member, where a cursor can never widen it away.
  it("keeps the owner scope while paging past the cursor row", async () => {
    db.project.findMany.mockResolvedValue([
      projectRow({ id: "project-2" }),
      projectRow({ id: "project-1" }),
    ]);
    const first = await client().list({ limit: 1 });
    expect(first.items.map(({ id }) => id)).toEqual(["project-2"]);
    expect(first.nextCursor).toBeTruthy();

    db.project.findMany.mockResolvedValue([projectRow({ id: "project-1" })]);
    const second = await client().list({ limit: 1, cursor: first.nextCursor as string });

    expect(second.items.map(({ id }) => id)).toEqual(["project-1"]);
    expect(db.project.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { ownerId: "test-user-id" },
            { OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: "project-2" } }] },
          ],
        },
      }),
    );
  });

  it("rejects a malformed cursor as input validation, not a 500", async () => {
    await expect(client().list({ limit: 20, cursor: "not-a-token" })).rejects.toThrow();
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  it("creates under the session's user and returns only the client projection", async () => {
    db.project.create.mockResolvedValue(projectRow({ notes: "Buy primer" }));

    const created = await client().create({ name: "Repaint the shed", notes: "Buy primer" });

    expect(created).toEqual(projectRow({ notes: "Buy primer" }));
    expect(db.project.create).toHaveBeenCalledWith({
      data: { ownerId: "test-user-id", name: "Repaint the shed", notes: "Buy primer" },
      select: { id: true, name: true, notes: true, createdAt: true },
    });
  });

  it("stores an omitted or emptied note as null, never as an empty string", async () => {
    db.project.create.mockResolvedValue(projectRow());

    await client().create({ name: "Repaint the shed" });
    // A textarea the user cleared arrives as "" — the same fact as "omitted",
    // and it must land in the column the same way.
    await client().create({ name: "Repaint the shed", notes: "   " });

    for (const call of db.project.create.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({ data: expect.objectContaining({ notes: null }) }),
      );
    }
  });

  it("refuses a blank name before writing anything", async () => {
    await expect(client().create({ name: "   " })).rejects.toThrow();
    expect(db.project.create).not.toHaveBeenCalled();
  });

  // Fail closed, and fail closed as NOT_FOUND: someone else's project must be
  // indistinguishable from one that does not exist, or the error code itself
  // becomes an existence oracle.
  it("hides a foreign project from update and delete without writing", async () => {
    db.project.findFirst.mockResolvedValue(null);
    const api = client();

    await expectNotFound(() => api.update({ id: "someone-elses", name: "Renamed" }));
    await expectNotFound(() => api.delete({ id: "someone-elses" }));

    expect(db.project.update).not.toHaveBeenCalled();
    expect(db.project.delete).not.toHaveBeenCalled();
  });

  // The ownership clause has to be in the QUERY. A handler that fetched by id
  // and compared afterwards would pass every other test in this file.
  it("merges the owner clause into the lookup itself", async () => {
    db.project.findFirst.mockResolvedValue({ id: "project-1" });
    db.project.update.mockResolvedValue(projectRow({ name: "Renamed" }));

    const updated = await client().update({ id: "project-1", name: "Renamed", notes: "Later" });

    expect(updated).toEqual(projectRow({ name: "Renamed" }));
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: "project-1" }, { ownerId: "test-user-id" }] },
      select: { id: true },
    });
    expect(db.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { name: "Renamed", notes: "Later" },
      select: { id: true, name: true, notes: true, createdAt: true },
    });
  });

  it("clears the note when an edit omits it", async () => {
    db.project.findFirst.mockResolvedValue({ id: "project-1" });
    db.project.update.mockResolvedValue(projectRow());

    await client().update({ id: "project-1", name: "Repaint the shed" });

    expect(db.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Repaint the shed", notes: null } }),
    );
  });

  it("deletes only after the owner-scoped lookup resolves", async () => {
    db.project.findFirst.mockResolvedValue({ id: "project-1" });
    db.project.delete.mockResolvedValue(projectRow());

    await expect(client().delete({ id: "project-1" })).resolves.toEqual({ success: true });

    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: "project-1" }, { ownerId: "test-user-id" }] },
      select: { id: true },
    });
    expect(db.project.delete).toHaveBeenCalledWith({ where: { id: "project-1" } });
  });
});
