import { encode } from "blurhash";

import { classifyImageFile } from "./asset-image-policy";

/**
 * Compute a blurhash (plus dimensions when cheaply knowable) from an image
 * File entirely in the browser. Used by the presigned upload flow so the
 * Asset row carries usable placeholder metadata from the moment it's created
 * — even before the analyze-asset worker runs.
 *
 * The type gate is the shared classifier (asset-image-policy.ts), not a bare
 * `file.type` check — so an empty-typed `photo.heic` from Finder still gets a
 * hint attempt, while PDFs and SVGs bail immediately.
 *
 * Decoding happens at the 32px sample size (`createImageBitmap` resize
 * options), never full resolution: a library-kept 48MP JPEG must not allocate
 * a full-res RGBA buffer just to compute a 32px blurhash. A resized bitmap
 * does not expose the intrinsic dimensions, so on that path `width`/`height`
 * are null and the analyze-asset worker supplies the verified values; the
 * optionless fallback (older engines) reports true dimensions.
 *
 * Returns null for non-images/SVG, for files the browser can't decode (no
 * WASM here — HEIC on Chrome/Firefox simply yields no hint), or when no
 * canvas is reachable. Never throws; `uploadAsset` treats null as "no hint".
 */
export async function computeImageHint(file: File): Promise<{
  width: number | null;
  height: number | null;
  blurhash: string;
} | null> {
  const { kind } = await classifyImageFile(file);
  if (kind === "non-image" || kind === "svg") return null;
  if (typeof createImageBitmap === "undefined") return null;

  const SAMPLE_MAX = 32;

  let bitmap: ImageBitmap;
  let intrinsic: { width: number; height: number } | null = null;
  try {
    // Preferred: decode straight to the sample width; the platform preserves
    // aspect ratio when only resizeWidth is given.
    bitmap = await createImageBitmap(file, {
      resizeWidth: SAMPLE_MAX,
      imageOrientation: "from-image",
    });
  } catch {
    // Older engines reject resize options (or the dict entirely) — fall back
    // to an optionless decode and let the canvas below do the downsample.
    try {
      bitmap = await createImageBitmap(file);
      intrinsic = { width: bitmap.width, height: bitmap.height };
    } catch {
      return null;
    }
  }

  try {
    if (bitmap.width < 1 || bitmap.height < 1) return null;
    const sampleW = SAMPLE_MAX;
    const sampleH = Math.max(1, Math.round((bitmap.height / bitmap.width) * sampleW));

    const ctx = getDownsampleContext(sampleW, sampleH);
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, sampleW, sampleH);
    const { data } = ctx.getImageData(0, 0, sampleW, sampleH);

    return {
      width: intrinsic?.width ?? null,
      height: intrinsic?.height ?? null,
      blurhash: encode(data, sampleW, sampleH, 4, 3),
    };
  } finally {
    bitmap.close?.();
  }
}

type DownsampleContext = Pick<CanvasRenderingContext2D, "drawImage" | "getImageData">;

function getDownsampleContext(width: number, height: number): DownsampleContext | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    return canvas.getContext("2d") as unknown as DownsampleContext | null;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d");
}
