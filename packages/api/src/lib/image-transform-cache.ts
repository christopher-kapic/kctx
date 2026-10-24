import { createHash } from "node:crypto";

import { env } from "@starter/env/server";

import { type AssetMeta, readAssetObject } from "./assets";
import {
  imageTransformETag,
  normalizeTransformParams,
  type TransformParams,
  type TransformResult,
  transformImage,
} from "./images";
import { getStorageObject, listStorageObjects, putStorageObject, storage } from "./storage";

/**
 * S3 write-back cache for sharp image transforms.
 *
 * `GET /api/images/:id` re-runs decode → resize → encode on every cache miss.
 * This module memoizes the transformed output back into the *same* S3 bucket so
 * a subsequent request for the same (asset, params) pair serves stored bytes
 * instead of re-running sharp.
 *
 * Storage layout: `transforms/<assetId>/<paramsHash>.<ext>` where `<paramsHash>`
 * is the first 16 hex chars of sha256 over the *normalized* transform identity
 * from {@link imageTransformETag} (so `?w=9999` and `?w=4096` share an entry, as
 * do `?w=1` and `?w=128` — see `normalizeTransformParams` for why the ladder
 * matters here specifically),
 * and `<ext>` is the output format. The prefix is deliberately rooted at
 * `transforms/`, NOT under `assets/`: the asset-cleanup sweep deletes any
 * `assets/` object with no matching `Asset.storageKey` row and would otherwise
 * destroy every variant. Transform variants must stay under `transforms/`.
 *
 * Permission boundary: this module never resolves or authorizes an asset. The
 * caller (asset-routes.ts) MUST have already run `authorizeAssetRead` for the
 * request and pass the resulting `AssetMeta` — no code path serves a variant
 * without that check having run. Visibility flips need no cache invalidation:
 * the route re-authorizes on every request before it ever reaches here (the 24h
 * PUBLIC bearer-token caveat from assets.md still applies to CDN/browser caches,
 * unchanged).
 */

const TRANSFORM_KEY_PREFIX = "transforms/";

const FORMAT_EXTENSION: Record<NonNullable<TransformParams["format"]>, string> = {
  webp: "webp",
  avif: "avif",
  jpeg: "jpg",
  png: "png",
};

/**
 * Derive the storage key for a transformed variant. Pure — no S3, no env — so
 * the cleanup sweep and tests can reason about the key space in isolation.
 */
export function transformCacheKey(assetId: string, params: TransformParams): string {
  const identity = imageTransformETag(assetId, params);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  // Extension comes from the SAME normalization the hash above is derived from,
  // not a second `?? "webp"` inline here. The two defaults agree today, which is
  // exactly what makes a copy of one dangerous: change the default format in
  // `normalizeTransformParams` and a duplicate here would keep naming `.webp`
  // objects that hold the new format's bytes.
  const ext = FORMAT_EXTENSION[normalizeTransformParams(params).format];
  return `${TRANSFORM_KEY_PREFIX}${assetId}/${hash}.${ext}`;
}

// In-flight transform dedup. Two concurrent misses for the same key share a
// single sharp run (and a single write-back) instead of racing. Keyed by the
// transform key; the entry is cleared in `.finally()`. Cross-replica races are
// fine — the bytes are identical.
const inflight = new Map<string, Promise<TransformResult>>();

// Per-asset variant count memo, so the write-back cap below costs one LIST per
// (asset, process) instead of one per miss. Wiped wholesale when it grows past
// the bound — worst case is a redundant LIST, never a wrong answer that
// couldn't also arise from a concurrent replica.
const variantCounts = new Map<string, number>();
const VARIANT_COUNT_MEMO_MAX = 10_000;

/**
 * True when the asset has fewer cached variants than
 * IMAGE_TRANSFORM_CACHE_MAX_VARIANTS. Past the cap, transforms still work —
 * they just stop being written back. Soft cap: concurrent writers can overshoot
 * by a few entries, which is fine.
 *
 * This is now the SECOND line of defence. `normalizeTransformParams` snaps every
 * requested dimension and quality onto a fixed ladder, so the identity space per
 * asset is finite (ladder² × quality buckets × formats) instead of the integer
 * range, and the cheap `?w=1…32` exhaustion collapses to a single entry. The cap
 * remains because that finite space is still larger than the cap, so a caller
 * willing to enumerate w/h/q/format combos can occupy it — the difference is
 * that every object they create is now a *legitimate* variant a real request
 * could reuse, and total growth per asset is bounded rather than unbounded.
 *
 * If you widen the ladders, re-check that the cap still comfortably exceeds the
 * combinations your own `<Image>` usage actually emits, or the cache will stop
 * admitting real variants under ordinary traffic.
 */
async function underVariantCap(assetId: string): Promise<boolean> {
  const cap = env.IMAGE_TRANSFORM_CACHE_MAX_VARIANTS;
  let count = variantCounts.get(assetId);
  if (count === undefined) {
    count = 0;
    for await (const _obj of listStorageObjects(`${TRANSFORM_KEY_PREFIX}${assetId}/`)) {
      count += 1;
      if (count >= cap) break;
    }
    if (variantCounts.size >= VARIANT_COUNT_MEMO_MAX) variantCounts.clear();
    variantCounts.set(assetId, count);
  }
  return count < cap;
}

function recordVariantWrite(assetId: string): void {
  variantCounts.set(assetId, (variantCounts.get(assetId) ?? 0) + 1);
}

/**
 * Clear the module's in-process state (in-flight dedup + variant-count memo).
 * For tests; production code never needs it — a stale count only skips
 * write-backs, it can never serve wrong bytes.
 */
export function resetImageTransformCacheState(): void {
  inflight.clear();
  variantCounts.clear();
}

/**
 * Return a transformed variant for an already-authorized asset, using the S3
 * write-back cache when enabled. On a hit, serves the stored bytes. On a miss,
 * dedupes concurrent transforms, runs sharp, and best-effort writes the result
 * back to S3 (a failed put still returns the freshly transformed bytes).
 *
 * When `IMAGE_TRANSFORM_CACHE=false` (or storage is unavailable) this restores
 * the original behaviour exactly: read the source, transform, return — no cache
 * read and no write.
 */
export async function getOrCreateTransform(
  meta: AssetMeta,
  params: TransformParams,
): Promise<TransformResult> {
  if (!env.IMAGE_TRANSFORM_CACHE || !storage) {
    const source = await readAssetObject(meta);
    return transformImage(source.body, params);
  }

  const key = transformCacheKey(meta.id, params);
  const existing = inflight.get(key);
  if (existing) return existing;

  // Create + register the promise with no `await` in between so a concurrent
  // caller always observes the in-flight entry (deterministic dedup).
  const work = produceTransform(meta, params, key);
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

async function produceTransform(
  meta: AssetMeta,
  params: TransformParams,
  key: string,
): Promise<TransformResult> {
  const cached = await getStorageObject(key);
  if (cached) {
    return { body: Buffer.from(cached.body), contentType: cached.contentType };
  }

  const source = await readAssetObject(meta);
  const transformed = await transformImage(source.body, params);
  try {
    // Best-effort write-back, gated on the per-asset variant cap. Failures (of
    // the cap LIST or the put) must not fail the response — the next request
    // simply misses again and retries.
    if (await underVariantCap(meta.id)) {
      await putStorageObject(key, transformed.body, transformed.contentType);
      recordVariantWrite(meta.id);
    }
  } catch (err) {
    console.warn("[image-transform-cache] write-back failed", { key, err });
  }
  return transformed;
}
