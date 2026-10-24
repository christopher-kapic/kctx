/**
 * Browser-side image preparation for the presigned upload flow. Pure client
 * code: no sharp, no AWS SDK, no Prisma, no `@starter/env/server`. Image UIs
 * call `prepareImageForUpload(file, { policy })` and hand `prepared.file` to
 * `uploadAsset()` (which stays a dumb PUT — see asset-client.ts).
 *
 * Policies:
 * - `"photo"`   — always re-encodes rasters to WebP (JPEG fallback), resized
 *                 to the long-edge cap and compressed under the byte cap.
 *                 Non-images are rejected. Animated GIFs get flattened.
 * - `"library"` — conservative: keeps the original bytes when they already
 *                 fit the caps and this browser can handle them; transcodes
 *                 only when over the byte cap, over the long-edge cap, or
 *                 when the file is a HEIC this browser cannot natively decode
 *                 (Chrome/Firefox). Non-images pass through untouched.
 *
 * The heic-to WASM decoder is lazy and fallback-only: `import("heic-to/csp")`
 * runs only after every native decode path failed AND the classifier says
 * HEIC. Never import this module from apps/server, apps/worker, or
 * packages/api/src/index.ts — it would drag canvas/WASM toward the server
 * graph. apps/native must not import it either (Metro would try to resolve
 * the embedded decoder; use Expo ImagePicker/ImageManipulator instead).
 */

import {
  type ClassifiedImageFile,
  classifyImageFile,
  isEmptyImageMime,
  libraryNeedsTranscode,
  scaleToMaxEdge,
} from "./asset-image-policy";
import { ASSET_UPLOAD_MAX_BYTES_DEFAULT, IMAGE_MAX_DIMENSION } from "./image-limits";

export type PreparePolicy = "photo" | "library";

export type PrepareImageOptions = {
  policy: PreparePolicy;
  /** Defaults to ASSET_UPLOAD_MAX_BYTES_DEFAULT. */
  maxBytes?: number;
  /** Defaults to IMAGE_MAX_DIMENSION. */
  maxDimension?: number;
  signal?: AbortSignal;
};

export type PreparedImage = {
  /** Bytes to hand to uploadAsset. */
  file: File;
  /** The File the user picked. Success toasts use original.name. */
  original: File;
  converted: boolean;
  /**
   * i18n keys describing what happened (may be empty).
   * Informational (resized / converted / flattened) are toasts the call site
   * may show; the helper itself has no user-facing English.
   */
  reasons: string[];
};

export type ImagePrepareErrorCode = "TOO_LARGE" | "UNREADABLE" | "UNSUPPORTED" | "SVG";

const ERROR_REASON_KEYS: Record<ImagePrepareErrorCode, string> = {
  TOO_LARGE: "common:filePrepare.tooLarge",
  UNREADABLE: "common:filePrepare.unreadable",
  UNSUPPORTED: "common:filePrepare.unsupported",
  SVG: "common:filePrepare.svg",
};

export class ImagePrepareError extends Error {
  readonly code: ImagePrepareErrorCode;
  readonly reasons: string[];
  readonly params?: Record<string, unknown>;

  constructor(code: ImagePrepareErrorCode, params?: Record<string, unknown>) {
    super(`Image prepare failed: ${code}`);
    this.name = "ImagePrepareError";
    this.code = code;
    this.reasons = [ERROR_REASON_KEYS[code]];
    this.params = params;
  }
}

const WEBP_QUALITY_LADDER = [0.82, 0.7, 0.6, 0.5, 0.4];
const JPEG_FIRST_QUALITY = 0.85;

