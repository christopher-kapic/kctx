import { describe, expect, it } from "vitest";

import { resolveStoredMime, SNIFF_PREFIX_BYTES, sniffMime } from "./sniff-mime";

/** "RIFF" + u32 size + "WEBP" + chunk */
function webpBytes(): Uint8Array {
  return new Uint8Array([
    ..."RIFF".split("").map((c) => c.charCodeAt(0)),
    0x24,
    0x00,
    0x00,
    0x00,
    ..."WEBPVP8 ".split("").map((c) => c.charCodeAt(0)),
  ]);
}

/** u32 box size + "ftyp" + major brand + u32 minor + compatible brands */
function ftypBytes(major: string, compatible: string[]): Uint8Array {
  const brands = [major, ...compatible].join("");
  const size = 8 + brands.length;
  return new Uint8Array([
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ..."ftyp".split("").map((c) => c.charCodeAt(0)),
    ...brands.split("").map((c) => c.charCodeAt(0)),
  ]);
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

describe("sniffMime — magic-number fixture table", () => {
  const cases: Array<[string, Uint8Array, string | null]> = [
    [
      "PNG",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      "image/png",
    ],
    ["JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF")]), "image/jpeg"],
    ["GIF87a", ascii("GIF87a"), "image/gif"],
    ["GIF89a", ascii("GIF89a"), "image/gif"],
    ["WebP (RIFF....WEBP)", webpBytes(), "image/webp"],
    ["AVIF (ftyp avif)", ftypBytes("avif", ["mif1", "miaf", "avif"]), "image/avif"],
    ["AVIF sequence (ftyp avis)", ftypBytes("avis", ["mif1", "avis"]), "image/avif"],
    ["mif1 with avif compatible brand", ftypBytes("mif1", ["mif1", "miaf", "avif"]), "image/avif"],
    ["HEIC (ftyp heic)", ftypBytes("heic", ["mif1", "heic"]), "image/heic"],
    ["HEIC (ftyp heix)", ftypBytes("heix", ["mif1"]), "image/heic"],
    ["HEIC (ftyp hevc)", ftypBytes("hevc", ["mif1"]), "image/heic"],
    ["bare mif1 (generic HEIF)", ftypBytes("mif1", ["mif1", "miaf"]), "image/heic"],
    ["PDF", ascii("%PDF-1.7\n%âãÏÓ"), "application/pdf"],
    ["SVG", ascii('<svg xmlns="http://www.w3.org/2000/svg">'), "image/svg+xml"],
    ["SVG with doctype", ascii('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">'), "image/svg+xml"],
    [
      "SVG with BOM + whitespace",
      new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x0a, ...ascii("<svg")]),
      "image/svg+xml",
    ],
    ["HTML doctype", ascii("<!DOCTYPE html><html><body>"), "text/html"],
    ["HTML lowercase tag", ascii('<html lang="en">'), "text/html"],
    ["HTML uppercase", ascii("<HTML><SCRIPT>alert(1)</SCRIPT>"), "text/html"],
    ["HTML script-first", ascii("<script>alert(1)</script>"), "text/html"],
    [
      "UTF-16LE HTML (BOM + NUL-interleaved)",
      new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x68, 0x00, 0x74, 0x00, 0x6d, 0x00, 0x6c, 0x00]),
      "text/html",
    ],
    ["plain text", ascii("hello world, just a text file"), null],
    ["zip (docx residual unknown)", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0]), null],
    ["mp4 ftyp (not ours to name)", ftypBytes("isom", ["isom", "mp42"]), null],
    ["XML that is neither svg nor html", ascii('<?xml version="1.0"?><rss/>'), null],
    ["empty buffer", new Uint8Array(0), null],
    ["truncated PNG (4 of 8 magic bytes)", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), null],
  ];

  for (const [name, bytes, expected] of cases) {
    it(`sniffs ${name} → ${expected ?? "null"}`, () => {
      expect(sniffMime(bytes)).toBe(expected);
    });
  }

  it("advertises a prefix length large enough for the text sniff window", () => {
    // The text-format sniff scans up to 512 bytes; enforcement points must
    // feed at least that much for SVG/HTML markers near the cap to be seen.
    expect(SNIFF_PREFIX_BYTES).toBeGreaterThanOrEqual(512);
  });
});

describe("resolveStoredMime — policy matrix", () => {
  it("image declared + html/svg sniffed → reject", () => {
    expect(resolveStoredMime("image/png", "text/html")).toEqual({ action: "reject" });
    expect(resolveStoredMime("image/png", "image/svg+xml")).toEqual({ action: "reject" });
    expect(resolveStoredMime("image/webp", "image/svg+xml")).toEqual({ action: "reject" });
  });

  it("scriptable sniffed rejects regardless of the declared label", () => {
    expect(resolveStoredMime("application/pdf", "text/html")).toEqual({ action: "reject" });
    expect(resolveStoredMime("text/plain", "image/svg+xml")).toEqual({ action: "reject" });
    expect(resolveStoredMime("image/svg+xml", "image/svg+xml")).toEqual({ action: "reject" });
  });

  it("png declared + jpeg sniffed → persist the sniffed type", () => {
    expect(resolveStoredMime("image/png", "image/jpeg")).toEqual({
      action: "persist",
      mimeType: "image/jpeg",
    });
  });

  it("non-image declared + image sniffed → persist the sniffed type", () => {
    expect(resolveStoredMime("application/pdf", "image/png")).toEqual({
      action: "persist",
      mimeType: "image/png",
    });
  });

  it("matching types → keep (modulo case and parameters)", () => {
    expect(resolveStoredMime("image/png", "image/png")).toEqual({ action: "keep" });
    expect(resolveStoredMime("IMAGE/PNG", "image/png")).toEqual({ action: "keep" });
    expect(resolveStoredMime("image/png; charset=bogus", "image/png")).toEqual({ action: "keep" });
  });

  it("non-canonical declared alias canonicalizes to the sniffed type", () => {
    expect(resolveStoredMime("image/jpg", "image/jpeg")).toEqual({
      action: "persist",
      mimeType: "image/jpeg",
    });
  });

  it("unknown sniffed + allowed declared → keep the declared type", () => {
    expect(resolveStoredMime("text/plain", null)).toEqual({ action: "keep" });
    expect(
      resolveStoredMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        null,
      ),
    ).toEqual({
      action: "keep",
    });
    expect(resolveStoredMime("image/png", null)).toEqual({ action: "keep" });
  });
});
