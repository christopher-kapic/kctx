import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const deleteStorageObject = vi.fn().mockResolvedValue(undefined);
const deleteStorageObjects = vi.fn(async (keys: string[]) => ({ deleted: keys, errors: [] }));
const listStorageObjects = vi.fn(async function* () {});
const listIncompleteMultipartUploads = vi.fn(async function* () {});
const abortMultipartUpload = vi.fn();

vi.mock("./storage", () => ({
  abortMultipartUpload,
  deleteStorageObject,
  deleteStorageObjects,
  listIncompleteMultipartUploads,
  listStorageObjects,
  storage: { bucket: "test", client: {}, keyPrefix: "" },
}));

const { default: prisma } = await import("@starter/db");
const { dryRunCleanup, parseTransformAssetId, runCleanup } = await import("./asset-cleanup");

const db = prisma as unknown as {
  asset: {
    findMany: MockInstance;
    findUnique: MockInstance;
    deleteMany: MockInstance;
  };
};

// biome-ignore lint/suspicious/noExplicitAny: test-only Prisma arg shape.
type FindManyArgs = any;

function setupDb(liveIds: string[] = []) {
  db.asset.findMany.mockImplementation(async (args: FindManyArgs) => {
    const where = args?.where ?? {};
    const select = args?.select ?? {};
    if (where.status === "PENDING") return []; // phase 1 pending rows
    if (where.id?.in) {
      // phase 4 run: live-id lookup for a batch of transform variants
      return liveIds.filter((id) => where.id.in.includes(id)).map((id) => ({ id }));
    }
    if (where.storageKey?.in) return []; // phase 2 run batch
    if (select.id) return liveIds.map((id) => ({ id })); // loadKnownAssetIds (dry run)
    if (select.storageKey) return []; // loadKnownStorageKeys (dry run)
    return [];
  });
  db.asset.findUnique.mockResolvedValue(null);
  db.asset.deleteMany.mockResolvedValue({ count: 0 });
}

const OLD = new Date("2026-01-01");

function transformOnly(entries: { key: string; size: number; lastModified: Date }[]) {
  listStorageObjects.mockImplementation(async function* (prefix: string) {
    if (prefix === "transforms/") {
      for (const entry of entries) yield entry;
    }
  });
}

describe("runCleanup — orphan transform variants (phase 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listStorageObjects.mockImplementation(async function* () {});
    setupDb();
  });

  it("deletes a variant whose source asset no longer exists", async () => {
    transformOnly([{ key: "transforms/asset-gone/abcd0123.webp", size: 10, lastModified: OLD }]);

    const result = await runCleanup({ objectMinAgeMs: 1 });

    expect(result.orphanTransformsDeleted).toBe(1);
    expect(result.bytesFreed).toBe(10);
    expect(deleteStorageObjects).toHaveBeenCalledWith(["transforms/asset-gone/abcd0123.webp"]);
  });

  it("keeps a variant whose source asset row still exists", async () => {
    transformOnly([{ key: "transforms/asset-live/abcd0123.webp", size: 10, lastModified: OLD }]);
    setupDb(["asset-live"]);

    const result = await runCleanup({ objectMinAgeMs: 1 });

    expect(result.orphanTransformsDeleted).toBe(0);
    expect(deleteStorageObjects).not.toHaveBeenCalled();
  });

  it("skips a freshly written variant inside the grace window", async () => {
    transformOnly([
      { key: "transforms/asset-gone/abcd0123.webp", size: 10, lastModified: new Date() },
    ]);

    const result = await runCleanup({ objectMinAgeMs: 15 * 60 * 1000 });

    expect(result.orphanTransformsDeleted).toBe(0);
    expect(deleteStorageObjects).not.toHaveBeenCalled();
  });
});

describe("dryRunCleanup — orphan transform variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listStorageObjects.mockImplementation(async function* () {});
    setupDb();
  });

  it("reports orphan variants without deleting them", async () => {
    transformOnly([{ key: "transforms/asset-gone/abcd0123.webp", size: 42, lastModified: OLD }]);

    const summary = await dryRunCleanup({ objectMinAgeMs: 1 });

    expect(summary.orphanTransforms.count).toBe(1);
    expect(summary.orphanTransforms.bytes).toBe(42);
    expect(summary.orphanTransforms.sample[0]?.kind).toBe("orphan-transform");
    expect(deleteStorageObjects).not.toHaveBeenCalled();
  });
});

describe("parseTransformAssetId", () => {
  it("extracts the asset id from a transform key", () => {
    expect(parseTransformAssetId("transforms/asset-1/abcd0123.webp")).toBe("asset-1");
  });

  it("returns null for non-transform keys", () => {
    expect(parseTransformAssetId("assets/asset-1")).toBeNull();
    expect(parseTransformAssetId("transforms/")).toBeNull();
    expect(parseTransformAssetId("transforms/only-two")).toBeNull();
  });
});