export async function prepareImageForUpload(
  file: File,
  options: PrepareImageOptions,
): Promise<PreparedImage> {
  const { policy, signal } = options;
  const maxBytes = options.maxBytes ?? ASSET_UPLOAD_MAX_BYTES_DEFAULT;
  const maxDimension = options.maxDimension ?? IMAGE_MAX_DIMENSION;

  signal?.throwIfAborted();

  const classified = await classifyImageFile(file);

  // SVG is rejected for both policies before any decode — matches the server
  // blocklist, and rasterizing SVG on a canvas is explicitly out of scope.
  if (classified.kind === "svg") throw new ImagePrepareError("SVG");

  if (classified.kind === "non-image") {
    if (policy === "photo") throw new ImagePrepareError("UNSUPPORTED");
    // Library: PDFs and friends pass through untouched.
    return { file, original: file, converted: false, reasons: [] };
  }

  signal?.throwIfAborted();

  // Cheap intrinsic-size probe (metadata parse via <img>, no full RGBA in JS).
  // This supplies the "encoded dimensions" the contain-fit decode wants, so a
  // small photo is never upscaled by resize options; when it fails (no
  // document, undecodable format) the unknown-dims branch below applies.
  const probed = await probeIntrinsicSize(file);

  signal?.throwIfAborted();

  if (policy === "library") {
    return prepareLibrary({ file, classified, probed, maxBytes, maxDimension, signal });
  }
  return preparePhoto({ file, classified, probed, maxBytes, maxDimension, signal });
}

type PrepareContext = {
  file: File;
  classified: ClassifiedImageFile;
  probed: Size | null;
  maxBytes: number;
  maxDimension: number;
  signal?: AbortSignal;
};

async function prepareLibrary(ctx: PrepareContext): Promise<PreparedImage> {
  const { file, classified, probed, maxBytes, maxDimension } = ctx;

  // Fast path: a non-HEIC raster with known dimensions that fits both caps
  // never needs a decode — the original bytes are kept regardless.
  if (
    classified.kind !== "heic" &&
    probed &&
    !libraryNeedsTranscode({
      size: file.size,
      width: probed.width,
      height: probed.height,
      maxBytes,
      maxDimension,
      kind: classified.kind,
      nativeDecoded: true,
      animatedLikely: classified.animatedLikely,
    })
  ) {
    return passThrough(file, classified);
  }

  // Cheap decode (contain-fit, never full-res) for dimensions / HEIC-keep.
  const decoded = await decodeNative(ctx);
  try {
    const intrinsic = probed ?? decoded?.intrinsic ?? null;
    const needs = libraryNeedsTranscode({
      size: file.size,
      width: intrinsic?.width ?? null,
      height: intrinsic?.height ?? null,
      maxBytes,
      maxDimension,
      kind: classified.kind,
      nativeDecoded: decoded !== null,
      animatedLikely: classified.animatedLikely,
    });

    if (!needs) return passThrough(file, classified);

    // `return await` is load-bearing: the finally below closes the bitmap,
    // which must not happen while encodePrepared is still drawing from it.
    if (decoded) return await encodePrepared(ctx, decoded, intrinsic);
  } finally {
    decoded?.close();
  }

  // Native decode failed and a transcode is required. HEIC gets the lazy WASM
  // fallback; anything else undecodable-and-over-cap is unreadable here.
  if (classified.kind === "heic") {
    const wasmDecoded = await decodeHeicViaWasm(ctx);
    try {
      return await encodePrepared(ctx, wasmDecoded, wasmDecoded.intrinsic);
    } finally {
      wasmDecoded.close();
    }
  }
  throw new ImagePrepareError("UNREADABLE");
}

async function preparePhoto(ctx: PrepareContext): Promise<PreparedImage> {
  const { classified, probed } = ctx;

  let decoded = await decodeNative(ctx);
  if (!decoded && classified.kind === "heic") {
    decoded = await decodeHeicViaWasm(ctx);
  }
  if (!decoded) throw new ImagePrepareError("UNREADABLE");
  try {
    return await encodePrepared(ctx, decoded, probed ?? decoded.intrinsic);
  } finally {
    decoded.close();
  }
}

/** Library pass-through — keep the bytes; normalize an empty MIME so presign
 *  never sees application/octet-stream for a classified raster. */
