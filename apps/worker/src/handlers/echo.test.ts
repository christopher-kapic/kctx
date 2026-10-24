import type { EchoJobData } from "@starter/queue";
import type { Job } from "bullmq";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @starter/db before importing the handler
vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// `@starter/queue/jobs` is the side-effect-free half — so the job schema the
// handler validates with is the real one while no socket is opened.
vi.mock("@starter/queue", async () => {
  const jobs = await import("@starter/queue/jobs");
  return { ...jobs };
});

// Re-import the mocked module so we can configure return values
const { default: prisma } = await import("@starter/db");

// Type-safe handle to the mocked Prisma methods
const db = prisma as unknown as {
  appSetting: {
    upsert: MockInstance;
  };
};

/** Build a minimal fake BullMQ Job object for testing. */
function fakeJob(overrides?: Partial<Job<EchoJobData>>): Job<EchoJobData> {
  return {
    id: "test-job-1",
    data: { message: "hello world" },
    ...overrides,
  } as Job<EchoJobData>;
}

describe("handleEchoJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the echo message under the single fixed key", async () => {
    const { handleEchoJob } = await import("./echo.js");

    db.appSetting.upsert.mockResolvedValue({
      key: "echo:last",
      value: "hello world",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = fakeJob();
    const result = await handleEchoJob(job);

    expect(result).toEqual({ echoed: "hello world" });
    expect(db.appSetting.upsert).toHaveBeenCalledOnce();
    expect(db.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: "echo:last" },
      update: { value: "hello world" },
      create: { key: "echo:last", value: "hello world" },
    });
  });

  it("overwrites the same row on repeated runs instead of accumulating keys", async () => {
    const { handleEchoJob } = await import("./echo.js");

    db.appSetting.upsert.mockResolvedValue({
      key: "echo:last",
      value: "second",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await handleEchoJob(fakeJob({ id: "job-1", data: { message: "first" } }));
    await handleEchoJob(fakeJob({ id: "job-2", data: { message: "second" } }));

    expect(db.appSetting.upsert).toHaveBeenCalledTimes(2);
    expect(db.appSetting.upsert).toHaveBeenNthCalledWith(1, {
      where: { key: "echo:last" },
      update: { value: "first" },
      create: { key: "echo:last", value: "first" },
    });
    expect(db.appSetting.upsert).toHaveBeenNthCalledWith(2, {
      where: { key: "echo:last" },
      update: { value: "second" },
      create: { key: "echo:last", value: "second" },
    });
  });

  it("propagates Prisma errors to the caller", async () => {
    const { handleEchoJob } = await import("./echo.js");

    db.appSetting.upsert.mockRejectedValue(new Error("DB connection lost"));

    const job = fakeJob();

    await expect(handleEchoJob(job)).rejects.toThrow("DB connection lost");
  });
});
