import { describe, expect, it, vi } from "vitest";

// sharp is a native module and `@starter/env/server` validates the real
// process env; neither is needed to exercise the pure normalization helpers,
// and loading them would make this file fail in a bare CI container. Same
// reasoning as the mock in image-transform-cache.test.ts.
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@starter/env/server", () => ({
  env: { IMAGE_TRANSFORM_MAX_INPUT_PIXELS: 268402689 },
}));

const { imageTransformETag, normalizeTransformParams } = await import("./images");

describe("normalizeTransformParams — dimension ladder", () => {
  it("snaps a requested width UP to the next rung", () => {
    // 800 is not a rung; 828 is the first one that can contain it. Snapping up
    // (not down) means the delivered image is never smaller than asked for.
    expect(normalizeTransformParams({ width: 800 }).width).toBe(828);
  });

  it("leaves an exact rung untouched", () => {
    expect(normalizeTransformParams({ width: 1080 }).width).toBe(1080);
  });

  it("collapses the whole ?w=1..127 range onto one identity", () => {
    // This is the attack that motivated the ladder: 127 requests that used to
    // mint 127 distinct cache entries now mint one. The range runs to the rung
    // below 128 rather than stopping early, so the assertion actually covers the
    // claim in the title.
    const identities = new Set(
      Array.from({ length: 127 }, (_, i) => imageTransformETag("asset-1", { width: i + 1 })),
    );
    expect(identities.size).toBe(1);
    expect(normalizeTransformParams({ width: 1 }).width).toBe(128);
    // 128 is the boundary: it belongs to the same bucket, 129 must not.
    expect(imageTransformETag("asset-1", { width: 128 })).toBe(
      imageTransformETag("asset-1", { width: 1 }),
    );
    expect(imageTransformETag("asset-1", { width: 129 })).not.toBe(
      imageTransformETag("asset-1", { width: 1 }),
    );
  });

  it("snaps width and height independently", () => {
    // Each dimension walks the ladder on its own, so a request can land on two
    // different rungs. A shared-rung bug would be invisible to the single-axis
    // cases above.
    const n = normalizeTransformParams({ width: 200, height: 900 });
    expect(n.width).toBe(256);
    expect(n.height).toBe(1080);
  });

  it("caps above the top rung rather than growing the space", () => {
    expect(normalizeTransformParams({ width: 99999 }).width).toBe(4096);
    expect(imageTransformETag("a", { width: 9999 })).toBe(imageTransformETag("a", { width: 4096 }));
  });

  it("applies the same ladder to height", () => {
    expect(normalizeTransformParams({ height: 700 }).height).toBe(750);
  });

  it("keeps an absent dimension absent", () => {
    const n = normalizeTransformParams({});
    expect(n.width).toBeUndefined();
    expect(n.height).toBeUndefined();
  });

  it("treats zero and negative dimensions as absent, not as a rung", () => {
    expect(normalizeTransformParams({ width: 0 }).width).toBeUndefined();
    expect(normalizeTransformParams({ width: -50 }).width).toBeUndefined();
  });
});

describe("normalizeTransformParams — quality and format", () => {
  it("snaps quality up to a bucket", () => {
    expect(normalizeTransformParams({ quality: 61 }).quality).toBe(80);
    expect(normalizeTransformParams({ quality: 81 }).quality).toBe(95);
  });

  it("collapses q=96..100 onto the top bucket", () => {
    // The most surprising user-visible consequence of the ladder: `?q=100` is a
    // legal input (clampQuality allows it) but there is no rung above 95, so it
    // falls through to the top one. Documented in patterns/assets.md; asserted
    // here so it can't change silently.
    expect(normalizeTransformParams({ quality: 100 }).quality).toBe(95);
    expect(normalizeTransformParams({ quality: 96 }).quality).toBe(95);
  });

  it("collapses q=1..60 onto the bottom bucket", () => {
    expect(normalizeTransformParams({ quality: 1 }).quality).toBe(60);
    expect(normalizeTransformParams({ quality: 60 }).quality).toBe(60);
  });

  it("defaults quality to 80 and format to webp", () => {
    const n = normalizeTransformParams({});
    expect(n.quality).toBe(80);
    expect(n.format).toBe("webp");
  });

  it("preserves an explicit format", () => {
    expect(normalizeTransformParams({ format: "avif" }).format).toBe("avif");
  });
});

describe("imageTransformETag", () => {
  it("separates assets, formats, and distinct rungs", () => {
    const base = imageTransformETag("asset-1", { width: 640 });
    expect(imageTransformETag("asset-2", { width: 640 })).not.toBe(base);
    expect(imageTransformETag("asset-1", { width: 640, format: "avif" })).not.toBe(base);
    expect(imageTransformETag("asset-1", { width: 1080 })).not.toBe(base);
  });

  it("is a strong validator in quoted form", () => {
    expect(imageTransformETag("asset-1", { width: 640 })).toMatch(/^"img:.*"$/);
  });
});