function passThrough(file: File, classified: ClassifiedImageFile): PreparedImage {
  const corrected = classified.mimeType;
  if (isEmptyImageMime(file.type) && corrected && !isEmptyImageMime(corrected)) {
    // `normalized-type` is deliberately silent: not an entry in `reasons`, so
    // no toast — only the declared MIME changes, never the bytes.
    return {
      file: new File([file], file.name, { type: corrected, lastModified: file.lastModified }),
      original: file,
      converted: false,
      reasons: [],
    };
  }
  return { file, original: file, converted: false, reasons: [] };
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

type Size = { width: number; height: number };

type DecodedImage = {
  /** Drawable at its current (possibly already contain-fit) size. */
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  /** Pre-resize dimensions when known (probe or unresized decode). */
  intrinsic: Size | null;
  close: () => void;
};

/**
 * Native decode chain (never WASM):
 *   1. createImageBitmap with contain-fit resize options + orientation,
 *   2. createImageBitmap with orientation only (canvas scales later),
 *   3. bare createImageBitmap,
 *   4. HTMLImageElement.
 * Returns null when every path fails (the callers decide between the HEIC
 * WASM fallback and UNREADABLE).
 */
async function decodeNative(ctx: PrepareContext): Promise<DecodedImage | null> {
  const { file, probed, maxDimension, signal } = ctx;
  signal?.throwIfAborted();

  if (typeof createImageBitmap !== "undefined") {
    // Contain-fit box. Known dims that already fit → no resize entries (the
    // platform would otherwise upscale). Unknown dims → resizeWidth at the
    // cap, corrected after decode if the aspect made the height overshoot.
    let resize: ImageBitmapOptions = {};
    if (probed) {
      const target = scaleToMaxEdge(probed.width, probed.height, maxDimension);
      if (target.width !== probed.width || target.height !== probed.height) {
        resize = { resizeWidth: target.width, resizeHeight: target.height };
      }
    } else {
      resize = { resizeWidth: maxDimension };
    }

    try {
      const bitmap = await createImageBitmap(file, {
        ...resize,
        imageOrientation: "from-image",
        resizeQuality: "high",
      });
      return bitmapDecoded(bitmap, probed, resize);
    } catch {
      // Older engines reject the options dict — retry orientation-only, then
      // bare. Both decode at intrinsic size; encode() canvas-scales later.
    }
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return bitmapDecoded(bitmap, probed, {});
    } catch {
      /* fall through */
    }
    try {
      const bitmap = await createImageBitmap(file);
      return bitmapDecoded(bitmap, probed, {});
    } catch {
      /* fall through to HTMLImageElement */
    }
  }

  const viaElement = await decodeViaImageElement(file);
  if (viaElement) return viaElement;
  return null;
}

function bitmapDecoded(
  bitmap: ImageBitmap,
  probed: Size | null,
  resize: ImageBitmapOptions,
): DecodedImage {
  const wasResized = resize.resizeWidth !== undefined || resize.resizeHeight !== undefined;
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    // An unresized decode exposes intrinsic dimensions; a resized one doesn't.
    intrinsic: probed ?? (wasResized ? null : { width: bitmap.width, height: bitmap.height }),
    close: () => bitmap.close?.(),
  };
}

async function decodeViaImageElement(file: File): Promise<DecodedImage | null> {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = url;
  });
  if (!img || img.naturalWidth < 1 || img.naturalHeight < 1) {
    URL.revokeObjectURL(url);
    return null;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    intrinsic: { width: img.naturalWidth, height: img.naturalHeight },
    close: () => URL.revokeObjectURL(url),
  };
}

/**
 * Lazy WASM fallback — only reached when native decode failed and the
 * classifier says HEIC. Always `heic-to/csp` (CSP-safe build), always a
 * dynamic import so the decoder rides its own async chunk. This path may
 * decode full resolution — the known Chrome/Firefox HEIC cost; the encode
 * step still contain-fits the output.
 */
async function decodeHeicViaWasm(ctx: PrepareContext): Promise<DecodedImage> {
  const { file, signal } = ctx;
  signal?.throwIfAborted();
  let bitmap: ImageBitmap;
  try {
    const { heicTo } = await import("heic-to/csp");
    bitmap = await heicTo({ blob: file, type: "bitmap" });
  } catch {
    throw new ImagePrepareError("UNREADABLE");
  }
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    intrinsic: { width: bitmap.width, height: bitmap.height },
    close: () => bitmap.close?.(),
  };
}

