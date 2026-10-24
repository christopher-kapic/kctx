import { afterEach, describe, expect, it, vi } from "vitest";

import { computeImageHint } from "./asset-image-hint";

// Node has neither createImageBitmap nor OffscreenCanvas — stub both on
// globalThis. Real `File` (Node 18+ global)
// pattern; no real canvas or decoding anywhere.

type FakeBitmap = { width: number; height: number; close: () => void };

function makeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

function stubCanvas() {
  class FakeOffscreenCanvas {
    getContext() {
      return {
        drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
      };
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("computeImageHint", () => {
  it("returns null for a PDF without ever calling createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    stubCanvas();

    const pdf = new File([new Uint8Array(8)], "notes.pdf", { type: "application/pdf" });
    await expect(computeImageHint(pdf)).resolves.toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it("returns null for SVG without decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    stubCanvas();

    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    await expect(computeImageHint(svg)).resolves.toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it("lets an empty-typed .heic reach the decoder (classifier gate, not file.type)", async () => {
    const decode = vi.fn().mockRejectedValue(new Error("no HEVC decoder"));
    vi.stubGlobal("createImageBitmap", decode);
    stubCanvas();

    const heic = new File([new Uint8Array(8)], "IMG_0001.heic", { type: "" });
    // Chrome/Firefox can't decode HEIC natively and the hint never loads
    // WASM — so the result is null, but only after a decode attempt.
    await expect(computeImageHint(heic)).resolves.toBeNull();
    expect(decode).toHaveBeenCalled();
    expect(decode.mock.calls[0]?.[0]).toBeInstanceOf(File);
  });

  it("decodes at the 32px sample size when resize options are accepted", async () => {
    const bitmap = makeBitmap(32, 24);
    const decode = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    stubCanvas();

    const jpeg = new File([new Uint8Array(8)], "photo.jpg", { type: "image/jpeg" });
    const hint = await computeImageHint(jpeg);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0]?.[1]).toMatchObject({
      resizeWidth: 32,
      imageOrientation: "from-image",
    });
    // A resized bitmap can't reveal intrinsic dimensions — the analyze-asset
    // worker fills them in server-side.
    expect(hint).toMatchObject({ width: null, height: null });
    expect(typeof hint?.blurhash).toBe("string");
    expect(hint?.blurhash.length).toBeGreaterThan(0);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("falls back to an optionless decode (with intrinsic dims) when resize options are rejected", async () => {
    const bitmap = makeBitmap(4000, 3000);
    const decode = vi
      .fn()
      .mockImplementation((_file: File, options?: ImageBitmapOptions) =>
        options ? Promise.reject(new Error("options not supported")) : Promise.resolve(bitmap),
      );
    vi.stubGlobal("createImageBitmap", decode);
    stubCanvas();

    const jpeg = new File([new Uint8Array(8)], "photo.jpg", { type: "image/jpeg" });
    const hint = await computeImageHint(jpeg);

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls[1]?.length).toBe(1);
    expect(hint).toMatchObject({ width: 4000, height: 3000 });
    expect(typeof hint?.blurhash).toBe("string");
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("returns null when every decode attempt fails", async () => {
    const decode = vi.fn().mockRejectedValue(new Error("undecodable"));
    vi.stubGlobal("createImageBitmap", decode);
    stubCanvas();

    const png = new File([new Uint8Array(8)], "corrupt.png", { type: "image/png" });
    await expect(computeImageHint(png)).resolves.toBeNull();
  });

  it("returns null (never throws) when no canvas context is reachable", async () => {
    const bitmap = makeBitmap(32, 24);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    // No OffscreenCanvas stub and no document in Node → no context.

    const jpeg = new File([new Uint8Array(8)], "photo.jpg", { type: "image/jpeg" });
    await expect(computeImageHint(jpeg)).resolves.toBeNull();
    expect(bitmap.close).toHaveBeenCalled();
  });
});
