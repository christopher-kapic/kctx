import type { ReapExpiredAuthTokensJobData } from "@starter/queue";
import type { Job } from "bullmq";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
// Real `@starter/queue` constructs BullMQ Queues at import (IORedis sockets), but
// `@starter/queue/jobs` is the side-effect-free half — so the job schema the
// handler validates with is the real one while no socket is opened.
vi.mock("@starter/queue", async () => {
  const jobs = await import("@starter/queue/jobs");
  return { ...jobs };
});

const { default: prisma } = await import("@starter/db");
const { handleReapExpiredAuthTokensJob } = await import("./reap-expired-auth-tokens.js");

const db = prisma as unknown as {
  session: { findMany: MockInstance; deleteMany: MockInstance };
  verification: { findMany: MockInstance; deleteMany: MockInstance };
};

const job = () =>
  ({ id: "job-1", data: { reason: "cron" } }) as unknown as Job<ReapExpiredAuthTokensJobData>;

function primeEmptySweeps() {
  db.session.findMany.mockResolvedValue([]);
  db.verification.findMany.mockResolvedValue([]);
}

describe("handleReapExpiredAuthTokensJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    primeEmptySweeps();
  });

  it("deletes only rows past expiresAt, per model, and reports the counts", async () => {
    const before = Date.now();
    db.session.findMany.mockResolvedValueOnce([{ id: "session-1" }, { id: "session-2" }]);
    db.session.deleteMany.mockResolvedValueOnce({ count: 2 });
    db.verification.findMany.mockResolvedValueOnce([{ id: "verification-1" }]);
    db.verification.deleteMany.mockResolvedValueOnce({ count: 1 });

    await expect(handleReapExpiredAuthTokensJob(job())).resolves.toEqual({
      reason: "cron",
      deleted: { sessions: 2, verifications: 1 },
    });

    for (const model of [db.session, db.verification]) {
      const where = model.findMany.mock.calls[0]?.[0]?.where;
      expect(where.expiresAt.lt).toBeInstanceOf(Date);
      expect((where.expiresAt.lt as Date).getTime()).toBeGreaterThanOrEqual(before);
    }
    expect(db.session.findMany.mock.calls[0]?.[0]).toMatchObject({
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: 1000,
    });

    // Deletes are bounded id-page deletes, never a naked deleteMany.
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["session-1", "session-2"] } },
    });
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["verification-1"] } },
    });
  });

  it("keeps paging a model until a short page, without touching the others", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ id: `session-${i}` }));
    db.session.findMany
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([{ id: "session-tail" }]);
    db.session.deleteMany
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(handleReapExpiredAuthTokensJob(job())).resolves.toMatchObject({
      deleted: { sessions: 1001 },
    });

    expect(db.session.findMany).toHaveBeenCalledTimes(2);
    expect(db.session.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: fullPage.map((row) => row.id) } },
    });
    expect(db.session.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["session-tail"] } },
    });
    // The short page (1 < 1000) ended the session sweep after two pages.

    expect(db.verification.findMany).toHaveBeenCalledTimes(1);
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("reports zero across the board when nothing has expired", async () => {
    await expect(handleReapExpiredAuthTokensJob(job())).resolves.toEqual({
      reason: "cron",
      deleted: { sessions: 0, verifications: 0 },
    });
    expect(db.session.deleteMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a payload the schema does not describe", async () => {
    const bad = {
      id: "job-2",
      data: { reason: "admin" },
    } as unknown as Job<ReapExpiredAuthTokensJobData>;

    await expect(handleReapExpiredAuthTokensJob(bad)).rejects.toThrow();
    expect(db.session.findMany).not.toHaveBeenCalled();
  });
});
