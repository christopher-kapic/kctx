import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetMeta } from "./assets";
import type { TransformParams } from "./images";

// Mutable env mock so the kill-switch and variant-cap tests can flip values at
// runtime (the module reads them per call, not at import).
const env = { IMAGE_TRANSFORM_CACHE: true, IMAGE_TRANSFORM_CACHE_MAX_VARIANTS: 32 };
vi.mock("@starter/env/server", () => ({ env }));

// Fully mock ./images so no native sharp load is needed in CI. imageTransformETag
// stays deterministic so transformCacheKey (real) produces a stable key.
//
// `normalizeTransformParams` is stubbed to just the format default rather than
// the real ladders, for the same reason: these tests are about the cache's
// behaviour around a key, not about what the key contains. The ladders are
// covered in images.test.ts. It must be listed here even though only the format
// is used — `transformCacheKey` derives the extension from it, and a missing
// export is a hard vitest error rather than a silent undefined.
const transformImage = vi.fn();
vi.mock("./images", () => ({
  imageTransformETag: (id: string, params: TransformParams) =>
    `"img:${id}:${params.format ?? "webp"}"`,
  normalizeTransformParams: (params: TransformParams) => ({
    width: params.width,
    height: params.height,
    quality: params.quality ?? 80,
    format: params.format ?? "webp",
  }),
  transformImage,
}));

const readAssetObject = vi.fn();
vi.mock("./assets", () => ({ readAssetObject }));

const getStorageObject = vi.fn();
const putStorageObject = vi.fn();
const listStorageObjects = vi.fn();
vi.mock("./storage", () => ({
  getStorageObject,
  putStorageObject,
  listStorageObjects,
  storage: { bucket: "test", client: {}, keyPrefix: "" },
}));

const { getOrCreateTransform, resetImageTransformCacheState, transformCacheKey } = await import(
  "./image-transform-cache"
);

/** Build a listStorageObjects implementation yielding `count` variant keys. */
function listYielding(count: number) {
  return async function* () {
    for (let i = 0; i < count; i++) {
      yield { key: `transforms/asset-1/${i}.webp` };
    }
  };
}

const meta = { id: "asset-1", storageKey: "assets/asset-1" } as AssetMeta;
const params: TransformParams = { format: "webp", width: 100 };

function transformed() {
  return { body: Buffer.from("transformed-bytes"), contentType: "image/webp" };
}

describe("getOrCreateTransform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetImageTransformCacheState();
    env.IMAGE_TRANSFORM_CACHE = true;
    env.IMAGE_TRANSFORM_CACHE_MAX_VARIANTS = 32;
    readAssetObject.mockResolvedValue({ body: Buffer.from("source"), contentType: "image/png" });
    transformImage.mockResolvedValue(transformed());
    listStorageObjects.mockImplementation(listYielding(0));
  });

  it("transforms once and writes the result back on a cache miss", async () => {
    getStorageObject.mockResolvedValue(null);

    const result = await getOrCreateTransform(meta, params);

    expect(result.contentType).toBe("image/webp");
    expect(transformImage).toHaveBeenCalledTimes(1);
    expect(putStorageObject).toHaveBeenCalledTimes(1);
    expect(putStorageObject).toHaveBeenCalledWith(
      transformCacheKey(meta.id, params),
      expect.any(Buffer),
      "image/webp",
    );
    // The derived key lives under the transforms/ prefix, never assets/.
    expect(transformCacheKey(meta.id, params)).toMatch(/^transforms\/asset-1\/[0-9a-f]{16}\.webp$/);
  });

  it("serves from storage on a cache hit without reading the source or transforming", async () => {
    getStorageObject.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/avif",
      contentLength: 3,
    });

    const result = await getOrCreateTransform(meta, params);

    expect(result.contentType).toBe("image/avif");
    expect(result.body).toBeInstanceOf(Buffer);
    expect(readAssetObject).not.toHaveBeenCalled();
    expect(transformImage).not.toHaveBeenCalled();
    expect(putStorageObject).not.toHaveBeenCalled();
  });

  it("dedupes two concurrent misses for the same key into a single transform", async () => {
    getStorageObject.mockResolvedValue(null);

    const [a, b] = await Promise.all([
      getOrCreateTransform(meta, params),
      getOrCreateTransform(meta, params),
    ]);

    expect(a.contentType).toBe("image/webp");
    expect(b.contentType).toBe("image/webp");
    expect(transformImage).toHaveBeenCalledTimes(1);
    expect(getStorageObject).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight entry after completion so a later miss re-runs", async () => {
    getStorageObject.mockResolvedValue(null);

    await getOrCreateTransform(meta, params);
    await getOrCreateTransform(meta, params);

    // Two sequential calls both miss (cache read mocked empty), so both must
    // reach the transform — proving the dedup entry didn't outlive call one.
    expect(getStorageObject).toHaveBeenCalledTimes(2);
    expect(transformImage).toHaveBeenCalledTimes(2);
  });

  it("still returns the transformed bytes when the write-back fails", async () => {
    getStorageObject.mockResolvedValue(null);
    putStorageObject.mockRejectedValue(new Error("S3 down"));

    const result = await getOrCreateTransform(meta, params);

    expect(result.contentType).toBe("image/webp");
    expect(transformImage).toHaveBeenCalledTimes(1);
  });

  it("skips the write-back once the per-asset variant cap is reached", async () => {
    getStorageObject.mockResolvedValue(null);
    env.IMAGE_TRANSFORM_CACHE_MAX_VARIANTS = 2;
    listStorageObjects.mockImplementation(listYielding(2));

    const result = await getOrCreateTransform(meta, params);

    expect(result.contentType).toBe("image/webp");
    expect(transformImage).toHaveBeenCalledTimes(1);
    expect(putStorageObject).not.toHaveBeenCalled();
  });

  it("counts existing variants once per asset, then tracks writes in memory", async () => {
    getStorageObject.mockResolvedValue(null);

    await getOrCreateTransform(meta, { format: "webp", width: 100 });
    await getOrCreateTransform(meta, { format: "avif", width: 100 });

    // One LIST for the first miss; the second write reuses the memoized count.
    expect(listStorageObjects).toHaveBeenCalledTimes(1);
    expect(putStorageObject).toHaveBeenCalledTimes(2);
  });

  it("still returns the transformed bytes when the variant-cap LIST fails", async () => {
    getStorageObject.mockResolvedValue(null);
    listStorageObjects.mockImplementation(() => {
      throw new Error("S3 LIST down");
    });

    const result = await getOrCreateTransform(meta, params);

    expect(result.contentType).toBe("image/webp");
    expect(putStorageObject).not.toHaveBeenCalled();
  });

  it("neither reads nor writes the cache when IMAGE_TRANSFORM_CACHE is false", async () => {
    env.IMAGE_TRANSFORM_CACHE = false;

    const result = await getOrCreateTransform(meta, params);

    expect(result.contentType).toBe("image/webp");
    expect(readAssetObject).toHaveBeenCalledTimes(1);
    expect(transformImage).toHaveBeenCalledTimes(1);
    expect(getStorageObject).not.toHaveBeenCalled();
    expect(putStorageObject).not.toHaveBeenCalled();
  });
});
