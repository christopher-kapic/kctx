// Upload gate for the client-declared MIME type. This is a BLOCKLIST: it
// rejects the types that can execute in a browsing context and permits
// everything else, so a general-purpose template can accept whatever files an
// app happens to need without an edit here.
//
// Two limits worth knowing before you rely on it:
//
//  1. It is a blocklist, so any executable type not enumerated below is
//     allowed. Types added to the web platform later are allowed by default.
//  2. It only vets the *label*. The bytes behind it are verified separately:
//     `@starter/api/lib/sniff-mime.ts` magic-number-sniffs the leading bytes
//     where they first reach the server — `finalizeAsset` (presigned path)
//     — rejecting scriptable payloads hiding
//     behind an image label and persisting the sniffed type as the stored
//     mimeType. Formats the sniffer can't recognize (zip-based docx/xlsx,
//     plain text, CSV, …) sniff to null and keep this gate's decision, so
//     for those the declared label is still all we have.
//
// Neither residual gap is exploitable on its own, because serving is defended
// separately: `X-Content-Type-Options: nosniff` (secure-headers),
// `Content-Security-Policy: sandbox` on `/api/assets/:id`,
// `Content-Disposition: attachment` for anything outside the raster allowlist
// in `asset-routes.ts`, and the image endpoint always re-encodes through
// sharp. Those layers stand in for byte-level verification of the formats
// the sniffer doesn't know.
//
// To harden into an allowlist once you know what your app accepts:
//
//  1. Replace `blockedUploadMimeTypes` with an `allowedUploadMimeTypes` set and
//     invert the final check to `allowed.has(mimeType)`. Start from the raster
//     set in `asset-routes.ts` (`inlineAssetMimeTypes`) plus whatever documents
//     you serve. Callers need no change — both the HTTP presign route and the
//
//
//  2. Extend the sniffer (`@starter/api/lib/sniff-mime.ts`) to recognize the
//     formats your allowlist names, so unrecognized bytes can be refused
//     outright instead of falling back to the declared label. It is
//     hand-rolled on purpose — no `file-type` dependency — keep it that way
//     unless you are willing to take on the maintenance.
//
// Do step 2 as well as step 1, not instead of it: an allowlist on a
// client-supplied string only constrains the label, not the bytes behind it.
const blockedUploadMimeTypes = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
]);

export function isAllowedUploadMimeType(value: string): boolean {
  const mimeType = normalizeMimeType(value);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) return false;
  return !blockedUploadMimeTypes.has(mimeType);
}

export function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
