# Add-in: Mux (managed upload, encoding, playback — optional DRM)

The template does **not** ship Mux. This is the reference for adopting [Mux Video](https://www.mux.com/video) as a fully managed video pipeline: browser-direct upload to Mux, Mux-side encoding to HLS, playback delivered from `stream.mux.com`, and — uniquely among the hosted options — optional multi-DRM (Widevine, FairPlay, PlayReady) over one CMAF manifest.

Unlike the [Bunny Stream swap](./video.md#hosted-alternative-bunny-stream), which assumes the self-hosted pipeline exists and swaps the transcode layer, Mux replaces the **whole** pipeline: no S3 bucket for video, no ffmpeg, no worker queues, no artifact routes on your server. Playback bytes never touch your app — your server only mints short-lived signed URLs and receives webhooks.

It has never shipped in this template, so unlike the other add-ins there is no template commit to recover from — this document is the full reference, self-contained below.

## Read this first: provider lock-in and a provisioning long pole

- Build this when you want managed encoding + delivery and accept that renditions, playback ids, and (if enabled) DRM live inside Mux's account boundary. Assets are re-uploaded, not exported.
- **DRM has a human, out-of-band provisioning chain** (§ [DRM](#drm-provisioning-is-human-and-slow-apple-is-the-long-pole)) — Apple FairPlay approval alone takes weeks. Start it in parallel with development, not after.
- Mux bills per minute of source encoded, per minute delivered, and per minute stored. `video_quality: "premium"` and 4K tiers multiply encode cost.
- No ffmpeg in any image, no `VIDEO_*` worker env from [video.md](./video.md) step 2, no `S3_BUCKET` requirement. If you also keep the self-hosted or Bunny paths, branch on a `VIDEO_PROVIDER` discriminator the same way [video.md](./video.md) does for Bunny.
- Call the REST API (`https://api.mux.com`) directly with `fetch` + HTTP Basic auth (`token_id:token_secret`) — deliberately no Mux SDK, the same reasoning as the Bunny section's "the client package is unmaintained" note.

## What you get

- **Direct Upload API**: your server creates a one-time upload URL (`POST /video/v1/uploads`); the browser PUTs the file straight to Mux with `cors_origin` pinned to your app. One PUT, no multipart presign dance, zero upload bytes through your server.
- Webhook-driven state machine: `WAITING_FOR_UPLOAD → PROCESSING → READY / ERRORED / DELETED`, mirrored onto a Prisma row via signature-verified webhooks, with an on-demand reconcile for missed events.
- Signed playback: RS256 JWTs your server mints with your own Mux signing key — `aud: "v"` authorizes the manifest, `aud: "d"` authorizes a DRM license. Short-lived (10 minutes is a sane default).
- Optional DRM: one HLS manifest (CMAF, CBCS) carries all three systems; the client picks Widevine / FairPlay / PlayReady and hits the matching `license.mux.com` endpoint.
- Optional downloadable MP4 (`static_renditions`) for non-DRM titles — served off the signed playback id.

## Properties that must hold

Each of these is checkable. An agent building this surface should be able to point at the code that satisfies every line.

- [ ] **The webhook verifies the signature before anything else.** `mux-signature: t=<ts>,v1=<hmac>` where the HMAC is `sha256(secret, "${t}.${rawBody}")`; reject on missing/malformed header, timestamp outside a 5-minute tolerance, and no `timingSafeEqual` match against **any** listed `v1` (Mux may send two during key rotation). Parser is v1-scheme-only and fails closed if Mux introduces a v2. Never log the secret, the header value, or the raw body.
- [ ] **Mux retries every non-2xx response for 24 hours — there is no 4xx exemption.** A signature-valid-but-unprocessable payload (unknown event shape, unknown asset, JSON that won't parse) must return **2xx-and-ignore**, or Mux will hammer it for a day. Only a *bad signature* returns 401. Unknown asset ids are 2xx no-ops, never a Prisma P2025 → 500 → retry loop.
- [ ] **Every webhook write is idempotent and monotonic.** Dedupe on `lastProviderEventId`. `video.upload.asset_created` only advances a row still `WAITING_FOR_UPLOAD`; `video.upload.errored` only fails one that never produced an asset; nothing walks a row back from `READY`; nothing resurrects `DELETED`. `video.asset.static_rendition.*` may write `READY` freely but may never demote an existing `READY`.
- [ ] **The status write and its side effects share one transaction.** The failure mode this exists to prevent: writing the dedupe id, then throwing before the activation swap, leaves every Mux retry deduped against a half-applied event. `updateMany` guards (status in allowed set, count checked) rather than read-then-write.
- [ ] **Playback-id classification happens in exactly one place.** A Mux payload carries `playback_ids: [{id, policy}]` with policies `public | signed | drm`; the row stores them as separate columns (`muxPlaybackId`, `muxSignedPlaybackId`, `muxDrmPlaybackId`). Webhook and reconcile paths share the same extraction function.
- [ ] **A `DRM_REQUIRED` asset never falls back to its signed or public playback id.** DRM assets legitimately carry a co-minted `signed` id (for admin preview and MP4 renditions) — serving it to a customer hands them the title unencrypted. A missing DRM playback id is an error, not a downgrade. Fail closed on the signed path too: Mux rejects `?token=` on a public id, so "fall back to public" mints a URL Mux refuses to play.
- [ ] **Never request a static rendition for a DRM title**, and reject the combination at the procedure layer as well — the backstop in the lib is not the gate. A downloadable MP4 is an unencrypted copy of a protected title.
- [ ] **The manifest token and the DRM license token share one expiry.** Pin the `aud: "d"` token's `exp` to the already-decided `aud: "v"` `exp` rather than reading the clock twice — straddling a second boundary expires the pair one second apart mid-watch. Clients must re-apply manifest URL and license URLs **as a pair**.
- [ ] **Playback URLs are minted at read time, per viewer, and expire in minutes** — the same discipline as the asset-URL rule in [assets.md § The agent rule](../assets.md#the-agent-rule--check-permissions-before-you-hand-out-the-url). Never persist a signed URL; never log one.
- [ ] **Replacement uploads cut over only at `READY`, and never downgrade protection.** If a row serves an asset and a replacement is uploaded, the parent keeps serving the old source until the new one is `READY` (a replacement is never dark), and an activation that would strip DRM from a protected title is refused and recorded on the asset row where the operator sees it.
- [ ] **The upload URL is CORS-pinned to your origin.** `cors_origin` on the upload-create call defaults to the app origin; `"*"` is the local-dev fallback only. An upload URL is a bearer credential for one PUT — don't let it be replayable from any origin.
- [ ] **`passthrough` is your row id** — it is how `video.asset.ready` finds the row without a lookup table. Put the id there at upload-create time and read it back in the webhook.
- [ ] **The webhook route has its own limiter** (IP-keyed, own `keyPrefix` — it is a public POST surface), and the raw body is read **before** any JSON parsing so the signature is computed over the exact bytes Mux sent. [rate-limiting.md § Give every surface its own bucket](../rate-limiting.md#give-every-surface-its-own-bucket). Playback itself needs **no** limiter — segments come from Mux's CDN, not your app.
- [ ] **Token-minting procedures get a procedure-level budget** if a single page load mints several (manifest + license + subtitles): `createProcedureBudget`, fail-closed, keyed on the caller. [rate-limiting.md § When the surface is a procedure, not a route](../rate-limiting.md#when-the-surface-is-a-procedure-not-a-route).
- [ ] **Every env var is a two-file change** (`packages/env/src/vars/server.ts` + `scripts/lib/env-manifest.ts`, then `pnpm env:sync`); the worker does not read any of them. Never hand-edit `.env.example`. [environment-variables.md § Adding a new environment variable](../environment-variables.md#adding-a-new-environment-variable).
- [ ] **CSP gains two hosts**: `media-src`/`connect-src` (player-dependent) for `stream.mux.com`, and `connect-src` for `license.mux.com` — the specific hosts, added in `apps/server/src/security-headers.ts`, never a wildcard.
- [ ] **Every new procedure starts from a registered builder** and lands in the access matrix (`notes/02-users-and-roles.md`), plus a row for the webhook route itself. [custom-roles.md](../custom-roles.md).
- [ ] **Every user-facing string goes through `t()`**; every list is bounded; the watch route stays under `_app` with `ssr: false` and out of `PUBLIC_PATHS`, exactly as [video.md § 6. Web](./video.md#6-web) prescribes.

## Environment variables

| Variable | Required | Role |
|---|---|---|
| `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` | yes | API credentials (HTTP Basic on `api.mux.com`): create uploads, reconcile, delete assets. |
| `MUX_SIGNING_KEY_ID` / `MUX_SIGNING_KEY_PRIVATE_KEY` | yes | RS256 JWT signing for playback + DRM tokens. Private key as PEM (literal `\n` escaped) or base64 — normalize both forms before `createPrivateKey`. |
| `MUX_WEBHOOK_SECRET` | yes | HMAC secret verifying `mux-signature`. |
| `MUX_DRM_CONFIGURATION_ID` | for DRM | Per-environment id Mux issues when DRM is provisioned. Absent ⇒ refuse DRM uploads — check **before** creating the row, or the failure strands an `ERRORED` asset on a deploy-config gap. |

All optional-with-`isMuxDrmConfigured()`-style presence checks at the boundary, like `S3_BUCKET`: unset Mux creds must 503 the video surface and the app must still boot.

## The recipe

### 1. Prisma model

Additive `pnpm db:push` ([schema-changes-recipe.md](../schema-changes-recipe.md)). One `VideoAsset`-shaped table (or Mux columns on [video.md](./video.md)'s `Video` if you keep the shared model), following [schema-guidelines.md](../schema-guidelines.md):

- `status` (`WAITING_FOR_UPLOAD` default), `securityPolicy` (`STANDARD_SIGNED | DRM_REQUIRED`), `staticRenditionStatus` (`PENDING` default).
- `muxUploadId`, `muxAssetId`, `muxPlaybackId`, `muxSignedPlaybackId`, `muxDrmPlaybackId` — each `@unique` (they are lookup keys for webhook routing and reconcile).
- `lastProviderEventId` / `lastProviderEventAt` (dedupe), `providerErrorCode` / `providerErrorMessage` (operator-visible failures — the only place a refused activation or a Mux encode error is explainable later).
- Resolution/quality tiers (`maxResolutionTier`, `qualityTier`) if you expose the knobs.

### 2. The lib (`packages/api/src/lib/mux.ts` shape)

One module owns every Mux interaction; routers never `fetch` Mux directly:

- `createMuxDirectUpload(opts)` — `POST /video/v1/uploads` with `cors_origin`, `passthrough: rowId`, `new_asset_settings`:
  - standard: `playback_policies: ["signed"]`
  - DRM: `advanced_playback_policies: [{policy: "drm", drm_configuration_id}, {policy: "signed"}]` — the co-minted signed id exists **only** for admin preview / MP4 renditions; keep signing it confined to admin procedures. DRM requires `plus`/`premium` quality (reject `basic` up front).
  - `static_renditions: [{resolution: "highest"}]` only when downloads are allowed **and** the title is not DRM-protected.
- `signMuxToken(playbackId, aud, {expiresInSeconds | expiresAt})` — RS256, header `{alg: "RS256", kid, typ: "JWT"}`, payload `{sub: playbackId, aud, exp, kid}`. Accept a pinned `expiresAt` so callers can make the `v`/`d` pair share a clock.
- `buildMuxPlaybackTokenResponse(asset)` — customer-facing mint: picks the DRM id when `DRM_REQUIRED` (error if missing), else the signed id (error if missing), builds `https://stream.mux.com/<id>.m3u8?token=<v>` and, for DRM, the four `license.mux.com` URLs (`/license/widevine/`, `/license/fairplay/` + `/appcert/fairplay/`, `/license/playready/`) each carrying the `d` token.
- `buildMuxAdminPreviewResponse(asset)` — deliberately **does not** follow `securityPolicy`: prefers the signed id, then public, and refuses a DRM-only asset rather than returning an unplayable manifest.
- `handleMuxWebhook(rawBody, signatureHeader)` — everything in the properties list above. This is the biggest function in the surface; write it directly against the properties list, not a paraphrase of them.
- `reconcileMuxVideoAsset(row)` — on-demand `GET /video/v1/uploads/{id}` (did the upload produce an asset?) then `GET /video/v1/assets/{id}`, feeding the **same** write path as the webhook. Expose it as an admin procedure ("Sync from Mux") — it is the recovery path for any missed webhook, and because it carries no event id it is exempt from the webhook path's snapshot-trust rules.

Add the export keys to `packages/api/package.json`'s `exports` map if the server imports them (`@starter/api/lib/mux`), mirroring `./lib/asset-cleanup`.

### 3. The webhook route (Hono)

```ts
app.use("/api/webhooks/mux", createRateLimiterMiddleware(muxWebhookLimiter));
app.post("/api/webhooks/mux", async (c) => {
  const rawBody = await c.req.text();          // exact bytes, before any parsing
  try {
    return c.json(await handleMuxWebhook(rawBody, c.req.header("mux-signature")));
  } catch (err) {
    // Only signature failures (401) are worth Mux retrying. A 500 that Mux
    // retries for 24h means your own bug becomes a denial-of-service on you.
    return err instanceof ORPCError && err.code === "UNAUTHORIZED"
      ? c.json({ error: err.message }, 401)
      : c.json({ error: "Webhook processing failed" }, 500);
  }
});
```

Register the URL in the Mux dashboard (or via the API) for the events `video.upload.asset_created|errored|cancelled`, `video.asset.ready|errored|deleted`, `video.asset.static_rendition.ready|errored|skipped`.

### 4. oRPC surface

On registered builders ([custom-roles.md](../custom-roles.md)): `videos.start` (create row + direct upload, rejects DRM-without-configuration and DRM-with-download up front), `videos.playbackToken({id})` (per-viewer mint — this is where your authorization lives), an admin `videos.syncFromMux({id})` (reconcile), and admin list/detail. The browser then does one `PUT` of the `File` to the `uploadUrl` (plain fetch with retry/backoff on network errors and 5xx/429 — no presign protocol, no parts).

### 5. Web player

The proven web recipe is `video.js` + `videojs-contrib-eme` (+ `videojs-contrib-quality-levels` / `videojs-hls-quality-selector`); that combination is what Mux itself documents and tests. Vidstack ([video.md](./video.md)'s player) is the alternative if you already restored that pipeline — the DRM shape below is player-agnostic.

- Map the token response to EME `keySystems` and offer **all three** systems off the one manifest — the browser picks:

```ts
const keySystems = {
  "com.widevine.alpha": drm.widevineLicenseUrl,
  "com.microsoft.playready": drm.playreadyLicenseUrl,
  "com.apple.fps.1_0": {
    licenseUri: drm.fairplayLicenseUrl,
    certificateUri: drm.fairplayCertificateUrl,
  },
};
player.src({ src: manifestUrl, type: "application/x-mpegURL", keySystems });
```

- Initialize the EME plugin **before** the first `src()` — it hooks the source handler to read `keySystems` off the descriptor.
- Register each plugin in its **own** try/catch: one throw from a cosmetic plugin must not take `contrib-eme` down with it, or every protected title silently fails with a black frame and no error.
- Treat "DRM source but EME plugin unavailable" as a playback failure the UI can show — the player will otherwise wait forever on an encrypted manifest (nothing errored; licensing just never started).
- Refresh tokens **before** expiry (a 5-minute lead is sane) and swap `src` + `keySystems` **in place** (keep `currentTime`, resume if playing) — never dispose the player on a token refresh.

| Platform | System | Notes |
|---|---|---|
| Chrome, Edge, Firefox | Widevine | Cheapest end-to-end first test — validates signing, `v`/`d` audiences, license URLs with no device or package. |
| Safari, iOS, tvOS | FairPlay | Needs the Apple provisioning package; see the expo caveat below. |
| Edge on Windows | PlayReady | Web only. |
| Android, Android TV, Fire TV | Widevine | Via the platform player. |

### 6. DRM: provisioning is human and slow — Apple is the long pole

1. Request a FairPlay Streaming Deployment package from Apple (paid developer account, content description). **Weeks.** Start first.
2. Mux dashboard → Settings → Digital Rights Management → request access. Widevine/PlayReady certificates are Mux-managed; only FairPlay needs the Apple package.
3. Mux returns the **DRM configuration id** → `MUX_DRM_CONFIGURATION_ID` per environment.
4. Send Mux the FairPlay certificate files. Until this lands, DRM plays everywhere **except** Apple devices.
5. Hollywood-grade requirements (Widevine L1-only, HDCP enforcement) are a per-environment Mux Support conversation and a business precondition, not a config flag.

**The known expo-video FairPlay discrepancy** (relevant here because this template ships Expo): FairPlay signs the license request against the content identifier from the manifest's `EXT-X-KEY` URI. Mux's own Swift player passes the `skd://…` URI through verbatim; `expo-video`'s `ContentKeyDelegate` strips the scheme first, so if Mux expects the full URI every Apple license request is signed against the wrong identifier. It cannot be worked around from JS (`drm.contentId` replaces a value the client never sees). Test Apple **early**, and budget for patching `expo-video` or dropping to a native module. Widevine paths exercising, Safari failing says nothing about this — it's a different code path.

Offline/persistent licenses (`offline`, `licenseExpiration`, `playDuration` claims on the `d` token) are supported by Mux and deliberately out of scope here — per-platform download storage is its own project.

### 7. Tests, matrix, docs

Mock `fetch` (Mux REST) and `@starter/db` (`mockDeep()`); never hit Mux or a real Postgres ([testing.md](../testing.md)). The cases your suite must cover:

| Covers | Cases |
|---|---|
| Webhook signature | tampered body, stale timestamp, missing/malformed header, dual `v1` rotation entries, never-log invariant |
| Webhook state machine | dedupe on event id; `asset_created` ignored for non-waiting rows; nothing demotes `READY`/resurrects `DELETED`; static-rendition monotonicity; unknown ids are 2xx no-ops |
| Upload creation | CORS origin pinning; DRM without configuration id rejected **before** the row exists; DRM + static rendition refused; quality-tier enforcement |
| Token minting | `v`/`d` shared expiry; DRM asset never falls back to signed/public; signed asset never falls back to public; malformed signing key |
| Activation | refuses security downgrade; refuses missing playback id; stale redelivery loses to newer asset deterministically |

Then: `sitemap.md` (watch route row, "intentionally excluded from SEO discovery"), `patterns/rate-limiting.md` (webhook + token-budget rows), `patterns/admin-dashboard.md`, `notes/02-users-and-roles.md`, and this file. Run `pnpm verify:fast`.

## Choosing between the three pipelines

| | Self-hosted ([video.md](./video.md)) | Bunny ([video.md § Hosted alternative: Bunny Stream](./video.md#hosted-alternative-bunny-stream)) | Mux (this doc) |
|---|---|---|---|
| Storage / encode / delivery | Your S3 + ffmpeg + your server | Bunny library + Bunny API + Bunny CDN | Mux, Mux, `stream.mux.com` |
| Bytes through your app | Playback only | None | None (tokens + webhooks only) |
| ffmpeg in images / worker queues | Yes (4 queues) | No | No |
| DRM | No ("members only", not must-not-download) | No | **Yes — all three systems** |
| Cost shape | Compute you already pay for | Storage + egress | Encode minutes + delivery minutes + storage |
| Pick when | Data locality, cost control at scale | Simple VOD, edge delivery | DRM is contractual, or you want zero pipeline ops |

## Full source — there is no template commit

Mux never shipped here, so — unlike the other add-ins — `git log` has nothing to recover. This document is the spec: the state machine, the guards, the token model, and the provisioning chain above are the complete reference. Anchor the build on Mux's own documentation for the four API surfaces this recipe touches (direct uploads, playback policies + signed playback IDs, DRM licensing endpoints, webhook signature verification), and re-verify the platform matrix in step 5 and the expo-video FairPlay caveat in step 6 against your player versions at build time.

When your app implements this, replace this section with your real file list (the lib, the webhook route, the player, the token hook) so the next agent working in your repo can find them — the same job the other add-ins' Full source sections do with template commits.

## Related

- [add-ins/video.md](./video.md) — the self-hosted pipeline and the Bunny swap; the watch-route, sitemap, and player-placement rules are shared.
- [assets.md](../assets.md) — the token-discipline rule playback URLs inherit.
- [rate-limiting.md](../rate-limiting.md) — webhook bucket and procedure budgets.
- [custom-roles.md](../custom-roles.md) — registered builders and the access matrix.
- [environment-variables.md](../environment-variables.md) — the two-file env change.
- [testing.md](../testing.md) — mocking the provider and the DB.
