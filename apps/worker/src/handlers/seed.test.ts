import type { SeedJobData } from "@starter/queue";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @starter/db/seed before importing the handler. The handler must not
// touch a real database in CI — it only orchestrates runSeed().
const runSeedMock = vi.fn();
vi.mock("@starter/db/seed", () => ({
  runSeed: () => runSeedMock(),
}));

// `@starter/queue/jobs` is the side-effect-free half — so the job schema the
// handler validates with is the real one while no socket is opened.
vi.mock("@starter/queue", async () => {
  const jobs = await import("@starter/queue/jobs");
  return { ...jobs };
});

/** Build a minimal fake BullMQ Job object for testing. */
function fakeJob(overrides?: Partial<Job<SeedJobData>>): Job<SeedJobData> {
  return {
    id: "seed-job-1",
    data: { requestedBy: "admin-user-id" },
    ...overrides,
  } as Job<SeedJobData>;
}

describe("handleSeedJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the seed summary plus a measured durationMs", async () => {
    const { handleSeedJob } = await import("./seed.js");
    runSeedMock.mockResolvedValue({ summary: ["Ensured admin user", "Seeded 3 posts"] });

    const result = await handleSeedJob(fakeJob());

    expect(runSeedMock).toHaveBeenCalledOnce();
    expect(result.summary).toEqual(["Ensured admin user", "Seeded 3 posts"]);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles an empty seed (stub) without error", async () => {
    const { handleSeedJob } = await import("./seed.js");
    runSeedMock.mockResolvedValue({ summary: [] });

    const result = await handleSeedJob(fakeJob());

    expect(result.summary).toEqual([]);
  });

  it("propagates seed failures to the caller (so the job is marked failed)", async () => {
    const { handleSeedJob } = await import("./seed.js");
    runSeedMock.mockRejectedValue(new Error("unique constraint violation"));

    await expect(handleSeedJob(fakeJob())).rejects.toThrow("unique constraint violation");
  });
});
