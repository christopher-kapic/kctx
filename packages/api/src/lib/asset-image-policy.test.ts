import { describe, expect, it } from "vitest";

import {
  classifyImageFile,
  isEmptyImageMime,
  libraryNeedsTranscode,
  scaleToMaxEdge,
} from "./asset-image-policy";

// Real `File` under Vitest's node environment (Node 18+ global), same pattern
// No canvas, no DOM.

function ftypFile(brand: string, name = "photo.bin"): File {
  const bytes = new Uint8Array(24);
  // [4..7] = "ftyp", [8..11] = major brand.
  const ascii = `????ftyp${brand}`;
  for (let i = 0; i < ascii.length; i++) bytes[i] = ascii.charCodeAt(i);
  return new File([bytes], name, { type: "" });
}

const MAX = { maxBytes: 10 * 1024 * 1024, maxDimension: 4096 };

describe("isEmptyImageMime", () => {
  it("treats empty, whitespace, and octet-stream as empty", () => {
    expect(isEmptyImageMime("")).toBe(true);
    expect(isEmptyImageMime("  ")).toBe(true);
    expect(isEmptyImageMime("application/octet-stream")).toBe(true);
    expect(isEmptyImageMime("Application/Octet-Stream")).toBe(true);
    expect(isEmptyImageMime("image/jpeg")).toBe(false);
  });
});

describe("classifyImageFile", () => {
  it("classifies by non-empty MIME first (no byte read needed)", async () => {
    const jpeg = new File([new Uint8Array(4)], "whatever.dat", { type: "image/jpeg" });
    await expect(classifyImageFile(jpeg)).resolves.toEqual({
      kind: "jpeg",
      mimeType: "image/jpeg",
      animatedLikely: false,
    });
    const heif = new File([new Uint8Array(4)], "x", { type: "image/heif" });
    await expect(classifyImageFile(heif)).resolves.toMatchObject({
      kind: "heic",
      mimeType: "image/heic",
    });
    const svg = new File(["<svg/>"], "x", { type: "image/svg+xml" });
    await expect(classifyImageFile(svg)).resolves.toMatchObject({ kind: "svg" });
  });

  it("classifies a confident non-image MIME as non-image without reading bytes", async () => {
    const pdf = new File([new Uint8Array(4)], "notes.pdf", { type: "application/pdf" });
    await expect(classifyImageFile(pdf)).resolves.toMatchObject({ kind: "non-image" });
  });

  it("falls back to the extension for empty MIME (.heic from Finder)", async () => {
    const file = new File([new Uint8Array(4)], "IMG_0001.HEIC", { type: "" });
    await expect(classifyImageFile(file)).resolves.toMatchObject({
      kind: "heic",
      mimeType: "image/heic",
    });
    const hif = new File([new Uint8Array(4)], "shot.hif", {
      type: "application/octet-stream",
    });
    await expect(classifyImageFile(hif)).resolves.toMatchObject({ kind: "heic" });
    const svg = new File(["<svg/>"], "logo.svg", { type: "" });
    await expect(classifyImageFile(svg)).resolves.toMatchObject({ kind: "svg" });
  });

  it("reads magic bytes only when MIME and extension both say nothing", async () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const jpeg = new File([jpegBytes], "upload", { type: "" });
    await expect(classifyImageFile(jpeg)).resolves.toMatchObject({
      kind: "jpeg",
      mimeType: "image/jpeg",
    });

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(
      classifyImageFile(new File([pngBytes], "upload", { type: "" })),
    ).resolves.toMatchObject({ kind: "png" });

    const gif = new TextEncoder().encode("GIF89a??");
    await expect(classifyImageFile(new File([gif], "upload", { type: "" }))).resolves.toMatchObject(
      { kind: "gif", animatedLikely: true },
    );

    const webp = new TextEncoder().encode("RIFF????WEBPVP8 ");
    await expect(
      classifyImageFile(new File([webp], "upload", { type: "" })),
    ).resolves.toMatchObject({ kind: "webp" });
  });

  it.each(["heic", "heix", "heim", "heis", "hevc", "hevx"])(
    "recognizes ftyp major brand %s as HEIC",
    async (brand) => {
      await expect(classifyImageFile(ftypFile(brand))).resolves.toMatchObject({
        kind: "heic",
        mimeType: "image/heic",
      });
    },
  );

  it("never treats mif1/msf1 as HEIC, and maps avif brands to avif", async () => {
    await expect(classifyImageFile(ftypFile("mif1"))).resolves.toMatchObject({
      kind: "non-image",
    });
    await expect(classifyImageFile(ftypFile("msf1"))).resolves.toMatchObject({
      kind: "non-image",
    });
    await expect(classifyImageFile(ftypFile("avif"))).resolves.toMatchObject({ kind: "avif" });
    await expect(classifyImageFile(ftypFile("avis"))).resolves.toMatchObject({ kind: "avif" });
  });

  it("classifies unknowable bytes as non-image", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "data", { type: "" });
    await expect(classifyImageFile(file)).resolves.toMatchObject({ kind: "non-image" });
  });

  it("normalizes the corrected MIME for empty-typed files (never octet-stream)", async () => {
    const file = new File([new Uint8Array(4)], "photo.heic", {
      type: "application/octet-stream",
    });
    const result = await classifyImageFile(file);
    expect(result.mimeType).toBe("image/heic");
  });
});