/** Cheap intrinsic-size read: <img> fires load once the header metadata is
 *  parsed — no full-resolution RGBA surfaces in JS. Null when unavailable. */
async function probeIntrinsicSize(file: File): Promise<Size | null> {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<Size | null>((resolve) => {
      const img = new Image();
      img.onload = () =>
        resolve(
          img.naturalWidth >= 1 && img.naturalHeight >= 1
            ? { width: img.naturalWidth, height: img.naturalHeight }
            : null,
        );
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

async function encodePrepared(
  ctx: PrepareContext,
  decoded: DecodedImage,
  intrinsic: Size | null,
): Promise<PreparedImage> {
  const { file, classified, maxBytes, maxDimension, signal } = ctx;
  signal?.throwIfAborted();

  // The decoded drawable may still exceed the cap (unknown-dims decode where
  // the height overshot, WASM full-res decode, orientation-only fallback) —
  // the canvas draw is the final contain fit.
  const target = scaleToMaxEdge(decoded.width, decoded.height, maxDimension);

  const canvas = createEncodeCanvas(target.width, target.height);
  if (!canvas) throw new ImagePrepareError("UNREADABLE");
  canvas.ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

  let type = "image/webp";
  let blob = await encodeBlob(canvas, type, WEBP_QUALITY_LADDER[0] ?? 0.82);
  if (!blob || blob.size === 0) {
    // This engine can't encode WebP — fall back to JPEG and re-run the ladder.
    type = "image/jpeg";
    blob = await encodeBlob(canvas, type, JPEG_FIRST_QUALITY);
  }
  if (!blob || blob.size === 0) throw new ImagePrepareError("UNREADABLE");

  for (let i = 1; blob.size > maxBytes && i < WEBP_QUALITY_LADDER.length; i++) {
    signal?.throwIfAborted();
    const quality = WEBP_QUALITY_LADDER[i] ?? 0.4;
    const next = await encodeBlob(canvas, type, quality);
    if (!next || next.size === 0) break;
    blob = next;
  }
  if (blob.size > maxBytes) {
    throw new ImagePrepareError("TOO_LARGE", {
      maxMb: Math.round(maxBytes / (1024 * 1024)),
    });
  }

  const extension = type === "image/webp" ? "webp" : "jpg";
  const prepared = new File([blob], replaceExtension(file.name, extension), {
    type,
    lastModified: file.lastModified,
  });

  const reasons: string[] = [];
  if (type !== classified.mimeType) reasons.push("common:filePrepare.converted");
  const sourceLongEdge = Math.max(
    intrinsic?.width ?? decoded.width,
    intrinsic?.height ?? decoded.height,
  );
  if (sourceLongEdge > Math.max(target.width, target.height)) {
    reasons.push("common:filePrepare.resized");
  }
  // Only GIF is a confident "was animated" signal; webp/apng merely *might*
  // be, and a wrong "converted to a still" toast is worse than none.
  if (classified.kind === "gif") reasons.push("common:filePrepare.flattened");

  return { file: prepared, original: file, converted: true, reasons };
}

type EncodeCanvas =
  | { kind: "offscreen"; canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
  | { kind: "element"; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

/** OffscreenCanvas when available, else a detached <canvas> — the same
 *  fallback shape computeImageHint uses. */
function createEncodeCanvas(width: number, height: number): EncodeCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) return { kind: "offscreen", canvas, ctx };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  return { kind: "element", canvas, ctx };
}

async function encodeBlob(
  target: EncodeCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if (target.kind === "offscreen") {
    try {
      const blob = await target.canvas.convertToBlob({ type, quality });
      // Engines that can't encode the format may fall back to PNG — treat a
      // mismatched type as "unsupported" so the JPEG fallback kicks in.
      return blob.type === type ? blob : null;
    } catch {
      return null;
    }
  }
  return await new Promise<Blob | null>((resolve) => {
    target.canvas.toBlob(
      (blob) => resolve(blob && blob.type === type ? blob : null),
      type,
      quality,
    );
  });
}

function replaceExtension(name: string, extension: string): string {
  const trimmed = name.trim() || "image";
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base}.${extension}`;
}
