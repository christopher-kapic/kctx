import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImagePrepareError, prepareImageForUpload } from "./asset-image-prepare";

// Mock the WASM decoder at the module boundary so CI never loads the real
// heic-to bundle (vi.mock intercepts the dynamic import inside the module).
vi.mock("heic-to/csp", () => ({
  heicTo: vi.fn(),
}));

const { heicTo } = vi.mocked(await import("heic-to/csp"));

// Node has no canvas/bitmap APIs — everything decode/encode is stubbed on
// globalThis. `document`/`Image` stay undefined, so the <img> probe and
// element-decode fallbacks are inert, exactly like a worker context.

type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };

function makeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

const drawImage = vi.fn();
const convertToBlob = vi.fn();

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return { drawImage };
  }
  convertToBlob(options?: { type?: string; quality?: number }) {
    return convertToBlob(options);
  }
}

function blobOf(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  // Default: every encode succeeds with a tiny blob of the requested type.
  convertToBlob.mockImplementation(async (options?: { type?: string }) =>
    blobOf(1024, options?.type ?? "image/png"),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubDecode(bitmap: FakeBitmap): ReturnType<typeof vi.fn> {
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  return decode;
}

function stubDecodeFailure(): ReturnType<typeof vi.fn> {
  const decode = vi.fn().mockRejectedValue(new Error("cannot decode"));
  vi.stubGlobal("createImageBitmap", decode);
  return decode;
}

describe("prepareImageForUpload — shared gates", () => {
  it.each(["photo", "library"] as const)("rejects SVG before any decode (%s)", async (policy) => {
    const decode = stubDecode(makeBitmap(10, 10));
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });

    const error = await prepareImageForUpload(svg, { policy }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImagePrepareError);
    expect((error as ImagePrepareError).code).toBe("SVG");
    expect((error as ImagePrepareError).reasons).toEqual(["common:filePrepare.svg"]);
    expect(decode).not.toHaveBeenCalled();
  });

  it("passes a non-image through untouched under library, rejects it under photo", async () => {
    stubDecode(makeBitmap(10, 10));
    const pdf = new File([new Uint8Array(64)], "notes.pdf", { type: "application/pdf" });

    const prepared = await prepareImageForUpload(pdf, { policy: "library" });
    expect(prepared.file).toBe(pdf);
    expect(prepared.converted).toBe(false);
    expect(prepared.reasons).toEqual([]);

    const error = await prepareImageForUpload(pdf, { policy: "photo" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImagePrepareError);
    expect((error as ImagePrepareError).code).toBe("UNSUPPORTED");
    expect((error as ImagePrepareError).reasons).toEqual(["common:filePrepare.unsupported"]);
  });
});

describe("prepareImageForUpload — library policy", () => {
  it("leaves a small JPEG's original bytes alone", async () => {
    const bitmap = makeBitmap(2000, 1500);
    const decode = stubDecode(bitmap);
    const jpeg = new File([new Uint8Array(2048)], "photo.jpg", { type: "image/jpeg" });

    const prepared = await prepareImageForUpload(jpeg, { policy: "library" });

    expect(prepared.file).toBe(jpeg);
    expect(prepared.converted).toBe(false);
    expect(prepared.reasons).toEqual([]);
    expect(decode).toHaveBeenCalled();
    expect(convertToBlob).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("keeps a native-decoded HEIC under the cap, normalizing its empty MIME", async () => {
    // Safari: createImageBitmap decodes HEIC natively.
    stubDecode(makeBitmap(3000, 2000));
    const heic = new File([new Uint8Array(2048)], "IMG_0001.heic", { type: "" });

    const prepared = await prepareImageForUpload(heic, { policy: "library" });

    expect(prepared.converted).toBe(false);
    expect(prepared.file.type).toBe("image/heic");
    expect(prepared.file.name).toBe("IMG_0001.heic");
    expect(prepared.file.size).toBe(heic.size);
    expect(prepared.reasons).toEqual([]); // normalized-type is silent
    expect(heicTo).not.toHaveBeenCalled();
  });

  it("converts a HEIC via the WASM fallback when native decode fails", async () => {
    // Chrome/Firefox: every native attempt rejects.
    const decode = stubDecodeFailure();
    const wasmBitmap = makeBitmap(4000, 3000);
    heicTo.mockResolvedValue(wasmBitmap as unknown as ImageBitmap);
    const heic = new File([new Uint8Array(2048)], "IMG_0002.heic", { type: "image/heic" });

    const prepared = await prepareImageForUpload(heic, { policy: "library" });

    expect(decode).toHaveBeenCalled();
    expect(heicTo).toHaveBeenCalledWith({ blob: heic, type: "bitmap" });
    expect(prepared.converted).toBe(true);
    expect(prepared.file.type).toBe("image/webp");
    expect(prepared.file.name).toBe("IMG_0002.webp");
    expect(prepared.original).toBe(heic);
    expect(prepared.original.name).toBe("IMG_0002.heic");
    expect(prepared.reasons).toContain("common:filePrepare.converted");
    expect(wasmBitmap.close).toHaveBeenCalled();
  });

  it("transcodes (and flattens) an over-cap GIF", async () => {
    stubDecode(makeBitmap(800, 600));
    // The still-frame re-encode has to fit the tiny cap used below.
    convertToBlob.mockImplementation(async (options?: { type?: string }) =>
      blobOf(16, options?.type ?? "image/png"),
    );
    const gif = new File([new Uint8Array(64)], "party.gif", { type: "image/gif" });

    const prepared = await prepareImageForUpload(gif, {
      policy: "library",
      maxBytes: 32, // the 64-byte "GIF" is over the cap
    });

    expect(prepared.converted).toBe(true);
    expect(prepared.file.type).toBe("image/webp");
    expect(prepared.reasons).toContain("common:filePrepare.flattened");
    expect(prepared.reasons).toContain("common:filePrepare.converted");
  });

  it("throws UNREADABLE for an over-cap non-HEIC nothing can decode", async () => {
    stubDecodeFailure();
    const png = new File([new Uint8Array(64)], "corrupt.png", { type: "image/png" });

    const error = await prepareImageForUpload(png, {
      policy: "library",
      maxBytes: 32,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImagePrepareError);
    expect((error as ImagePrepareError).code).toBe("UNREADABLE");
    expect((error as ImagePrepareError).reasons).toEqual(["common:filePrepare.unreadable"]);
    expect(heicTo).not.toHaveBeenCalled();
  });
});

describe("prepareImageForUpload — photo policy", () => {
  it("always re-encodes, preserving original.name for the success toast", async () => {
    stubDecode(makeBitmap(2000, 1500));
    const jpeg = new File([new Uint8Array(2048)], "vacation photo.jpg", { type: "image/jpeg" });

    const prepared = await prepareImageForUpload(jpeg, { policy: "photo" });

    expect(prepared.converted).toBe(true);
    expect(prepared.file.type).toBe("image/webp");
    expect(prepared.file.name).toBe("vacation photo.webp");
    expect(prepared.original).toBe(jpeg);
    expect(prepared.original.name).toBe("vacation photo.jpg");
    expect(prepared.file.lastModified).toBe(jpeg.lastModified);
    expect(convertToBlob).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/webp", quality: 0.82 }),
    );
  });

  it("contain-fits the encode canvas when the decode fallback returned an oversize bitmap", async () => {
    // Orientation-only fallback path: the first (resize-options) call rejects,
    // the second returns a full-size bitmap that encode must scale down.
    const oversize = makeBitmap(8192, 4096);
    const decode = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("no resize options")))
      .mockResolvedValue(oversize);
    vi.stubGlobal("createImageBitmap", decode);
    const jpeg = new File([new Uint8Array(2048)], "pano.jpg", { type: "image/jpeg" });

    const prepared = await prepareImageForUpload(jpeg, { policy: "photo" });

    // drawImage received the contain-fit box (4096 x 2048).
    expect(drawImage).toHaveBeenCalledWith(oversize, 0, 0, 4096, 2048);
    expect(prepared.reasons).toContain("common:filePrepare.resized");
    expect(oversize.close).toHaveBeenCalled();
  });

  it("falls back to JPEG when the engine cannot encode WebP", async () => {
    stubDecode(makeBitmap(1000, 800));
    convertToBlob.mockImplementation(async (options?: { type?: string }) =>
      options?.type === "image/webp" ? null : blobOf(512, options?.type ?? "image/png"),
    );
    const png = new File([new Uint8Array(2048)], "shot.png", { type: "image/png" });

    const prepared = await prepareImageForUpload(png, { policy: "photo" });

    expect(prepared.file.type).toBe("image/jpeg");
    expect(prepared.file.name).toBe("shot.jpg");
    expect(convertToBlob).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/jpeg", quality: 0.85 }),
    );
  });

  it("walks the WebP quality ladder, then throws TOO_LARGE with maxMb params", async () => {
    stubDecode(makeBitmap(4000, 3000));
    // Every encode attempt stays over the cap.
    convertToBlob.mockImplementation(async (options?: { type?: string }) =>
      blobOf(3 * 1024 * 1024, options?.type ?? "image/png"),
    );
    const jpeg = new File([new Uint8Array(2048)], "huge.jpg", { type: "image/jpeg" });

    const error = await prepareImageForUpload(jpeg, {
      policy: "photo",
      maxBytes: 2 * 1024 * 1024,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImagePrepareError);
    expect((error as ImagePrepareError).code).toBe("TOO_LARGE");
    expect((error as ImagePrepareError).reasons).toEqual(["common:filePrepare.tooLarge"]);
    expect((error as ImagePrepareError).params).toEqual({ maxMb: 2 });
    // Full ladder exhausted: 0.82, 0.7, 0.6, 0.5, 0.4.
    const webpQualities = convertToBlob.mock.calls
      .map((call) => (call[0] as { quality?: number } | undefined)?.quality)
      .filter((q): q is number => typeof q === "number");
    expect(webpQualities).toEqual([0.82, 0.7, 0.6, 0.5, 0.4]);
  });

  it("throws UNREADABLE when nothing (including WASM for HEIC) can decode", async () => {
    stubDecodeFailure();
    heicTo.mockRejectedValue(new Error("broken heic"));
    const heic = new File([new Uint8Array(64)], "bad.heic", { type: "image/heic" });

    const error = await prepareImageForUpload(heic, { policy: "photo" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImagePrepareError);
    expect((error as ImagePrepareError).code).toBe("UNREADABLE");
  });
});
