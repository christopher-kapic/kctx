import { env } from "@starter/env/server";
import { encode as encodeBlurhash } from "blurhash";
import sharp, { type Metadata } from "sharp";

import { IMAGE_MAX_DIMENSION } from "./image-limits";

/**
 * Image utilities used by the upload procedure (extract metadata + compute
 * blurhash on save) and the image transform endpoint (resize/recompress on
 * read).
 *
 * Sharp is the only image library we ship — same library across upload and
 * transform paths so behavior is consistent.
 */

const BLURHASH_PREVIEW_MAX = 32;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

// Local alias so the ladder/clamp code below keeps reading as "transform max".
// The shared constant lives in image-limits.ts so client-side prepare code can
// use the same cap without importing this module (sharp + server env).
const TRANSFORM_MAX_DIMENSION = IMAGE_MAX_DIMENSION;
const TRANSFORM_DEFAULT_QUALITY = 80;

export type ImageMetadata = {
  width: number;
  height: number;
  mimeType: string;
};

export type UploadImageAnalysis = ImageMetadata & {
  blurhash: string;
};

/**
 * Extract dimensions + a blurhash placeholder from an image buffer. Used at
 * upload time so the placeholder is computed once and stored on the Asset
 * row, not recomputed on every read.
 */
export async function analyzeImage(
  buffer: Uint8Array | Buffer,
  declaredMimeType: string,
): Promise<UploadImageAnalysis | null> {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sharpOptions = { limitInputPixels: env.IMAGE_TRANSFORM_MAX_INPUT_PIXELS };
  let metadata: Metadata;
  try {
    metadata = await sharp(input, sharpOptions).metadata();
  } catch {
    return null;
  }
  if (!metadata.width || !metadata.height || !metadata.format) return null;

  const { data, info } = await sharp(input, sharpOptions)
    .resize(BLURHASH_PREVIEW_MAX, BLURHASH_PREVIEW_MAX, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const blurhash = encodeBlurhash(
    pixels,
    info.width,
    info.height,
    BLURHASH_COMPONENTS_X,
    BLURHASH_COMPONENTS_Y,
  );

  return {
    width: metadata.width,
    height: metadata.height,
    mimeType: declaredMimeType,
    blurhash,
  };
}

export type TransformParams = {
  width?: number;
  height?: number;
  quality?: number;
  format?: "webp" | "avif" | "jpeg" | "png";
};

/**
 * Dimension ladder every requested width/height is snapped UP to.
 *
 * Transform params are caller-controlled, and for a PUBLIC asset the caller is
 * anonymous. Honouring them verbatim makes the *identity* space (see
 * {@link imageTransformETag}) as large as the integer range: `?w=1`, `?w=2`, …
 * are all distinct cache entries. That is what let a trivial `?w=1…32` loop mint
 * enough junk variants to hit `IMAGE_TRANSFORM_CACHE_MAX_VARIANTS`, after which
 * the write-back cache stopped admitting the *real* widths and every request
 * re-ran sharp — the exact cost the cache exists to remove. Snapping collapses
 * that whole loop into a single entry (`w=128`).
 *
 * Snapping UP rather than rejecting out-of-ladder values is deliberate: this is
 * a template, and apps built on it already emit arbitrary `?w=` values via
 * `<Image>`. A 400 would break their images on upgrade; a slightly larger image
 * than asked for degrades nothing (`fit: inside` + `withoutEnlargement` still
 * prevent upscaling past the source, and the browser scales to its layout box).
 *
 * The ladder is the common responsive breakpoint set. Widening it is safe;
 * every added rung multiplies the identity space, so add rungs deliberately.
 */
const TRANSFORM_WIDTH_LADDER = [
  128,
  256,
  384,
  640,
  750,
  828,
  1080,
  1200,
  1440,
  1920,
  2560,
  TRANSFORM_MAX_DIMENSION,
] as const;

/** Quality buckets, same reasoning as the dimension ladder. */
const TRANSFORM_QUALITY_LADDER = [60, TRANSFORM_DEFAULT_QUALITY, 95] as const;

/**
 * Both ladders MUST be sorted ascending — `snapUp` short-circuits on the first
 * rung >= the value, so an out-of-order rung is not a crash, it is a silently
 * wrong result. That matters here because two of the rungs are references to
 * constants rather than literals, so an edit far away from this line can break
 * the invariant:
 *
 *   - Tightening `TRANSFORM_MAX_DIMENSION` to 2048 (a plausible hardening move)
 *     leaves `[…, 1920, 2560, 2048]`. `clampDimension` caps input at 2048, so
 *     `?w=2000` snaps to **2560** — sharp is asked to resize ABOVE the very cap
 *     that constant defines, and the ETag and storage key record it.
 *   - Lowering `TRANSFORM_DEFAULT_QUALITY` below 60 leaves `[60, 50, 95]`, and a
 *     request with no `q` at all snaps 50 → 60, so the documented default
 *     quietly stops being the default.
 *
 * Asserted at module load rather than in a test so it fails on the machine of
 * whoever made the edit, in every environment that imports this module.
 */
function assertAscending(ladder: readonly number[], name: string): void {
  for (let i = 1; i < ladder.length; i++) {
    if ((ladder[i] as number) < (ladder[i - 1] as number)) {
      throw new Error(
        `${name} must be sorted ascending — snapUp() returns the first rung >= the value, ` +
          `so an out-of-order rung silently snaps to the wrong bucket. Got: [${ladder.join(", ")}]`,
      );
    }
  }
}
assertAscending(TRANSFORM_WIDTH_LADDER, "TRANSFORM_WIDTH_LADDER");
assertAscending(TRANSFORM_QUALITY_LADDER, "TRANSFORM_QUALITY_LADDER");

/** Snap `value` up to the first rung >= it, or the top rung. */
function snapUp(value: number, ladder: readonly number[]): number {
  return ladder.find((rung) => value <= rung) ?? (ladder.at(-1) as number);
}

/**
 * The single normalization both the ETag and the actual sharp run derive from.
 *
 * Keeping one function is what guarantees the cache key and the bytes it names
 * can never disagree: if the ETag snapped and the transform didn't, a `?w=800`
 * request would be stored under the `w=828` key while holding 800px bytes.
 */
export function normalizeTransformParams(params: TransformParams): {
  width?: number;
  height?: number;
  quality: number;
  format: NonNullable<TransformParams["format"]>;
} {
  const width = clampDimension(params.width);
  const height = clampDimension(params.height);
  return {
    width: width === undefined ? undefined : snapUp(width, TRANSFORM_WIDTH_LADDER),
    height: height === undefined ? undefined : snapUp(height, TRANSFORM_WIDTH_LADDER),
    quality: snapUp(clampQuality(params.quality), TRANSFORM_QUALITY_LADDER),
    format: params.format ?? "webp",
  };
}

export type TransformResult = {
  body: Buffer;
  contentType: string;
};

/**
 * Resize and recompress an image. Defaults to webp at quality 80, which
 * is a good baseline for web delivery (small + universally supported in
 * 2025+). Hard-caps dimensions at 4096 to prevent DoS via huge requested
 * sizes.
 */
export async function transformImage(
  source: Uint8Array | Buffer,
  params: TransformParams,
): Promise<TransformResult> {
  const input = Buffer.isBuffer(source) ? source : Buffer.from(source);
  // Same normalization the cache key is derived from — see
  // `normalizeTransformParams`. These must not drift apart.
  const { width, height, quality, format } = normalizeTransformParams(params);

  let pipeline = sharp(input, { limitInputPixels: env.IMAGE_TRANSFORM_MAX_INPUT_PIXELS });

  if (width || height) {
    pipeline = pipeline.resize({
      width: width ?? undefined,
      height: height ?? undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  switch (format) {
    case "webp":
      pipeline = pipeline.webp({ quality });
      return { body: await pipeline.toBuffer(), contentType: "image/webp" };
    case "avif":
      pipeline = pipeline.avif({ quality });
      return { body: await pipeline.toBuffer(), contentType: "image/avif" };
    case "jpeg":
      pipeline = pipeline.jpeg({ quality });
      return { body: await pipeline.toBuffer(), contentType: "image/jpeg" };
    case "png":
      pipeline = pipeline.png({ quality });
      return { body: await pipeline.toBuffer(), contentType: "image/png" };
  }
}

/**
 * Stable ETag for a transformed image, derived from the asset id and the
 * *normalized* transform params (see {@link normalizeTransformParams}: clamped,
 * then snapped to the ladders, with format defaulted) — so `?w=9999` and
 * `?w=4096` share a cache entry, as do `?w=1` and `?w=128`. Assets are
 * immutable (the storage key never changes for a row), which makes this pair
 * a valid strong validator: the transform route answers a matching
 * `If-None-Match` with 304 before touching S3 or sharp.
 */
export function imageTransformETag(assetId: string, params: TransformParams): string {
  const n = normalizeTransformParams(params);
  return `"img:${assetId}:w${n.width ?? 0}:h${n.height ?? 0}:q${n.quality}:${n.format}"`;
}

export function parseTransformParams(searchParams: URLSearchParams): TransformParams {
  const w = searchParams.get("w");
  const h = searchParams.get("h");
  const q = searchParams.get("q");
  const format = searchParams.get("format");

  return {
    width: w ? Number.parseInt(w, 10) : undefined,
    height: h ? Number.parseInt(h, 10) : undefined,
    quality: q ? Number.parseInt(q, 10) : undefined,
    format: parseFormat(format),
  };
}

function parseFormat(value: string | null): TransformParams["format"] {
  if (value === "webp" || value === "avif" || value === "jpeg" || value === "png") {
    return value;
  }
  return undefined;
}

function clampDimension(value: number | undefined): number | undefined {
  if (!value || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), TRANSFORM_MAX_DIMENSION);
}

function clampQuality(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return TRANSFORM_DEFAULT_QUALITY;
  return Math.min(Math.max(Math.floor(value), 1), 100);
}