describe("scaleToMaxEdge", () => {
  it("returns the input unchanged when it already fits (never upscales)", () => {
    expect(scaleToMaxEdge(800, 600, 4096)).toEqual({ width: 800, height: 600 });
    expect(scaleToMaxEdge(4096, 4096, 4096)).toEqual({ width: 4096, height: 4096 });
  });

  it("contain-fits the long edge and preserves aspect", () => {
    expect(scaleToMaxEdge(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(scaleToMaxEdge(4096, 8192, 4096)).toEqual({ width: 2048, height: 4096 });
    // 48MP-ish portrait: 6000x8000 → long edge 8000 → scale 0.512.
    expect(scaleToMaxEdge(6000, 8000, 4096)).toEqual({ width: 3072, height: 4096 });
  });

  it("never returns a dimension below 1", () => {
    expect(scaleToMaxEdge(100_000, 1, 4096)).toEqual({ width: 4096, height: 1 });
  });
});

describe("libraryNeedsTranscode", () => {
  it("never transcodes non-image or svg (handled upstream)", () => {
    for (const kind of ["non-image", "svg"] as const) {
      expect(
        libraryNeedsTranscode({
          size: 99 * 1024 * 1024,
          width: null,
          height: null,
          ...MAX,
          kind,
          nativeDecoded: false,
          animatedLikely: false,
        }),
      ).toBe(false);
    }
  });

  it("keeps an in-cap JPEG/PNG/WebP/AVIF and in-cap GIF (animation preserved)", () => {
    for (const kind of ["jpeg", "png", "webp", "avif", "gif"] as const) {
      expect(
        libraryNeedsTranscode({
          size: 2 * 1024 * 1024,
          width: 2000,
          height: 1500,
          ...MAX,
          kind,
          nativeDecoded: true,
          animatedLikely: kind === "gif",
        }),
      ).toBe(false);
    }
  });

  it("transcodes anything over the byte cap — including an animated GIF (flatten)", () => {
    expect(
      libraryNeedsTranscode({
        size: 14 * 1024 * 1024,
        width: 2000,
        height: 1500,
        ...MAX,
        kind: "gif",
        nativeDecoded: true,
        animatedLikely: true,
      }),
    ).toBe(true);
    expect(
      libraryNeedsTranscode({
        size: 14 * 1024 * 1024,
        width: null,
        height: null,
        ...MAX,
        kind: "jpeg",
        nativeDecoded: true,
        animatedLikely: false,
      }),
    ).toBe(true);
  });

  it("transcodes when the long edge exceeds maxDimension", () => {
    expect(
      libraryNeedsTranscode({
        size: 5 * 1024 * 1024,
        width: 6000,
        height: 4000,
        ...MAX,
        kind: "jpeg",
        nativeDecoded: true,
        animatedLikely: false,
      }),
    ).toBe(true);
  });

  it("keeps a natively-decoded in-cap HEIC (Safari) but transcodes when native decode failed", () => {
    const base = {
      size: 3 * 1024 * 1024,
      width: 3000,
      height: 2000,
      ...MAX,
      kind: "heic" as const,
      animatedLikely: false,
    };
    expect(libraryNeedsTranscode({ ...base, nativeDecoded: true })).toBe(false);
    expect(libraryNeedsTranscode({ ...base, nativeDecoded: false })).toBe(true);
  });

  it("ignores unknown dimensions (null) for the edge check", () => {
    expect(
      libraryNeedsTranscode({
        size: 1024,
        width: null,
        height: null,
        ...MAX,
        kind: "jpeg",
        nativeDecoded: true,
        animatedLikely: false,
      }),
    ).toBe(false);
  });
});
