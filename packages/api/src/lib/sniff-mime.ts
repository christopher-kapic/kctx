/**
 * Server-side magic-number MIME sniffer + the storage policy built on it.
 *
 * `sniffMime()` looks at the leading bytes and returns the canonical MIME the
 * bytes actually are, or null when the format is not recognized (zip-based
 * formats like docx/xlsx, plain text, CSV, anything we don't know). It is the
 * byte-level counterpart to the declared-type blocklist in
 * `apps/server/src/upload-mime.ts` — that gate owns the *label*, this module
 * owns the *bytes*.
 *
 * Lives in packages/api (not next to upload-mime.ts in apps/server) because
 * `finalizeAsset()` — the presigned-upload enforcement point — is here, and
 * apps/server already imports `@starter/api/lib/*`. Pure on purpose: no env,
 * no storage, no Node APIs — unit-testable with a table of byte fixtures.
 */

/** How many leading bytes an enforcement point must feed the sniffer. */
export const SNIFF_PREFIX_BYTES = 512;

/** Sniffed types that can execute script — never stored, always rejected. */
const SCRIPTABLE_SNIFFED_TYPES = new Set(["text/html", "image/svg+xml"]);

/** HEIC/HEIF major brands (hevc-coded image containers). mif1/msf1 handled below. */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let out = "";
  for (let i = offset; i < offset + length; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function isFtypBrand(bytes: Uint8Array, offset: number, brand: string): boolean {
  return asciiAt(bytes, offset, 4).toLowerCase() === brand;
}

/**
 * Recognize a file format from its leading bytes. Returns the canonical MIME
 * type, or null for "unknown" — null means "let the declared type stand"
 * (it has already survived the upload blocklist at presign time).
 */
export function sniffMime(bytes: Uint8Array): string | null {
  // Rasters, offset 0 unless noted:
  if (bytes.length >= 8 && bytes[0] === 0x89 && asciiAt(bytes, 1, 7) === "PNG\r\n\x1a\n") {
    return "image/png"; // 89 50 4E 47 0D 0A 1A 0A
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"; // FF D8 FF
  }
  const gifHeader = asciiAt(bytes, 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
    return "image/webp"; // "RIFF" + u32 size at 4..8 + "WEBP" at 8..12
  }
  // ISO-BMFF: u32 box size at 0..4, "ftyp" at 4..8, major brand at 8..12,
  // minor version at 12..16, compatible brands from 16 onward (4 bytes each).
  if (bytes.length >= 12 && asciiAt(bytes, 4, 4) === "ftyp") {
    const major = asciiAt(bytes, 8, 4).toLowerCase();
    if (AVIF_BRANDS.has(major)) return "image/avif";
    if (HEIC_BRANDS.has(major)) return "image/heic";
    if (major === "mif1" || major === "msf1") {
      // Generic HEIF container: scan the first compatible brands for a
      // decisive avif/heic entry; a bare mif1/msf1 is HEIF, which this
      // codebase labels image/heic (never served inline — see asset-routes).
      for (let off = 16; off + 4 <= Math.min(bytes.length, 48); off += 4) {
        if (isFtypBrand(bytes, off, "avif") || isFtypBrand(bytes, off, "avis")) {
          return "image/avif";
        }
        if (
          HEIC_BRANDS.has(asciiAt(bytes, off, 4).toLowerCase()) ||
          isFtypBrand(bytes, off, "mif1") ||
          isFtypBrand(bytes, off, "msf1")
        ) {
          return "image/heic";
        }
      }
      return "image/heic";
    }
    return null; // mp4/mov-style brands — not ours to name
  }
  if (asciiAt(bytes, 0, 5) === "%PDF-") return "application/pdf"; // offset 0

  // Text formats (SVG, HTML) have no binary magic. Sniff: after an optional
  // BOM and leading whitespace the first byte must be '<', and a marker must
  // appear within the first 512 bytes. SVG and HTML are the scriptable types
  // this exists to catch — an HTML payload labeled image/png must not sniff
  // as null. Case-insensitive; UTF-16 handled by dropping the interleaved
  // NULs so a BOM'd UTF-16 document can't evade the marker scan.
  const windowEnd = Math.min(bytes.length, 512);
  let start = 0;
  // UTF-8 BOM EF BB BF; UTF-16 BOMs FF FE / FE FF (the interleaved NULs of a
  // UTF-16 document are then dropped so the marker scan can't be evaded).
  let utf16 = false;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    start = 2;
    utf16 = true;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    start = 2;
    utf16 = true;
  }
  let text = "";
  for (let i = start; i < windowEnd; i++) text += String.fromCharCode(bytes[i] ?? 0);
  if (utf16) text = text.replaceAll("\u0000", "");
  const trimmed = text.replace(/^[ \t\r\n\f]+/, "");
  if (trimmed.startsWith("<")) {
    const lower = trimmed.toLowerCase();
    if (lower.includes("<svg") || lower.includes("<!doctype svg")) return "image/svg+xml";
    if (lower.includes("<!doctype html") || lower.includes("<html") || lower.includes("<script")) {
      return "text/html";
    }
  }
  return null;
}

export type StoredMimeDecision =
  | { action: "keep" }
  | { action: "persist"; mimeType: string }
  | { action: "reject" };

/**
 * Policy matrix applied wherever bytes first reach the server
 * (`finalizeAsset` for presigned uploads):
 *
 * - sniffed null (unknown format — SVG-as-declared, zip-based docs, text) →
 *   keep the declared type; the upload blocklist already vetted that label.
 * - sniffed scriptable (text/html, image/svg+xml) → reject outright. The
 *   blocklist refuses these as labels, so they must never be stored as bytes
 *   under a friendlier label either.
 * - sniffed non-scriptable type that differs from the declared one → persist
 *   the sniffed type as the authoritative mimeType (the served Content-Type
 *   becomes server-owned); equal (modulo case/params) → keep.
 */
export function resolveStoredMime(declared: string, sniffed: string | null): StoredMimeDecision {
  if (sniffed === null) return { action: "keep" };
  if (SCRIPTABLE_SNIFFED_TYPES.has(sniffed)) return { action: "reject" };
  // Mirrors normalizeMimeType in apps/server/src/upload-mime.ts (packages
  // cannot import from apps/).
  const declaredMime = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (sniffed === declaredMime) return { action: "keep" };
  return { action: "persist", mimeType: sniffed };
}
