# Assets — Object Storage, Images, and Blurhash

How this template hosts user-uploaded files. Read this **before** adding any feature that needs file uploads, profile images, document storage, etc.

## What ships

- **Asset endpoint** — `GET /api/assets/:id` — serves any stored file with visibility-aware cache headers.
- **Image endpoint** — `GET /api/images/:source` — serves resized / recompressed images on the fly. `:source` is an asset id or (when configured) an allowlisted external URL.
- **Presign endpoint** — `POST /api/assets/presign` — issues a short-lived signed PUT URL and creates a `PENDING` Asset row with the client-supplied metadata hint.
- **Heartbeat endpoint** — `POST /api/assets/heartbeat` — bumps `uploadHeartbeatAt` on a `PENDING` row so cleanup knows the client is still uploading.
- **Finalize endpoint** — `POST /api/assets/finalize` — confirms the upload landed in S3 (HEAD), magic-number sniffs the leading bytes (rejecting scriptable payloads, persisting the sniffed MIME on other recognized mismatches), flips the row to `READY`, and enqueues an `analyze-asset` job so the worker re-derives blurhash/dimensions from the stored bytes.
- **`Asset` Prisma model** — stores `storageKey`, `mimeType`, `size`, `visibility`, `ownerId`, `width`, `height`, `blurhash`, `status` (`PENDING` | `READY`), `metadataState` (`CLIENT_HINT` | `SERVER_VERIFIED`), `uploadHeartbeatAt` (last client heartbeat during a presigned upload).
- **Object storage** — any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, etc.). Configured entirely via env vars.
- **`uploadAsset()` client helper** — typed wrapper around presign / heartbeat / PUT / finalize. Computes a width/height/blurhash hint in the browser before presigning, beats every 60s while uploading, stops once finalize succeeds.
- **`prepareImageForUpload()` client helper** — browser-side image prepare (resize to the 4096 long edge, compress under the byte cap, convert HEIC when the browser can't decode it) that image UIs run *before* `uploadAsset()`. Two policies: `"photo"` (always re-encode) and `"library"` (keep originals that fit). The HEIC decoder (`heic-to`) loads lazily as its own chunk, only when needed. See [Prepare images in the browser](#prepare-images-in-the-browser).
- **Global file-drop guard** — `FileDropGuard` swallows document-level drops so dragging a file onto the SPA never navigates; zones opt in via `useFileDropTarget`. See [Drag-and-drop (never navigate)](#drag-and-drop-never-navigate).
- **Cleanup job** — `cleanup-assets` BullMQ job runs daily at 03:15 UTC. Sweeps orphan `PENDING` rows (heartbeat older than 5 min), unreferenced S3 objects under `assets/` (older than 15 min), and incomplete multipart uploads (older than 24 h).

**No upload UI ships.** The template gives you the endpoints, the client helpers, and the cleanup sweep — not a screen. The first upload surface is yours to build; [Uploading](#uploading) below is the recipe.

## Mental model

```
Read    User → /api/images/:id?w=400 → fetchAsset() → S3 → sharp.transform() → response
        User → /api/assets/:id        → fetchAsset() → S3 → response

Write   Client → prepareImageForUpload()    → classify → decode (native, else lazy heic-to
                                              for HEIC) → resize/re-encode when needed
        Client → POST /api/assets/presign  → Asset(PENDING) + signed PUT URL
        Client → PUT  <signed-url>          → S3 (bytes never touch the app server)
        Client → POST /api/assets/finalize  → HEAD object → Asset(READY) → enqueue analyze-asset
        Worker ← analyze-asset job          → S3 → sharp/blurhash → Asset(metadataState=SERVER_VERIFIED)
```

Every read goes through `fetchAsset()` in `packages/api/src/lib/assets.ts` — the **single permission boundary**. Both routes call it directly (no internal HTTP self-requests). The image endpoint inherits the source's visibility, so a transformation of a private asset never lands in a shared CDN.

Bytes never stream through the app server on the upload path — the browser PUTs directly to S3 with a 5-minute signed URL. The app sees only metadata.

## Before accepting user content

Complete [launch-readiness](./launch-readiness.md) when adding the first upload surface. Decide permitted content, visibility, retention/deletion, complaint handling, and who can remove content. If relying on US copyright safe-harbor protection, resolve designated-agent registration/public contact information, renewals, takedown/counter-notice handling, and the repeat-infringer policy with the owner. Record external registration evidence; neither an upload endpoint nor a placeholder DMCA page establishes safe-harbor eligibility.

## Configuration

Asset hosting is **opt-in**. With `S3_BUCKET` unset, `/api/assets/*` and `/api/images/*` return 503 and the rest of the app boots normally.

### Required env vars (when enabled)

| Variable | Purpose |
|---|---|
| `S3_BUCKET` | The bucket name — or `bucket/prefix` to scope this app to a key prefix inside a shared bucket (see below). |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Credentials. |
| `S3_REGION` | Bucket region. Default `auto` works for Cloudflare R2; AWS users typically set `us-east-1`. |
| `S3_ENDPOINT` | Optional. Set for non-AWS providers (R2, B2, MinIO). Omit for AWS. |
| `S3_FORCE_PATH_STYLE` | Optional. Default `false`. Set `true` for MinIO and similar self-hosted providers. |

### Sharing one bucket across apps (`bucket/prefix`)

`S3_BUCKET` accepts an optional key prefix after the first slash: `S3_BUCKET=shared-dev/my-app` uses bucket `shared-dev` and stores every object under `my-app/`. `parseBucketSpec` in `packages/api/src/lib/storage.ts` splits the spec, and every physical key, `ListObjectsV2` call, and cleanup sweep is scoped to the prefix — so the `cleanup-assets` cron of one app never sees (let alone reaps) another app's objects. Nested prefixes work too (`shared-dev/team/my-app`), and the DB keeps storing *logical* keys (`assets/<uuid>`), so you can later move an app to its own bucket by changing only the env var and copying the objects.

This is a convenience for development — several prototypes on one set of credentials, one prefix each. The isolation is by convention: the credentials can still read the whole bucket, so any app (or a bug in it) could reach outside its prefix. For production, either give each app its own bucket, or scope the credentials themselves to the prefix (AWS IAM supports `s3:prefix` conditions; R2 API tokens scope per-bucket only, so on R2 use separate buckets for hard isolation).

### Optional env vars

| Variable | Purpose |
|---|---|
| `IMAGE_PROXY_ALLOWED_HOSTS` | Comma-separated allowlist of hostnames the image endpoint may proxy. Empty (default) = the endpoint refuses external URLs and only serves stored assets. |
| `ASSET_UPLOAD_MAX_BYTES` | Hard cap on a single upload, in bytes. Defaults to 10 MB. The Hono-level body limit (also 10 MB) still applies independently. **Changing this env var also requires changing `ASSET_UPLOAD_MAX_BYTES_DEFAULT` in `packages/api/src/lib/image-limits.ts`** — the client-side prepare default is a constant kept in lockstep by hand (no `VITE_` mirror; apps that override the cap pass `maxBytes` explicitly to `prepareImageForUpload`). A unit test (`image-limits.test.ts`) fails if the two defaults drift. |
| `IMAGE_TRANSFORM_CACHE` | On-by-default kill switch for the S3 write-back cache of sharp transforms (see [Transform cache](#transform-cache--s3-write-back-for-sharp-output) below). `true` (default) caches transformed variants; `false` disables cache read **and** write, restoring transform-on-every-miss. |
| `IMAGE_TRANSFORM_CACHE_MAX_VARIANTS` | Cap on stored transform variants per asset (default 32). Past the cap, transforms still run — they just stop being written back. Bounds the storage-amplification surface of caller-controlled params. |

### Provider-specific quick starts

**AWS S3:**

```env
S3_BUCKET=my-app-assets
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
```

**Cloudflare R2:**

```env
S3_BUCKET=my-app-assets
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

**MinIO (self-hosted):**

```env
S3_BUCKET=my-app-assets
S3_REGION=us-east-1
S3_ENDPOINT=https://minio.example.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

## Visibility & caching

| Visibility | `Cache-Control` |
|---|---|
| `PUBLIC` | `public, max-age=86400, immutable` — shared CDN cache for 24 h |
| `RESTRICTED` | `private, no-cache` — browser cache only, revalidated on every request |

The image endpoint inherits the source's visibility. If you transform a `RESTRICTED` asset, the response carries `private` so a CDN never holds the derivative.

`no-cache` does not mean "don't store" — the browser still caches the bytes and the route still answers `If-None-Match` with a `304`, so a repeat view costs no S3 read and no sharp transform. It means "revalidate before reuse", which forces the request back through `canViewAsset()` every time. The alternative (`private, max-age=86400`) would let a shared browser profile serve one user's private asset to the next person who navigates to the same `/api/assets/:id` URL, without the origin ever seeing the request.

`PUBLIC` keeps `immutable` on purpose: it is what makes CDN fronting cheap, and the tradeoff is the revocation window described below. If your product flips visibility as a routine user action rather than a rare admin one, drop `immutable` and shorten to something like `public, max-age=300, stale-while-revalidate=86400`. The single place to change is `assetCacheControl()` in `packages/api/src/lib/assets.ts`.

`/api/images/*` emits a stable `ETag` (derived from the asset id and the normalized transform params) and answers `If-None-Match` with `304` after the permission check, so repeat visitors skip S3 and sharp entirely. Beyond that, an S3 write-back cache (on by default — see [Transform cache](#transform-cache--s3-write-back-for-sharp-output) below) memoizes the transformed bytes so even a *first* request from a new visitor for an already-seen variant serves stored output instead of re-running sharp. For image-heavy production use, a CDN in front of the public origin is still worthwhile, but the origin no longer re-transforms on every cache-cold request.

## Transform cache — S3 write-back for sharp output

`GET /api/images/:id` caches its transformed output back into the **same S3 bucket**, so a repeat request for the same `(asset, params)` pair serves stored bytes instead of re-running decode → resize → encode. The orchestration lives in `packages/api/src/lib/image-transform-cache.ts`; the route (`asset-routes.ts`) stays thin.

- **Key layout:** `transforms/<assetId>/<paramsHash>.<ext>`, where `<paramsHash>` is the first 16 hex chars of sha256 over the *normalized* transform identity from `imageTransformETag()` — clamped, then snapped to the dimension/quality ladders, so `?w=9999` and `?w=4096` collapse to one entry, as do `?w=1` and `?w=128` — and `<ext>` is the output format. Normalization happens in exactly one place (`normalizeTransformParams()`), which both the ETag and the sharp run derive from; that is what guarantees the key and the bytes it names can never disagree.
- **The prefix MUST be `transforms/`, never under `assets/`.** The cleanup sweep's phase 2 deletes any `assets/` object with no matching `Asset.storageKey` row — a variant parked there would be destroyed on the next cron run. Keeping variants under their own prefix keeps them out of that sweep and lets phase 4 reap them on their own terms.
- **Miss path:** concurrent transforms for the same key are deduped through a module-level in-flight map (one sharp run, one write-back; cross-replica races are harmless since the bytes are identical). The write-back is best-effort — a failed `putStorageObject` still returns the freshly transformed bytes.
- **No invalidation on visibility flips.** The route runs `authorizeAssetRead` on **every** request before it ever reaches the cache, so a PUBLIC → RESTRICTED flip takes effect immediately at the origin regardless of what's cached in S3. The variant bytes are identical to what a fresh transform would produce; only the `Cache-Control` header (derived from live `meta.visibility`) governs downstream caching. The 24-hour PUBLIC bearer-token caveat below is unchanged — it is about CDN/browser caches, not this server-side store.
- **External-image proxy path is deliberately uncached** — an external URL has no stable asset identity and an unbounded key space.
- **Per-asset variant cap.** Transform params are caller-controlled — an anonymous visitor can request arbitrary `w`/`h`/`q`/`format` combos against a PUBLIC asset. The ladders above are the first bound: they make the identity space per asset finite (rungs² × 3 quality buckets × 4 formats) instead of the integer range. `IMAGE_TRANSFORM_CACHE_MAX_VARIANTS` (default 32) is the second: past the cap, transforms still run and are served, they just stop being written back. The count costs one `LIST` per asset per process (memoized after that), and it's a soft cap — concurrent writers can overshoot by a few entries.
- **The cap is still reachable, by design.** That finite space is far larger than 32, so a caller enumerating rung combos can occupy an asset's cache and leave it permanently in transform-on-every-request mode. The ladder makes each object they create a *legitimate* variant a real request could reuse and bounds total growth; it does not make exhaustion impossible. There is no LRU and no eviction — the count only goes up. If that matters for your traffic, add a provider lifecycle rule expiring the `transforms/` prefix after N days (variants regenerate on demand), which doubles as the release valve below.
- **Kill switch:** `IMAGE_TRANSFORM_CACHE=false` disables cache read and write, restoring exactly the transform-on-every-miss behavior. Default is `true`.
- **Reaping:** the `cleanup-assets` cron's phase 4 lists `transforms/`, parses the `<assetId>` out of each key, and batch-deletes variants whose asset has no row (respecting the same 15-minute grace window as orphan-object cleanup). Variants are regenerable, so a mistaken delete only forces a re-transform on the next read. Nothing else reaps them — if you build a delete-asset mutation, have it best-effort drop that asset's `transforms/<assetId>/` prefix rather than waiting a day for the sweep.

## The agent rule — check permissions *before* you hand out the URL

> **A PUBLIC asset URL is a 24-hour bearer token. Treat it like one.**

**An asset can flip from PUBLIC → RESTRICTED, and there will be a window — up to 24 hours — where the previous URL is still served from CDN cache.** The origin honors the flip on the very next request it sees; the problem is that a shared cache holding an `immutable` response does not send it one. Assume a PUBLIC asset id stays readable by anyone who learned it, for 24 hours after you restrict it.

`RESTRICTED` assets are not bearer URLs. They carry no signature or token — `/api/assets/:id` is just an opaque id, and access is decided by the session on each request (`private, no-cache` forces that revalidation). Revocation there is immediate. Do not treat a RESTRICTED URL as a secret to be guarded, and do not assume revoking one is delayed: the cookie is the boundary, not the URL string.

So: **before you emit an asset URL — in JSON returned from an oRPC procedure, in server-rendered HTML, in a Slack message, anywhere — verify the recipient is allowed to see it.** The endpoint will check too (every read goes through `fetchAsset()`), but the doc rule layered on top makes it harder for malicious actors to even *learn* a URL exists.

Concretely:

- A list-of-files procedure must filter by ownership/role and return only URLs the caller can see.
- A dashboard rendering thumbnails must compute the URL list server-side, gated by the same predicate.
- Avoid URL fan-outs (returning every asset id and letting the client filter) — the server must do the filtering.

This is not a substitute for the server-side check; it is layered on top. `fetchAsset()` always re-checks; if a URL escapes containment somehow, the endpoint still 404s on unauthorized requests *as soon as the cache is bypassed*.

## Permission rule (default + override)

The default rule, in `packages/api/src/lib/assets.ts`:

```ts
export function canViewAsset(asset: AssetMeta, viewer: Viewer): boolean {
  if (asset.visibility === "PUBLIC") return true;
  if (viewer.kind === "anonymous") return false;
  if (isAdminRole(viewer.role)) return true;
  return asset.ownerId !== null && asset.ownerId === viewer.userId;
}
```

If your app needs richer access rules (org-scoped sharing, ACLs, per-asset share tokens), edit this function. Every read in the codebase calls it — one place to change.

## Reading

### Display a stored image

```tsx
<img src={`/api/images/${asset.id}?w=400&format=webp`} alt={asset.alt} />
```

Query params:

- `w` / `h` — max width / height in pixels (capped at 4096). **Snapped UP to a fixed ladder** — `128, 256, 384, 640, 750, 828, 1080, 1200, 1440, 1920, 2560, 4096` — so `?w=800` delivers 828px and `?w=1` delivers 128px. Any value is accepted (no 400), you just get the next rung at or above it. See [Transform cache](#transform-cache--s3-write-back-for-sharp-output) for why the identity space has to be finite. `fit: inside` + `withoutEnlargement` still prevent upscaling past the source, and the browser scales to the layout box, so asking for a non-rung width costs a little bandwidth and nothing else.
- `q` — quality 1-100, snapped up to `60 | 80 | 95` (default 80). Note `?q=100` yields 95 — there is no rung above it.
- `format` — `webp` (default) | `avif` | `jpeg` | `png`.

### With a blurhash placeholder via `@unpic/react`

```tsx
import { Image } from "@unpic/react";
import { blurhashToCssGradientString } from "@unpic/placeholder";

<Image
  src={`/api/images/${asset.id}`}
  width={asset.width}
  height={asset.height}
  alt={asset.alt}
  background={
    asset.blurhash ? blurhashToCssGradientString(asset.blurhash) : undefined
  }
/>;
```

`blurhash`, `width`, and `height` come straight off the `Asset` row — computed at upload time, so this is just a lookup, no work on read.

### Display a non-image asset (PDF, CSV, etc.)

```tsx
<a href={`/api/assets/${asset.id}`} download>
  Download {asset.name}
</a>
```

## Uploading

### Client side

Image uploads are a **two-call sequence**: `prepareImageForUpload()` first, then the typed `uploadAsset()` helper, both inside a TanStack Query mutation. `uploadAsset()` handles the full presign / PUT / finalize round trip and computes a width/height/blurhash hint in the browser so the `Asset` row has placeholder metadata before the worker pass runs — but it PUTs whatever `File` it is given, so the prepare call is what keeps a 14 MB iPhone photo or a HEIC from failing:

```tsx
import { uploadAsset, type UploadedAsset } from "@starter/api/lib/asset-client";
import { ImagePrepareError, prepareImageForUpload } from "@starter/api/lib/asset-image-prepare";
import { useMutation, useQueryClient } from "@tanstack/react-query";

function AvatarUpload() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("common");
  const upload = useMutation({
    mutationFn: async (file: File) => {
      // "photo" always re-encodes (WebP, 4096 long edge, under the byte cap).
      const prepared = await prepareImageForUpload(file, { policy: "photo" });
      return uploadAsset({ file: prepared.file, visibility: "PUBLIC" });
    },
    onSuccess: (asset: UploadedAsset) => {
      // persist asset.id on whatever owns the image, then invalidate that
      // namespace — e.g. queryClient.invalidateQueries({ queryKey: orpc.settings.key() })
    },
    onError: (err) => {
      if (err instanceof ImagePrepareError) {
        for (const key of err.reasons) toast.error(t(key, err.params));
      }
    },
  });

  return (
    <input
      type="file"
      accept="image/*"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) upload.mutate(file);
      }}
    />
  );
}
```

**There is no upload UI in the template** — this snippet is the recipe for the one you build. Use `policy: "photo"` for an avatar or photo picker; use `policy: "library"` when the surface is a general file store that also accepts PDFs and anything else the blocklist allows. See [Prepare images in the browser](#prepare-images-in-the-browser) for what each policy does.

The returned `UploadedAsset` carries `status: "READY"` and `metadataState: "CLIENT_HINT"`. The state flips to `"SERVER_VERIFIED"` once the `analyze-asset` worker re-derives metadata from the stored bytes — usually within a couple of seconds. UIs can render the placeholder immediately using the client-supplied `blurhash` and only update if a later poll cares about the metadata provenance.

### Prepare images in the browser

`prepareImageForUpload(file, { policy })` (`packages/api/src/lib/asset-image-prepare.ts`, imported as `@starter/api/lib/asset-image-prepare`) makes an image uploadable *before* `uploadAsset()` ever runs. `uploadAsset()` stays a dumb PUT on purpose — prepare is an explicit call-site decision, not something hidden inside the upload helper.

| | `policy: "photo"` (avatar/photo pickers) | `policy: "library"` (general file store) |
|---|---|---|
| Raster under all caps | Re-encoded to WebP anyway | **Original bytes kept** |
| Over the byte cap or 4096 long edge | Resized/compressed to WebP | Resized/compressed to WebP |
| HEIC the browser decodes (Safari) | Re-encoded to WebP | **Kept as HEIC** (MIME normalized) |
| HEIC the browser can't decode (Chrome/Firefox) | Lazy `heic-to` WASM decode → WebP | Lazy `heic-to` WASM decode → WebP |
| Animated GIF | Always flattened to a still | Kept if under the cap; flattened if over |
| AVIF | Re-encoded to WebP | Kept if it fits and the browser decodes it |
| Non-image (PDF, …) | `ImagePrepareError` (`UNSUPPORTED`) | Passed through untouched |
| SVG | `ImagePrepareError` (`SVG`) | `ImagePrepareError` (`SVG`) |

The mechanics worth knowing:

- **Output is WebP at quality 0.82** (matching the transform endpoint's default 80), stepping down a quality ladder (`0.7 / 0.6 / 0.5 / 0.4`) until the result fits `maxBytes`; engines that can't encode WebP fall back to JPEG at 0.85. Still too big below 0.4 → `ImagePrepareError` code `TOO_LARGE` with `params.maxMb` for the toast. AVIF is never used as *output* — encoding support isn't universal.
- **Decode happens at the target size**, not full resolution — `createImageBitmap` resize options plus `imageOrientation: "from-image"` keep a 48MP photo from materializing a full-res RGBA buffer, with canvas-scale fallbacks for older engines. The WASM HEIC path may still decode full-res — a known Chrome/Firefox cost, not fixed here. `computeImageHint` (inside `uploadAsset`) likewise decodes at its 32px sample size, so a library-kept 48MP JPEG can't OOM the tab after the fact.
- **Classification is MIME → extension → magic bytes** (`asset-image-policy.ts`) — an empty `file.type` (common for HEIC dragged from Finder) still classifies. HEIC detection matches the `ftyp` major brands `heic|heix|heim|heis|hevc|hevx` only — never `mif1`/`msf1`/`avif`. On a library pass-through with an empty declared type, the file is re-wrapped with the corrected MIME so presign never records `application/octet-stream`.
- **SVG is rejected before any decode** (both policies, on MIME *or* `.svg`), matching the server-side upload blocklist. Never rasterize SVG onto a canvas.
- **Safari-kept HEIC never hits `/api/images/:id`.** `serializeAsset` returns `imageUrl: null` for `image/heic`/`image/heif` — sharp in this image can't be assumed to decode HEVC, so render a mime placeholder instead. Do not add HEIC to `inlineAssetMimeTypes`, and never `URL.createObjectURL` a raw HEIC into an `<img>` on Chrome.
- **The byte cap is dual.** The client default `ASSET_UPLOAD_MAX_BYTES_DEFAULT` (`packages/api/src/lib/image-limits.ts`) mirrors the `ASSET_UPLOAD_MAX_BYTES` env default by convention — see the configuration table above. Same for the 4096 long edge (`IMAGE_MAX_DIMENSION`, aliased as the transform endpoint's `TRANSFORM_MAX_DIMENSION`).
- **Canvas re-encode side effects:** EXIF (including GPS) does not survive the canvas, orientation is baked in via `imageOrientation: "from-image"`, and wide-gamut profiles land in sRGB. The server's sharp pipeline remains the read-path source of truth; client WebP is a write-path convenience and `analyze-asset` still re-derives metadata.
- **Native (Expo) is a separate path**: use ImagePicker + ImageManipulator there — **do not import `@starter/api/lib/asset-image-prepare` in `apps/native`** (Metro would try to resolve the embedded heic-to decoder).

### Image prepare and CSP

The lazy HEIC decoder compiles WebAssembly, and Chromium only allows that when `script-src` carries **`'wasm-unsafe-eval'`** — importing the CSP-safe `heic-to/csp` build does *not* by itself make WASM compilation legal. The template's policy (in `apps/server/src/security-headers.ts` — that file owns the directive list; `apps/server/src/index.ts` only mounts it) therefore includes `'wasm-unsafe-eval'` on `script-src`. This is **not** `'unsafe-eval'` — string-to-code evaluation stays blocked — and `'unsafe-eval'` must never be added, even though heic-to's README mentions it for the non-`/csp` build.

The installed `heic-to/csp` build also runs its decoder in a **blob worker** (worker source embedded as a string, started via `new Worker(URL.createObjectURL(new Blob(...)))`), so the policy sets `worker-src 'self' blob:`. `blob:` lives on `worker-src` only — never on `script-src`. `security-headers.test.ts` locks all of this in with token-split assertions.

### Drag-and-drop (never navigate)

Dragging a file onto the SPA must never navigate the tab to the file. `FileDropGuard` (`apps/web/src/components/file-drop-guard.tsx`) — a null component statically mounted in `__root.tsx` beside the `Toaster`, inside `ClientOnly` — listens for `dragover` / `drop` on `document`, `preventDefault()`s every drag that carries OS files (in-page HTML/link drags are left alone), and dispatches drops through a module-level registry (`apps/web/src/lib/file-drop-registry.ts`):

- **Claimed drop** — the innermost registered zone under the cursor gets the `File[]`. Zones opt in via `useFileDropTarget(element, onFiles)` (`apps/web/src/hooks/use-file-drop-target.ts`), passing the element from a callback ref + `useState<HTMLElement | null>` — the hook owns the `useEffect`, so components and routes stay inside the [useEffect policy](./react-hooks-and-effects.md).
- **Unclaimed drop** — a polite `common:fileDrop.ignored` toast. Never an auto-upload, never a navigation.

The registry is the **single drop dispatcher**. No zone ships registered — the guard is mounted so that the very first dropzone you add inherits the no-navigate behaviour for free. A zone registers through the hook and has **no React `onDrop`**; it keeps React `onDragOver` / `onDragLeave` only for the visual overlay/highlight (the local `onDragOver` still `preventDefault()`s so the highlight can show and the guard can set `dropEffect`).

> **Upgrade note for apps built on this template:** a custom dropzone that predates the guard **must** switch to `useFileDropTarget` and **remove its own React `onDrop`** in the same change. If it keeps `onDrop` without registering, every drop shows the unclaimed toast *and* still runs the zone's handler; if it registers but keeps `onDrop`, the drop is handled twice (e.g. a double upload).

A zone that accepts only one family of files filters inside its own `onFiles` and toasts a specific message for the rest — never fall through to a generic upload. A dialog that uses a plain file input is not a drop target; drops there stay unclaimed by design.

### Server side

The endpoints are wired up automatically — no code to write. The flow:

1. **`POST /api/assets/presign`** — authenticate via Better-Auth session, validate `mimeType` / `size` / `visibility` / optional hint, enforce `ASSET_UPLOAD_MAX_BYTES`, generate a `storageKey`, create the `Asset` row with `status: PENDING` and hint columns populated, return signed URL + required headers + `assetId`.
2. **Browser PUT** — bytes go straight to S3. The signature covers `Content-Type` and `Content-Length`. AWS S3 rejects a body that disagrees; **some S3-compatible backends (R2, MinIO, B2) do not enforce the signed `Content-Length`**, so treat the size check as advisory on those. `finalizeAsset` HEADs the object and refuses on a size mismatch, so an oversized body never reaches `READY` — but the bytes do land in the bucket until the `cleanup-assets` cron reaps them. Set a bucket-level max-object-size or lifecycle rule if your provider supports one.
3. **`POST /api/assets/finalize`** — authenticate, look up the row (404 if not owned by the caller), HEAD the storage object (refuse on missing object or size mismatch), sniff the leading bytes (refuse scriptable payloads with `MIME_MISMATCH`; persist the sniffed type on other recognized mismatches), flip `status` to `READY`, enqueue `analyze-asset`. Idempotent on already-`READY` rows so a retried call doesn't 500.
4. **Worker** — downloads the bytes, runs `analyzeImage()`, overwrites the hint columns, sets `metadataState: "SERVER_VERIFIED"`.

Body-limit-wise, only `ASSET_UPLOAD_MAX_BYTES` (default 10 MB, customizable) applies — the bytes never reach Hono so the body limit is irrelevant. Lower `ASSET_UPLOAD_MAX_BYTES` to whatever your bucket policy allows. Any second upload path you add (a server-side import, an agent tool) must enforce the same cap against its own body length.

### Upload type validation — blocklist today, how to make it an allowlist

Upload validation is two layers:

1. **Declared-label blocklist.** `isAllowedUploadMimeType()` (`apps/server/src/upload-mime.ts`) is the single gate on the declared label; the presign route is its only caller today, and any upload path you add calls the same function rather than its own list. It is a **blocklist**: it rejects `text/html`, `image/svg+xml`, and the JavaScript types, and permits everything else — so `image/svg+xml` is never an accepted *label*, and SVG uploads are refused outright (matching the client-side prepare step, which also rejects SVG before any decode).
2. **Magic-number sniff of the bytes.** `sniffMime()` + `resolveStoredMime()` (`packages/api/src/lib/sniff-mime.ts`, hand-rolled — no `file-type` dependency) run where bytes first reach the server: `finalizeAsset()` (`packages/api/src/lib/assets.ts`) reads the first `SNIFF_PREFIX_BYTES` of the stored object via a ranged GET. A second upload path that holds the bytes in memory sniffs them there instead, and applies the same policy. Policy: a sniffed scriptable signature (`text/html`, `image/svg+xml` — including SVG-labeled-as-PNG text sniffing) is **rejected** (`MIME_MISMATCH` → 415 on the HTTP finalize route); any other recognized disagreement **persists the sniffed type** as the authoritative `mimeType` (the raw `/api/assets/:id` route serves the row's type, not the S3 object's, so the served `Content-Type` is server-owned); an unrecognized format (zip-based docx/xlsx, plain text, CSV) sniffs to null and keeps the declared label, which layer 1 already vetted.

`metadataState: "SERVER_VERIFIED"` still refers to the dimensions and blurhash the worker re-derives, not the MIME type — but since finalize, the stored MIME is either the sniffed type or a label whose bytes the sniffer couldn't contradict.

Serving remains defended independently regardless: `nosniff` on every response, `Content-Security-Policy: sandbox` on `/api/assets/:id`, `Content-Disposition: attachment` for anything outside the raster set, and an image endpoint that always re-encodes through sharp. The sniff closes the stored-type lie; those layers would contain it even for formats the sniffer doesn't know.

If your app knows what it accepts, tighten it — the label gate is still a blocklist:

1. **Invert the set.** Replace `blockedUploadMimeTypes` with `allowedUploadMimeTypes` and return `allowed.has(mimeType)`. Start from `inlineAssetMimeTypes` in `apps/server/src/asset-routes.ts` plus any document types you serve. No caller changes — every upload path goes through this one function.
2. **Extend the sniffer.** `sniff-mime.ts` returning null means "declared label stands." Once you run an allowlist, unrecognized bytes can be refused outright instead — add your accepted formats to its fixture-table-tested signature list so null becomes a rejection candidate at the enforcement points.

Do both. An allowlist over a client-supplied string constrains the label, not the bytes behind it.

### Bucket CORS

The browser PUTs cross-origin (your app domain → S3 endpoint), so the bucket needs CORS enabled. Minimal policy:

```json
[
  {
    "AllowedOrigins": ["https://your-app.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```

Keep `AllowedOrigins` to your exact app origin — never `*`. Most providers configure CORS through the bucket settings UI; for AWS S3 use `aws s3api put-bucket-cors`, for R2 use the dashboard.

### CSP — the other half of the cross-origin upload

CORS is the S3 side of the browser-direct PUT; the Content-Security-Policy `connect-src` is the app side. If an upload fails and the console says the request **"violates the following Content Security Policy directive: connect-src …"** (not a CORS error), that is CSP, not the bucket. The two look similar but are enforced by different parties: CORS by S3, CSP by the browser reading the app's response headers.

The template handles this automatically — when `S3_BUCKET` is set, `apps/server/src/index.ts` adds the presigned URL's origin to `connect-src` (via `s3ConnectSrcOrigins` in `apps/server/src/security-headers.ts`), derived from the same `S3_ENDPOINT` / `S3_REGION` / `S3_FORCE_PATH_STYLE` the S3 client uses. On a virtual-hosted custom endpoint (R2, B2, Spaces) you'll see **two** S3 origins in the header — `https://<bucket>.<endpoint-host>` plus the bare endpoint origin — because the SDK falls back to path-style addressing when the bucket name isn't DNS-label-safe; both are your storage provider, and this is intentional, not a leak. Read-side traffic needs nothing: images render through the same-origin `/api/images/:id` proxy, never a direct S3 fetch.

Only revisit this if you run a nonstandard setup — a CDN or custom domain in front of the bucket, or a proxy that rewrites the presigned host. Then the origin the browser actually connects to differs from the one derived from env, and you must add that origin to `connect-src` yourself. See [Scoped CSP override](./production-hardening.md#5--scoped-csp-override-widen-one-directive-for-one-path) if you also need to widen a single directive for a single route.

### Cleanup — orphan PENDING rows and unreferenced S3 objects

Two failure modes accumulate cruft:

1. **Orphan `PENDING` rows.** A client presigns and never finalizes (closed tab, network drop, abandoned). The presigned URL dies after 5 minutes; the row sits forever with no S3 object behind it.
2. **Unreferenced S3 objects.** A delete-asset call removes the row but the storage delete throws (network blip, bucket permissions glitch); or analyze-asset downloads bytes never cleaned; or someone uploads via console and forgets. The bytes accrue storage charges.

The starter ships a sweep handling both, in `packages/api/src/lib/asset-cleanup.ts`, in four phases:

| Phase | What it does | Default threshold |
|---|---|---|
| 1. Pending rows | Delete `Asset` rows still `PENDING` whose `uploadHeartbeatAt` is older than the cutoff. Falls back to `createdAt` when the heartbeat is null (legacy rows). Best-effort deletes the storage object too. | 5 minutes |
| 2. Orphan objects | `ListObjectsV2` under `assets/`, skip objects newer than the grace window (in-flight uploads), re-check the DB per key at delete time, delete those with no Asset row. | 15-minute grace |
| 3. Incomplete multiparts | `ListMultipartUploads` under `assets/`, abort uploads initiated more than the cutoff ago. The starter doesn't use multipart, so this is defensive against external tooling sharing the bucket. | 24 hours |
| 4. Orphan transform variants | `ListObjectsV2` under `transforms/`, skip objects newer than the grace window, parse the `<assetId>` from each key, batch-delete variants whose asset has no row. Regenerable, so no per-key re-check. See [Transform cache](#transform-cache--s3-write-back-for-sharp-output). | 15-minute grace |

**How the heartbeat works.** `uploadAsset()` fires `POST /api/assets/heartbeat` every 60 seconds during the upload, then stops once finalize resolves. The PENDING row is also seeded with a heartbeat at presign time, so the 5-minute cutoff is measured from "client last said it was alive," not "row was created" — long uploads (large files on slow connections) are safe as long as the tab stays open.

**How it runs.**

- **Automatically:** the `worker` upserts a BullMQ Job Scheduler (`cleanup-assets`) on boot using the stable `CLEANUP_ASSETS_JOB_SCHEDULER_ID`. Default schedule: `15 3 * * *` (daily at 03:15 UTC). Change the pattern in `packages/queue/src/jobs.ts`.
- **On demand:** `dryRunCleanup()` and `runCleanup()` (`packages/api/src/lib/asset-cleanup.ts`) are the two halves, so an admin page can render a preview (counts, byte totals, sample candidates) from a read-only scan and then enqueue the real job behind a button. No such page ships; the cron is the only trigger today.

> **Requires the worker.** The cron goes through the BullMQ `cleanup-assets` queue and depends on the `apps/worker/` process consuming it. A dry-run preview would work without the worker (read-only server-side scan), but do not ship a **Run cleanup** button without a consumer — it would create a job nobody runs. If you've removed background-job queues per [patterns/removable/queue.md](./removable/queue.md), pick an alternative strategy below instead.

**Safety.** The destructive path re-checks every candidate against fresh database state at delete time — a heartbeat landing between LIST and DELETE keeps the row safe; an object whose Asset row gets created mid-sweep stays. The 15-minute grace window on phase 2 is longer than the 5-minute presign TTL plus a generous buffer, so an in-flight upload can't be reaped.

### Alternative cleanup strategies

The shipped design is recommended but not the only shape. Pick the alternative matching your scale or constraints:

- **Synchronous delete on session end.** Track the upload session client-side and `navigator.sendBeacon('/api/assets/cancel', { assetId })` from a `pagehide` / `beforeunload` handler. Faster (~immediate) but unreliable: sendBeacon doesn't fire on mobile background-tab kills, network drops, or crashes. Layer on top of the heartbeat sweep; don't replace it.
- **No DB row until finalize.** Skip the PENDING row. The presign endpoint generates a deterministic storage key, returns the signed URL, and only inserts an Asset row on finalize. Trade-offs: no `metadataState: "CLIENT_HINT"` state, no orphan rows ever — but you lose attaching the upload to anything before it lands (no "progress bar tied to this asset id"), and S3-object cleanup still needs phase 2 for failed finalizes.
- **S3 lifecycle rule.** Configure the bucket to expire objects under `assets/pending/` after N days. Simple, no app code, but requires a key-prefix split (PENDING uploads write to a different prefix, moved on finalize) — extra moving parts, and lifecycle deletion only runs daily, not on demand.
- **Event-driven cleanup.** S3 → SNS → Lambda (or R2 event notifications → worker) reconciling every object PUT against the DB. Most precise; needs cloud-specific infrastructure and changes the deploy story.
- **Track-and-reap via outbox.** Insert an `AssetCleanup` row alongside every presign; the worker reads from it instead of `Asset.status = PENDING`. Useful if you need a richer audit trail of upload attempts. Heavier than the shipped design and rarely worth it.

If your bucket reaches into the millions of objects, phase 2's LIST iteration starts to dominate cleanup runtime — at that scale, switch to event-driven or partition the prefix so each cron run scans a fraction.

To audit new code paths that touch S3 for race-condition safety (heartbeat, grace period, multipart abort, TTL, concurrent-delete), use the dedicated cleanup task: [agent-tasks/cleanup.md § Step 3](./agent-tasks/cleanup.md#step-3--s3--asset-race-condition-audit).

### Running without the worker

If you've removed background-job queues and the worker ([patterns/removable/queue.md](./removable/queue.md)), remove the `analyze-asset` enqueue from asset finalization as that recipe requires; do not deliberately enqueue work with no consumer. Uploads still complete, and the `Asset` row stays at `metadataState: "CLIENT_HINT"` with whatever the client supplied as a hint. Fine for visual data — the worst outcome is a slightly-wrong placeholder gradient — but unsuitable when you need pixel-derived metadata to be authoritative. Keep the worker or provide a synchronous/external analyzer if you care about that distinction.

### When this design doesn't fit

- You need EXIF stripping or content sanitization at upload time — the stored bytes are exactly what the client uploaded. Sharp strips EXIF on transform reads, so derivative `/api/images/:id` URLs are safe; the raw `/api/assets/:id` URL is not. If raw access matters, post-process via the worker or run server-side virus scanning before flipping `status` to `READY`.
- Your bucket isn't network-reachable from browsers (private VPC, IP-allowlisted endpoint) — presigned URLs require browser → S3 reachability. Either make the bucket public-egress or keep bytes flowing through the app.

## External image proxying

By default, `/api/images/<external-url>` is rejected. To opt in to specific hosts:

```env
IMAGE_PROXY_ALLOWED_HOSTS=cdn.partner.com,images.example.com
```

Then:

```tsx
<img src={`/api/images/${encodeURIComponent("https://cdn.partner.com/banner.jpg")}?w=400`} />
```

The endpoint fetches upstream, transforms with sharp, and serves with `public, max-age=86400, immutable` cache headers. SSRF-defended via the allowlist; never set `IMAGE_PROXY_ALLOWED_HOSTS` to a wildcard.

## Why this shape?

- **Single permission boundary.** Both endpoints call `fetchAsset()` directly — no HTTP self-request. Fewer round-trips, no internal-auth complexity, one place to change the rules.
- **Visibility on the row, not in the path.** Flipping PUBLIC → RESTRICTED is a one-row update. No file moves, no key rewrites.
- **Blurhash at write time.** Computed once on upload; stored on the row. Reads are cheap.
- **Provider-agnostic.** Any S3-compatible service works — pick the cheapest/closest without changing app code.
- **Opt-in.** No bucket configured = endpoints disabled. Fresh clones boot without S3 credentials.

## Files

| File | Purpose |
|---|---|
| `packages/db/prisma/schema/assets.prisma` | `Asset` model + `AssetVisibility` / `AssetStatus` enums |
| `packages/api/src/lib/storage.ts` | S3 client (provider-agnostic) + `presignPut` / `headStorageObject` |
| `packages/api/src/lib/assets.ts` | `fetchAsset`, `presignAsset`, `finalizeAsset` (with magic-number MIME policy), `analyzeStoredAsset`, `canViewAsset`, cache-header helpers |
| `packages/api/src/lib/sniff-mime.ts` | Hand-rolled magic-number sniffer (`sniffMime`) + upload storage policy (`resolveStoredMime`), called from `finalizeAsset` |
| `packages/api/src/lib/images.ts` | `analyzeImage` (blurhash + dims), `transformImage` (resize on read) |
| `packages/api/src/lib/asset-client.ts` | `uploadAsset()` 3-step orchestrator (web SPA) — call `prepareImageForUpload()` first for images |
| `packages/api/src/lib/asset-image-hint.ts` | `computeImageHint()` browser helper (canvas + blurhash.encode, decode at sample size) |
| `packages/api/src/lib/image-limits.ts` | Client-safe `IMAGE_MAX_DIMENSION` + `ASSET_UPLOAD_MAX_BYTES_DEFAULT` (no env, no sharp) |
| `packages/api/src/lib/asset-image-policy.ts` | Pure classifier (MIME/extension/magic), `scaleToMaxEdge`, `libraryNeedsTranscode` |
| `packages/api/src/lib/asset-image-prepare.ts` | `prepareImageForUpload()` browser decode/resize/encode + lazy `heic-to/csp` import |
| `apps/web/src/lib/file-drop-registry.ts` | Module-level drop-target registry (hit-test, innermost wins) |
| `apps/web/src/hooks/use-file-drop-target.ts` | Hook registering a drop zone (the approved `useEffect` boundary) |
| `apps/web/src/components/file-drop-guard.tsx` | Document-level drag/drop swallow + unclaimed-drop toast |
| `apps/server/src/security-headers.ts` | App CSP — carries `'wasm-unsafe-eval'` + `worker-src blob:` for the HEIC decoder |
| `apps/server/src/asset-routes.ts` | The five Hono routes (presign, heartbeat, finalize, asset, image) |
| `apps/worker/src/handlers/analyze-asset.ts` | BullMQ handler that re-derives metadata from S3 bytes |
| `packages/api/src/lib/asset-cleanup.ts` | `dryRunCleanup` / `runCleanup` — the four-phase orphan sweep |
| `apps/worker/src/handlers/cleanup-assets.ts` | BullMQ wrapper around the daily orphan sweep |

## See also

- [patterns/schema-changes-recipe.md](./schema-changes-recipe.md) — for evolving the `Asset` model
- [add-ins/cms.md](./add-ins/cms.md) — typed pages/posts that embed assets as `asset:<id>`
- [add-ins/video.md](./add-ins/video.md) — HLS pipeline that reuses this S3 bucket; a different permission and cache window
- [patterns/server-procedures.md](./server-procedures.md) — if you're adding admin-only mutations on `Asset` (delete, change visibility)
- [infra-notes.md](../infra-notes.md) — full env-var contract for the deploy agent
