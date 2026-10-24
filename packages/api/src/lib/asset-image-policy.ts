/**
 * Pure image-classification and policy logic for the client-side prepare step
 * (asset-image-prepare.ts). Node-testable on purpose: no DOM, no canvas, no
 * WASM, no env — only `File`/`Blob` (available in Node 18+) and math.
 *
 * The async decode/encode half lives in asset-image-prepare.ts; keep this
 * module the place where "what kind of file is this and does it need work?"
 * gets decided so those rules stay unit-tested without a browser.
 */

export type RasterKind =
  | "jpeg"
  | "png"
  | "webp"
  | "gif"
  | "avif"
  | "heic"
  | "bmp"
  | "tiff"
  | "unknown-raster";

export type ImageFileKind = RasterKind | "svg" | "non-image";

export type ClassifiedImageFile = {
  kind: ImageFileKind;
  /** Corrected MIME — never empty for known rasters / svg / heic. */
  mimeType: string;
  /** gif, or a webp/apng MIME where a still-vs-animated read is impossible here. */
  animatedLikely: boolean;
};

/**
 * `application/octet-stream` (and whitespace/empty) counts as "no declared
 * type" — common for HEIC files dragged from Finder or picked in WebViews.
 */
export function isEmptyImageMime(type: string): boolean {
  const t = type.trim().toLowerCase();
  return t === "" || t === "application/octet-stream";
}

const MIME_TO_KIND: Record<string, RasterKind> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/pjpeg": "jpeg",
  "image/png": "png",
  "image/apng": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/heic-sequence": "heic",
  "image/heif-sequence": "heic",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

const EXTENSION_TO_KIND: Record<string, Exclude<RasterKind, "unknown-raster"> | "svg"> = {
  svg: "svg",
  heic: "heic",
  heif: "heic",
  hif: "heic",
  gif: "gif",
  jpg: "jpeg",
  jpeg: "jpeg",
  jfif: "jpeg",
  png: "png",
  apng: "png",
  webp: "webp",
  avif: "avif",
  bmp: "bmp",
  tif: "tiff",
  tiff: "tiff",
};

const KIND_TO_MIME: Record<Exclude<ImageFileKind, "non-image" | "unknown-raster">, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

/**
 * Major brands that mean "HEVC-coded HEIC". Deliberately excludes `mif1` /
 * `msf1` (generic HEIF containers) and every AVIF brand — treating those as
 * HEIC would route AVIFs through the HEVC WASM decoder, which cannot read them.
 */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Classify a picked/dropped file as a specific raster kind, `svg`, or
 * `non-image`. Order is load-bearing: a non-empty `image/*` MIME wins, then
 * the filename extension, then magic bytes from the first 32 bytes — so an
 * empty-typed `photo.heic` from Finder still classifies as HEIC, and a
 * mislabeled `application/octet-stream` JPEG is recognized by its bytes.
 */
export async function classifyImageFile(file: File): Promise<ClassifiedImageFile> {
  // 1. Non-empty MIME.
  const declared = file.type.trim().toLowerCase();
  if (!isEmptyImageMime(declared)) {
    if (declared === "image/svg+xml") {
      return { kind: "svg", mimeType: KIND_TO_MIME.svg, animatedLikely: false };
    }
    if (declared.startsWith("image/")) {
      const kind = MIME_TO_KIND[declared] ?? "unknown-raster";
      return {
        kind,
        mimeType: kind === "unknown-raster" ? declared : KIND_TO_MIME[kind],
        animatedLikely: animatedLikelyFor(kind, declared),
      };
    }
    // A confident non-image MIME (application/pdf, video/mp4, …).
    return { kind: "non-image", mimeType: declared, animatedLikely: false };
  }

  // 2. Extension.
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const byExtension =
    extension && extension !== file.name.toLowerCase() ? EXTENSION_TO_KIND[extension] : undefined;
  if (byExtension) {
    return {
      kind: byExtension,
      mimeType: KIND_TO_MIME[byExtension],
      animatedLikely: animatedLikelyFor(byExtension, KIND_TO_MIME[byExtension]),
    };
  }

  // 3. Magic bytes, only when both the MIME and the extension said nothing.
  const magicKind = await classifyByMagic(file);
  if (magicKind) {
    return {
      kind: magicKind,
      mimeType: KIND_TO_MIME[magicKind],
      animatedLikely: animatedLikelyFor(magicKind, KIND_TO_MIME[magicKind]),
    };
  }

  return { kind: "non-image", mimeType: file.type, animatedLikely: false };
}

function animatedLikelyFor(kind: ImageFileKind, mimeType: string): boolean {
  if (kind === "gif") return true;
  // WebP and APNG can be animated and the header alone can't cheaply say —
  // flag them so the library policy keeps their bytes when they fit the cap.
  return mimeType === "image/webp" || mimeType === "image/apng";
}

async function classifyByMagic(
  file: File,
): Promise<Extract<RasterKind, "jpeg" | "png" | "gif" | "webp" | "heic" | "avif"> | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (asciiAt(bytes, 1, 3) === "PNG" && bytes[0] === 0x89) return "png";
  if (asciiAt(bytes, 0, 4) === "GIF8") return "gif";
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "webp";
  if (asciiAt(bytes, 4, 4) === "ftyp") {
    const brand = asciiAt(bytes, 8, 4).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return "heic";
    if (AVIF_BRANDS.has(brand)) return "avif";
  }
  return null;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let out = "";
  for (let i = offset; i < offset + length; i++) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

/**
 * Contain-fit a `width × height` box inside `maxEdge` (long edge), preserving
 * aspect ratio and never upscaling. Dimensions stay >= 1.
 */
export function scaleToMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Library policy: does this file need a transcode, or can its original bytes
 * be PUT as-is? (Photo policy never calls this — it always re-encodes.)
 *
 * - `non-image` → false (the async helper returns the original untouched).
 * - `svg` → false here; the async helper throws `SVG` before ever asking.
 * - over the byte cap → true (this is where an over-cap GIF gets flattened).
 * - long edge over `maxDimension` (when known) → true.
 * - HEIC that this browser could not natively decode → true (Chrome/Firefox).
 * - everything else — in-cap GIF/AVIF/JPEG/WebP/PNG, Safari-decoded in-cap
 *   HEIC — keeps its bytes.
 */
export function libraryNeedsTranscode(args: {
  size: number;
  width: number | null;
  height: number | null;
  maxBytes: number;
  maxDimension: number;
  kind: ImageFileKind;
  nativeDecoded: boolean;
  animatedLikely: boolean;
}): boolean {
  const { size, width, height, maxBytes, maxDimension, kind, nativeDecoded } = args;
  if (kind === "non-image" || kind === "svg") return false;
  if (size > maxBytes) return true;
  if (width !== null && height !== null && Math.max(width, height) > maxDimension) return true;
  if (kind === "heic" && !nativeDecoded) return true;
  return false;
}
