# Add-in: HLS video (upload, transcode, playback)

The template does **not** ship a video pipeline. S3 assets ([assets.md](../assets.md)) cover images and generic files; video is a separate feature because it adds ffmpeg to the worker image, four BullMQ queues, an HLS HTTP surface whose request volume is unlike anything else in the app, and a persisted transcode-ownership protocol that is easy to get subtly wrong.

This is the recipe for building the VOD pipeline that used to ship here: browser-direct multipart upload to S3, worker ffmpeg → HLS adaptive ladder, artifact routes behind a single permission helper, Vidstack playback, admin upload/detail, and a hosted Bunny Stream swap if you outgrow self-hosted transcode. A second hosted option — Mux, the only one with multi-DRM — is documented in [add-ins/video-mux.md](./video-mux.md).

It existed in this template once and was removed on purpose. The [Full source](#full-source--the-commits-that-had-it) section names the commit if your app still carries template history; everything needed to rebuild it from nothing is below.

## Read this first: this is an ops surface

Build this when the product actually plays user-uploaded or operator-uploaded video in the app. Do not build it "so we can host a demo reel later."

- Each ffmpeg pass is roughly 10× the source duration. A single 4-core worker maxes out around 20× speedup. The worker image grows by ~50 MB for ffmpeg.
- HLS streams one ~4-second segment at a time. A 10-minute video is ~150 GETs. Sharing `/rpc`'s limiter with that surface 429s the rest of the app mid-playback — this template shipped that bug. [rate-limiting.md § Give every surface its own bucket](../rate-limiting.md#give-every-surface-its-own-bucket).
- Bytes never stream through the app server on upload (presigned PUT to S3). Playback artifacts do stream through the app server, and every GET re-authorizes.
- This is VOD only (`playlist_type=vod`). Live streaming, DRM, and auto-captions are out of scope.

Requires `S3_BUCKET` (same bucket as assets, no second bucket). With the bucket unset, `/api/videos/*` must 503 and the rest of the app must still boot.

## What you get

- `Video` + rendition + audio-track + subtitle-track Prisma models, plus retained-publication and manifest-candidate rows for the fencing protocol.
- oRPC upload: `videos.start` / `presignParts` / `complete` / `heartbeat` / `abort`. Browser PUTs each part directly to S3.
- Worker transcoder (`transcode-video`) → HLS ladder (360p / 540p / 720p / 1080p; 2160p when enabled) + sprite-sheet hover previews.
- Audio-only dub transcoder (`transcode-audio-track`) with a duration check against the canonical video.
- HLS playlist + segment endpoints in `apps/server/src/video-routes.ts`, single permission boundary `authorizeVideoArtifactRead()`.
- Vidstack `VideoPlayer` and multipart `VideoUploader`.
- Admin `/admin/videos` (layout + `index` + `$videoId`) and a watch route `/$lang/videos/$videoId`.
- Daily `cleanup-videos` cron and a one-minute `reconcile-video-transcodes` scheduler.

## Properties that must hold

Each of these is checkable. An agent restoring this surface should be able to point at the code that satisfies every line.

- [ ] **One permission helper for metadata, one for artifacts.** `canViewVideo` / `authorizeVideoRead` for oRPC metadata: `PUBLIC` + `READY` is world-readable; otherwise owner or admin. `authorizeVideoArtifactRead` for `/api/videos/*` is different on purpose: `PUBLIC && publishedGeneration !== null` stays playable while `status` is `TRANSCODING`, so already-issued HLS URLs survive a reprocess. Implementing both as PUBLIC+READY 404s in-flight viewers for up to the one-hour retained-publication window. Route handlers must not implement a third path. Customize both helpers together.
- [ ] **HLS gets its own limiter, own `keyPrefix`, never a remount of `rpcLimiter`.** Scale it in the UPLOAD family (the old reference member was `/api/assets/*` at 200/60 s; HLS sat at 600). Merging HLS into `/rpc` is the bug in [rate-limiting.md § Give every surface its own bucket](../rate-limiting.md#give-every-surface-its-own-bucket).
- [ ] **Spend-bearing procedures get a procedure-level budget.** Charge `videos.start`, `videos.startAudioTrack`, and `videos.finalizeAudioTrack` — 20 points / 600 s, fail-closed, keyed on `uid:<id>`. Charge the **gate**, not `complete` (one point covers the whole upload→transcode chain). These are code constants in `packages/api/src/lib/video-rate-limit.ts`, not a sixth env family. Do not put the budget on `get` / `list`. [rate-limiting.md § When the surface is a procedure, not a route](../rate-limiting.md#when-the-surface-is-a-procedure-not-a-route).
- [ ] **ffmpeg is installed in both runtime images.** `WORKER_MODE=external` is optional; the server embeds consumers by default, so `Dockerfile` and `Dockerfile.worker` both need `ffmpeg` and stay in sync ([AGENTS.md § Dockerfiles — keep server and worker in sync](../../AGENTS.md)). Install it in `Dockerfile.dev` too if local docker-compose builds that image.
- [ ] **Every env var is a two-file change** (`packages/env/src/vars/shared.ts` — the worker reads these — plus `scripts/lib/env-manifest.ts`, then `pnpm env:sync`). Never hand-edit `.env.example`.
- [ ] **Four queues stay four queues** (`transcode-video`, `transcode-audio-track`, `cleanup-videos`, `reconcile-video-transcodes`). Consolidating them is a protocol change, not a rename: generation-scoped deterministic job ids, `ensureRunnableJob` (plain `Queue.add` does not revive a retained terminal job), and distinct concurrency must survive. Video encode stays CPU-limited (default concurrency 1).
- [ ] **Postgres owns transcode claims; BullMQ does not.** Removing a completed job is safe; a lost enqueue is repaired by the reconciler. The reconciler republishes positive claims with no execution or a stale heartbeat; it never invents or upgrades database ownership.
- [ ] **The write fence is a random execution id**, not the worker process. Heartbeats every 30 s compare PostgreSQL's clock. After three missed heartbeats the next reconciled delivery takes the same generation with a new id. Handler catches own terminal `FAILED`; BullMQ `failed` listeners are alert-only (they do not possess the execution id).
- [ ] **Never perform an S3 request while holding the Video row lock.** Lock order is always Video first, then candidate / audio / subtitle / rendition rows.
- [ ] **Unknown S3 keys fail closed in cleanup.** A key that merely starts with `videos/` or `rawVideos/` is not proof of ownership. Cleanup owns only the canonical layouts; everything else is preserved and reported.
- [ ] **A cached PUBLIC generation artifact can outlive a visibility flip by up to one hour.** Before emitting `/api/videos/<id>/...` URLs in JSON, SSR HTML, or messages, verify the recipient may see the video. (Asset URLs are a 24-hour window; do not copy that number here.)
- [ ] **RESTRICTED videos 404 for non-owners** on the watch route, same as a missing id — do not advertise existence.
- [ ] **Every list procedure is bounded.** Every user-facing string goes through `t()`. New procedures use registered builders; the access matrix gets implemented rows. Do not add app endpoints to `scripts/access-matrix-pre-notes-baseline.json`.
- [ ] **`manualChunks` matchers are anchored on `/node_modules/<pkg>/`.** Vidstack + hls.js must not land in an eager `react-vendor` chunk. [performance-and-bundling.md](../performance-and-bundling.md).

### Transcode ownership (do not bypass)

Video and dub transcodes use the same persisted fencing protocol. Do not add a producer or worker write that skips it.

| Operation | Required row state | Persisted effect | External effect |
|---|---|---|---|
| upload completion | `PENDING` | atomically sets `TRANSCODING` and increments `transcodeGeneration` | immediately attempts deterministic enqueue for `id + generation` |
| admin reprocess | existing source; `READY` or `FAILED` | freezes an existing publication when present, sets `TRANSCODING`, clears failure, increments generation + `manifestRevision` | uploads a candidate before locking only when a publication exists, then deterministic enqueue after the DB CAS |
| reconciler | unowned/stale `TRANSCODING` video, or active (`retiredAt = null`) dub whose parent is `READY` | none | idempotently re-enqueues the current generation |
| worker pickup | matching `TRANSCODING` + generation and no owner or a 90-second-stale owner | atomically persists a fresh random execution id and heartbeat | a live duplicate exits; a dead lease is replaced without reusing its token |
| worker artifact write | matching execution id + generation | serialized renewals use the database clock and verify exact ownership before storage I/O | writes only beneath that execution's disjoint prefix inside the generation |
| worker publish | matching `TRANSCODING` + generation + execution id | fenced transaction sets `READY`, `publishedGeneration`, and the internal winning execution id | client DTOs and URLs expose only generation-pinned routes |
| worker failure | matching `TRANSCODING` + generation + execution id | the handler catch owns the conditional `FAILED` update and clears the lease | BullMQ `failed` listeners are alert-only |
| stale cleanup | stale `TRANSCODING` | sets `FAILED` and increments generation, revoking the worker | later sweeps delete unpublished attempt prefixes |
| dub retirement | active non-default track | sets `retiredAt`, increments generation, and clears execution ownership under the parent `Video` lock | retained publications keep already-issued manifests playable |

Generation counters start at zero while idle. Every transcode claim increments its counter before publishing work, so runnable jobs always carry a positive generation. Every non-`TRANSCODING` `Video` and `VideoAudioTrack` row must have `transcodeExecutionId = null` and `transcodeHeartbeatAt = null`. The winning execution id is internal storage metadata; it never appears in a DTO or public URL.

Attempt object layout:

- video: `videos/<videoId>/attempts/g<generation>/executions/<executionId>/...`
- dub: `videos/<videoId>/audio-attempts/<trackId>/g<generation>/executions/<executionId>/...`
- raw source: `rawVideos/<videoId>/source` (original) and `rawVideos/<videoId>/a/<uploadAttemptId>/source` (dub). `uploadGeneration` fences replacement requests; the logical track id is reused and is **not** an upload-attempt fence.

A dub whose parent is reprocessing releases its lease and stays `TRANSCODING`; reconciliation waits until the parent is `READY` before republishing it.

## The recipe

Work in this order. Each step is independently verifiable.

### 1. Dependencies

Vidstack and hls.js, pinned in the pnpm catalog because more than one workspace may consume them. Confirm current versions and confirm the install with the developer first ([agent-tooling.md](../agent-tooling.md)). ffmpeg is a **system** package, not an npm package — see step 4.

### 2. Environment variables

Worker-safe declarations in `packages/env/src/vars/shared.ts` (the worker reads them via `@starter/env/shared`), matching entries in `scripts/lib/env-manifest.ts`, then `pnpm env:sync`. Defaults that used to ship:

| Variable | Default | Notes |
|---|---|---|
| `VIDEO_FFMPEG_PATH` / `VIDEO_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | PATH in the image. |
| `VIDEO_ENABLE_4K` | `false` | 2160p burns ~3× the CPU of 1080p. Per-video override: `Video.ladderPolicy`. |
| `VIDEO_UPLOAD_MAX_BYTES` | 10 GB | Hard cap on one source upload. |
| `VIDEO_TRANSCODE_CONCURRENCY` | `1` | Bump to `2` only on 8+ cores. |
| `VIDEO_AUDIO_TRANSCODE_CONCURRENCY` | `2` | Audio is light enough to parallelise. |
| `VIDEO_TRANSCODE_MAX_DURATION_SECONDS` | `14400` (4 h) | Reject before encoding. |
| `VIDEO_FFMPEG_THREADS` | `2` | Raise only with matching worker CPU. |
| `VIDEO_FFMPEG_TIMELIMIT_SECONDS` | `21600` (6 h) | CPU-time cap; worker also kills the child after this plus 30 s wall clock. |
| `VIDEO_X264_CRF` | `23` | Lower = higher quality / larger file. |
| `VIDEO_X264_PRESET` | `slow` | ~5% better compression than `medium` at ~2× encode time. |

Plus the HLS member of the UPLOAD family (`RATE_LIMIT_UPLOAD_*` already exist; add the limiter, not a sixth family). Bucket CORS and CSP `connect-src` are already handled when `S3_BUCKET` is set ([assets.md § Bucket CORS](../assets.md#bucket-cors), [assets.md § CSP](../assets.md#csp--the-other-half-of-the-cross-origin-upload)).

### 3. Prisma models

Additive, `pnpm db:push`. Create `packages/db/prisma/schema/videos.prisma` with `Video`, `VideoRendition`, `VideoAudioTrack`, `VideoSubtitleTrack`, `VideoManifestCandidate`, `VideoArtifactPublication`, `VideoAudioArtifactPublication`, `VideoSubtitleArtifactPublication`, and the visibility / status / subtitle-kind / ladder-policy / candidate-status enums. Back-relations on `User`.

`Video.sourceLocale` is selected at upload start and is immutable (it describes the uploaded media). To correct it, delete and re-upload.

### 4. ffmpeg in the images

Install `ffmpeg` via apt in `Dockerfile` **and** `Dockerfile.worker` (and `Dockerfile.dev` if that image runs workers). The comments that used to live next to those lines said why both images: embedded jobs run inside the server unless `WORKER_MODE=external`. Size the container memory limit well above ffmpeg's native usage.

### 5. Lib + routes + worker

Create, then wire:

| File | Role |
|---|---|
| `packages/api/src/lib/videos.ts` | Permission boundary, storage-key helpers, upload orchestration, master-playlist builder |
| `packages/api/src/lib/video-client.ts` | `uploadVideo()` browser helper |
| `packages/api/src/lib/video-cleanup.ts` | `runVideoCleanup()` — shared by cron + admin trigger |
| `packages/api/src/lib/video-manifest-candidates.ts` | Durable stage/claim/delete fence for frozen masters |
| `packages/api/src/lib/video-rate-limit.ts` | Procedure-level budgets |
| `packages/api/src/routers/videos.ts` | oRPC procedures |
| `apps/server/src/video-routes.ts` | HLS HTTP routes |
| `apps/worker/src/lib/transcode-execution.ts` | Shared generation/execution acquisition, heartbeat, storage-write fence |
| `apps/worker/src/lib/abortable-child.ts` | ffmpeg child + AbortSignal; storage GET/PUT must be abortable too so a revoked handler dies instead of finishing a superseded generation |
| `apps/worker/src/lib/concurrency.ts` | `mapWithConcurrency` for ffmpeg work (and its test). Copying `transcode-video.ts` from `61e82a9^` imports this. |
| `apps/worker/src/handlers/transcode-video.ts` | Main ladder + sprites |
| `apps/worker/src/handlers/transcode-audio-track.ts` | Per-dub encoder |
| `apps/worker/src/handlers/reconcile-video-transcodes.ts` | Re-publishes positive persisted claims |
| `apps/worker/src/handlers/cleanup-videos.ts` | Wrapper around `runVideoCleanup()` |

**Extend, do not create:** `packages/queue/src/jobs.ts` and `packages/queue/src/index.ts` already exist (chat, assets, seed). Add the four video queue names and constructors there. Call the existing `ensureRunnableJob` in `packages/queue/src/ensure-job.ts` — do not recreate that file. Plain `Queue.add` does not revive a retained terminal job.

`packages/api/package.json` uses an explicit `exports` map. Add `"./lib/videos"`, `"./lib/video-client"`, and `"./lib/video-cleanup"` (mirroring `./lib/asset-client` / `./lib/asset-cleanup`). Server routes, transcode handlers, the uploader, and `cleanup-videos.ts` import those as `@starter/api/lib/...`. `video-manifest-candidates` and `video-rate-limit` stay relative imports inside the api package and do not need export keys.

Mount order, matching the asset routes: `app.use("/api/videos/*", sessionMiddleware)` first (cookie session so owner/admin `RESTRICTED` playback works; HLS players send cookies, not `Authorization`), then the dedicated `videoLimiter` (own `keyPrefix`, UPLOAD family, 600/60 s), then `mountVideoRoutes`. Every GET still calls `authorizeVideoArtifactRead`. Do not skip the helper because a session ran, and do not skip the session middleware because the helper exists.

Register the four queues and the 03:45 UTC cleanup scheduler (stagger 30 min after `cleanup-assets`) plus the one-minute reconciler in `apps/worker/src/runtime.ts`. Graceful shutdown: close the execution-entry gate, abort active child/storage work, wait for handlers and heartbeat writes, then release exactly owned leases before Redis/DB teardown.

### 6. Web

- `apps/web/src/components/video/{player,uploader}.tsx`
- `apps/web/src/routes/$lang/_app/admin/videos.tsx` (layout) + `index.tsx` + `$videoId.tsx`
- Watch route: `apps/web/src/routes/$lang/_app/videos.$videoId.tsx` — this is a **player**, so it belongs under `_app` (`ssr: false`), not `_public`. [ssr-for-articles.md](../ssr-for-articles.md) lists video players as a reason not to SSR.

The original `uploader.tsx` and admin `$videoId.tsx` import `{ orpc, client as orpcClient }` from `@/utils/orpc` and pass `orpcClient.videos.*` into `uploadVideo` / `uploadAudioTrack`. Commit `2d53cca` un-exported `client` (knip: its only consumers left with consent/video). Re-export `client` next to `orpc` when you restore those files — knip will accept the export once the uploader exists — or adapt the two files to a callable RPC shape that does not need the raw client. Do not copy them from `61e82a9^` unqualified.

Admin nav entry. Locales: `packages/locales/src/en-US/videos.json` plus admin/nav keys, add `"videos"` to `NAMESPACES` and to the AGENTS.md namespace list, `pnpm i18n:translate`, `pnpm sync:agent-docs`.

The watch route is public in the router sense (a `PUBLIC`+`READY` video plays for an anonymous visitor) but **not** indexable — leave it out of `PUBLIC_PATHS`. Add a **Public Routes** row in `sitemap.md` (`/{lang}/videos/:videoId`), next to login, with the same "intentionally excluded from SEO discovery" note that page already uses for auth utility routes. Do not list it under Authenticated Routes (chat lives there because it is under `_auth`); do not nest the file under `_auth`. Keep the `_app` / `ssr: false` placement.

Touch targets ≥ 44px on the uploader and admin actions. No `transition-all`.

### 7. Tests, matrix, docs

The deleted tests are the spec:

| File | Covers |
|---|---|
| `packages/api/src/lib/videos.test.ts` / `videos.contract.test.ts` | permission helper, DTO shape, generation pinning |
| `packages/api/src/lib/video-cleanup.test.ts` | unknown keys preserved; PENDING grace; grant expiry |
| `packages/api/src/lib/video-manifest-candidates.test.ts` | stage/claim/delete fence |
| `packages/api/src/lib/video-rate-limit.test.ts` | own bucket, not `rpcLimiter` |
| `packages/api/src/routers/videos.test.ts` | ownership, bounded lists, RESTRICTED 404 |
| `apps/server/src/video-routes.test.ts` | artifact auth, cache headers, generation redirect |
| `apps/worker/src/handlers/transcode-ownership.test.ts` | pickup/publish/failure CAS |
| `apps/worker/src/handlers/reconcile-video-transcodes.test.ts` | lost-enqueue repair; does not invent ownership |
| `apps/worker/src/lib/abortable-child.test.ts` | signal kills ffmpeg |
| `apps/worker/src/lib/concurrency.test.ts` | `mapWithConcurrency` bounds ffmpeg fan-out |

Mock `@starter/db` and `@starter/queue`; never hit real Postgres/Redis/S3 ([testing.md](../testing.md)).

Then: `patterns/rate-limiting.md` budget table (HLS row), `patterns/admin-dashboard.md` route map, `sitemap.md`, `notes/02-users-and-roles.md`, this file.

Run `pnpm verify:fast`. `pnpm policy:access-matrix` and `pnpm docker:check-copy` are the gates this surface trips if you forget a builder or a COPY line.

## Hosted alternative: Bunny Stream

Once self-hosted transcode is in place, you can swap ffmpeg for [Bunny Stream](https://bunny.net/stream/) without changing the Prisma models, the oRPC shapes, the player, or the admin UI.

Swap when you transcode more than ~5 hours of source per day, want global edge delivery without fronting S3 with a CDN, or no longer want ffmpeg in the worker image.

| Layer | Self-hosted | Bunny Stream |
|---|---|---|
| Storage | Your S3 bucket | Bunny Stream library |
| Transcode | `transcode-video` worker → ffmpeg | Bunny API on upload |
| Playback URL | `/api/videos/:id/playlist.m3u8` | `https://vz-<library>.b-cdn.net/<videoId>/playlist.m3u8` |
| Permission | `authorizeVideoArtifactRead()` | Bunny token-auth or public + referrer check |

`bunnynet-typescript-stream-client` has historically been unmaintained — call the REST API (`https://video.bunnycdn.com`) directly. New env (two-file change, **shared** schema because the worker startup guard reads the discriminator):

```env
VIDEO_PROVIDER=bunny
BUNNY_STREAM_API_KEY=<library-level api key>
BUNNY_STREAM_LIBRARY_ID=<library id>
BUNNY_STREAM_CDN_HOSTNAME=vz-<your-pull-zone>.b-cdn.net
```

`VIDEO_PROVIDER` values `"self"` (default) and `"bunny"`. Branch `videos.start` / `complete` / `get` on it. When `bunny`, skip multipart presign (Bunny takes a single PUT) and skip the transcode workers — guard them with `if (env.VIDEO_PROVIDER !== "self") return;` rather than deleting them.

What you give up: Bunny does not expose multi-audio-track ingestion the way this model does (a dub becomes a separate video you join yourself); hover-preview URLs change shape; you pay storage + egress.

Decision checklist before swapping: hours of source per day; whether runtime audio-language swap is required; whether viewers are globally distributed; whether operating ffmpeg costs more than ~$50/mo in compute.

## When this design does not fit

- **Live streaming.** Different pipeline (RTMP ingest, LL-HLS). Pick a provider.
- **DRM.** FairPlay / Widevine / PlayReady is a keys-and-licenses product. Bearer-token URLs are "members only," not "must not be downloadable." Mux is the hosted option that ships all three systems — [add-ins/video-mux.md](./video-mux.md).
- **Auto-captions.** Pair a transcription provider on upload and call `videos.addSubtitleTrack`.

## Full source — the commits that had it

If your app still carries this template's git history, the complete implementation is recoverable from `61e82a9^`:

- Schema: `packages/db/prisma/schema/videos.prisma`.
- API: `packages/api/src/lib/video-*.ts`, `packages/api/src/lib/videos.ts`, `packages/api/src/routers/videos.ts`.
- Server: `apps/server/src/video-routes.ts`, the `/api/videos` mount and limiter in `apps/server/src/index.ts` / `rate-limit.ts`.
- Worker: `apps/worker/src/handlers/{transcode-video,transcode-audio-track,reconcile-video-transcodes,cleanup-videos}.ts`, `apps/worker/src/lib/{transcode-execution,abortable-child,concurrency}.ts`.
- Web: `apps/web/src/components/video/`, `apps/web/src/routes/$lang/_app/admin/videos*`, `apps/web/src/routes/$lang/_app/videos.$videoId.tsx`.
- Env / catalog / Docker: `VIDEO_*` in `packages/env/src/vars/shared.ts` + `scripts/lib/env-manifest.ts`, Vidstack/hls.js catalog pins, `ffmpeg` in `Dockerfile` / `Dockerfile.worker` / `Dockerfile.dev`.
- Docs: the original `patterns/video.md` and `patterns/video-bunny.md` (how the shipped system worked) and `patterns/removable/video.md` (the old rip-out recipe — do not restore it; this add-in replaced it).

Read the removal commit too (`git show 61e82a9`). The rate-limit and `manualChunks` lessons stayed in [rate-limiting.md](../rate-limiting.md) and [performance-and-bundling.md](../performance-and-bundling.md) as history; restore the code, not a shared `/rpc` bucket.

## Related

- [assets.md](../assets.md) — sibling storage pattern; shared S3 config, CORS, CSP, cleanup discipline.
- [queue.md](../queue.md) — BullMQ conventions, cron/schedulers, deterministic job ids.
- [rate-limiting.md](../rate-limiting.md) — per-surface buckets; HLS is the worked counter-example.
- [i18n.md](../i18n.md) — audio + subtitle tracks key by BCP 47 tag.
- [auth-and-routing.md](../auth-and-routing.md) — admin section as layout + `index` + `$videoId`.
- [agent-tasks/cleanup.md](../agent-tasks/cleanup.md) — S3 race-condition audit for any new write path.
- [add-ins/mcp-server.md](./mcp-server.md) — if you expose video procedures as tools, the same cookie-only / scope-at-tool-layer rules apply.
- [add-ins/video-mux.md](./video-mux.md) — the fully managed alternative (Mux): no S3, no ffmpeg, no artifact routes; optional multi-DRM.
