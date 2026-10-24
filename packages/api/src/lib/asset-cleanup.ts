import prisma from "@starter/db";

import { forEachPage, keysetWhere } from "./pagination";
import {
  abortMultipartUpload,
  deleteStorageObject,
  deleteStorageObjects,
  listIncompleteMultipartUploads,
  listStorageObjects,
  type StorageObjectListEntry,
  storage,
} from "./storage";

/**
 * Three-phase asset cleanup. Shared between the admin trigger and the cron.
 *
 * Phase 1 — orphan PENDING rows. Delete Asset rows still in PENDING whose
 *   heartbeat is older than `pendingMaxAgeMs`. Falls back to `createdAt` for
 *   rows that predate the heartbeat field (`uploadHeartbeatAt IS NULL`). Each
 *   deleted row's storage object is best-effort removed too.
 *
 * Phase 2 — orphan S3 objects. List every key under the asset prefix and
 *   delete those with no Asset row whose `storageKey` matches. To avoid
 *   racing against an in-flight upload, the row is re-checked at delete time
 *   (not from a cached snapshot), and objects newer than
 *   `objectMinAgeMs` are skipped entirely.
 *
 * Phase 3 — incomplete multipart uploads. Abort any multipart upload older
 *   than `multipartMaxAgeMs`. The starter doesn't use multipart uploads, so
 *   this is a defensive sweep for buckets shared with other tools.
 *
 * Phase 4 — orphan image-transform variants. List every key under the
 *   `transforms/` prefix, parse the `<assetId>` out, and delete variants whose
 *   asset no longer has a row. Honours the same `objectMinAgeMs` grace window
 *   as phase 2 (skip freshly written objects).
 *   Variants are regenerable, so a mistaken delete only forces a re-transform
 *   on next read — never data loss.
 */

const ASSET_KEY_PREFIX = "assets/";
const TRANSFORM_KEY_PREFIX = "transforms/";

/**
 * Parse the `<assetId>` out of a transform key (`transforms/<assetId>/<file>`).
 * Returns null for keys that don't match the layout so a stray object is left
 * untouched rather than mis-attributed. Pure.
 */
export function parseTransformAssetId(key: string): string | null {
  const parts = key.split("/");
  if (parts.length < 3 || parts[0] !== "transforms") return null;
  const assetId = parts[1];
  return assetId ? assetId : null;
}

export type CleanupOptions = {
  /**
   * Age threshold for a PENDING Asset row to be reaped. Compared against
   * `uploadHeartbeatAt` (or `createdAt` when the heartbeat is null).
   * Default: 5 minutes — the heartbeat interval is 60s, so this tolerates
   * ~5 missed beats.
   */
  pendingMaxAgeMs?: number;
  /**
   * Skip S3 objects newer than this. Guards against an upload that arrived
   * in S3 between phase 1 and phase 2 (PENDING row still being created, or
   * presigned URL just used). Default: 15 minutes — longer than the
   * presigned URL's 5-minute TTL plus a generous buffer.
   */
  objectMinAgeMs?: number;
  /**
   * Age threshold for incomplete multipart uploads. Default: 24 hours.
   */
  multipartMaxAgeMs?: number;
};

const DEFAULTS = {
  pendingMaxAgeMs: 5 * 60 * 1000,
  objectMinAgeMs: 15 * 60 * 1000,
  multipartMaxAgeMs: 24 * 60 * 60 * 1000,
} as const;

function resolveOpts(opts: CleanupOptions | undefined): Required<CleanupOptions> {
  return {
    pendingMaxAgeMs: opts?.pendingMaxAgeMs ?? DEFAULTS.pendingMaxAgeMs,
    objectMinAgeMs: opts?.objectMinAgeMs ?? DEFAULTS.objectMinAgeMs,
    multipartMaxAgeMs: opts?.multipartMaxAgeMs ?? DEFAULTS.multipartMaxAgeMs,
  };
}

export type CleanupCandidate = {
  /** What kind of thing this is. */
  kind: "pending-row" | "orphan-object" | "incomplete-multipart" | "orphan-transform";
  /** Asset id for `pending-row`, S3 key for the other two. */
  id: string;
  /** Bytes (rows: declared size; objects: S3-reported size; multipart: 0). */
  size: number;
  /** When the candidate was last touched (heartbeat / lastModified / initiated). */
  ageReference: Date | null;
};

export type CleanupSummary = {
  pendingRows: { count: number; bytes: number; sample: CleanupCandidate[] };
  orphanObjects: { count: number; bytes: number; sample: CleanupCandidate[] };
  incompleteMultipart: { count: number; sample: CleanupCandidate[] };
  orphanTransforms: { count: number; bytes: number; sample: CleanupCandidate[] };
};

const SAMPLE_LIMIT = 25;

function emptySummary(): CleanupSummary {
  return {
    pendingRows: { count: 0, bytes: 0, sample: [] },
    orphanObjects: { count: 0, bytes: 0, sample: [] },
    incompleteMultipart: { count: 0, sample: [] },
    orphanTransforms: { count: 0, bytes: 0, sample: [] },
  };
}

/**
 * Inspect the bucket without touching anything. Returns counts, byte totals,
 * and a sample of up to 25 candidates per category for an admin to preview.
 */
export async function dryRunCleanup(opts?: CleanupOptions): Promise<CleanupSummary> {
  if (!storage) throw new Error("Storage is not configured");
  const o = resolveOpts(opts);
  const now = Date.now();
  const summary = emptySummary();

  const pendingCutoff = new Date(now - o.pendingMaxAgeMs);
  await forEachPage(
    (page) =>
      prisma.asset.findMany({
        where: {
          status: "PENDING",
          ...keysetWhere(page.afterId),
          OR: [
            { uploadHeartbeatAt: { lt: pendingCutoff } },
            { AND: [{ uploadHeartbeatAt: null }, { createdAt: { lt: pendingCutoff } }] },
          ],
        },
        select: { id: true, size: true, uploadHeartbeatAt: true, createdAt: true },
        orderBy: { id: "asc" },
        take: page.take,
      }),
    SCAN_PAGE_SIZE,
    (pendingRows) => {
      summary.pendingRows.count += pendingRows.length;
      for (const row of pendingRows) {
        const size = Number(row.size);
        summary.pendingRows.bytes += size;
        if (summary.pendingRows.sample.length < SAMPLE_LIMIT) {
          summary.pendingRows.sample.push({
            kind: "pending-row",
            id: row.id,
            size,
            ageReference: row.uploadHeartbeatAt ?? row.createdAt,
          });
        }
      }
    },
  );

  const objectCutoff = new Date(now - o.objectMinAgeMs);
  // One pass for both phases below — see `loadKnownAssets`.
  const { keys: knownKeys, ids: knownAssetIds } = await loadKnownAssets();
  for await (const obj of listStorageObjects(ASSET_KEY_PREFIX)) {
    if (knownKeys.has(obj.key)) continue;
    if (obj.lastModified && obj.lastModified > objectCutoff) continue;
    summary.orphanObjects.count++;
    summary.orphanObjects.bytes += obj.size;
    if (summary.orphanObjects.sample.length < SAMPLE_LIMIT) {
      summary.orphanObjects.sample.push({
        kind: "orphan-object",
        id: obj.key,
        size: obj.size,
        ageReference: obj.lastModified,
      });
    }
  }

  const multipartCutoff = new Date(now - o.multipartMaxAgeMs);
  for await (const upload of listIncompleteMultipartUploads(ASSET_KEY_PREFIX)) {
    if (upload.initiated && upload.initiated > multipartCutoff) continue;
    summary.incompleteMultipart.count++;
    if (summary.incompleteMultipart.sample.length < SAMPLE_LIMIT) {
      summary.incompleteMultipart.sample.push({
        kind: "incomplete-multipart",
        id: `${upload.key}|${upload.uploadId}`,
        size: 0,
        ageReference: upload.initiated,
      });
    }
  }

  for await (const obj of listStorageObjects(TRANSFORM_KEY_PREFIX)) {
    if (obj.lastModified && obj.lastModified > objectCutoff) continue;
    const assetId = parseTransformAssetId(obj.key);
    if (!assetId || knownAssetIds.has(assetId)) continue;
    summary.orphanTransforms.count++;
    summary.orphanTransforms.bytes += obj.size;
    if (summary.orphanTransforms.sample.length < SAMPLE_LIMIT) {
      summary.orphanTransforms.sample.push({
        kind: "orphan-transform",
        id: obj.key,
        size: obj.size,
        ageReference: obj.lastModified,
      });
    }
  }

  return summary;
}

export type CleanupResult = {
  pendingRowsDeleted: number;
  pendingStorageObjectsDeleted: number;
  pendingStorageObjectsFailed: number;
  orphanObjectsDeleted: number;
  orphanObjectsFailed: number;
  multipartAborted: number;
  multipartAbortFailed: number;
  orphanTransformsDeleted: number;
  orphanTransformsFailed: number;
  /** Total bytes freed (declared sizes for rows + S3-reported for objects). */
  bytesFreed: number;
};

function emptyResult(): CleanupResult {
  return {
    pendingRowsDeleted: 0,
    pendingStorageObjectsDeleted: 0,
    pendingStorageObjectsFailed: 0,
    orphanObjectsDeleted: 0,
    orphanObjectsFailed: 0,
    multipartAborted: 0,
    multipartAbortFailed: 0,
    orphanTransformsDeleted: 0,
    orphanTransformsFailed: 0,
    bytesFreed: 0,
  };
}

/**
 * Execute the cleanup. Phase order matters:
 *   1. Reap PENDING rows first → their storage keys become orphans, which
 *      phase 2 then deletes.
 *   2. List S3 and check each candidate against a fresh DB lookup (the snapshot
 *      taken at LIST time can be minutes old on a big bucket; a re-check at
 *      delete time keeps in-flight uploads safe even from late-arriving rows).
 *   3. Abort old incomplete multipart uploads.
 */
export async function runCleanup(opts?: CleanupOptions): Promise<CleanupResult> {
  if (!storage) throw new Error("Storage is not configured");
  const o = resolveOpts(opts);
  const now = Date.now();
  const result = emptyResult();

  const pendingCutoff = new Date(now - o.pendingMaxAgeMs);
  await forEachPage(
    (page) =>
      prisma.asset.findMany({
        where: {
          status: "PENDING",
          ...keysetWhere(page.afterId),
          OR: [
            { uploadHeartbeatAt: { lt: pendingCutoff } },
            { AND: [{ uploadHeartbeatAt: null }, { createdAt: { lt: pendingCutoff } }] },
          ],
        },
        select: { id: true, storageKey: true, size: true },
        orderBy: { id: "asc" },
        take: page.take,
      }),
    SCAN_PAGE_SIZE,
    async (candidatePending) => {
      for (const row of candidatePending) {
        // Re-check the row state — a heartbeat could have landed between LIST
        // and DELETE. Use a conditional updateMany so a concurrent heartbeat
        // beats us and the row stays intact.
        const reaped = await prisma.asset.deleteMany({
          where: {
            id: row.id,
            status: "PENDING",
            OR: [
              { uploadHeartbeatAt: { lt: pendingCutoff } },
              { AND: [{ uploadHeartbeatAt: null }, { createdAt: { lt: pendingCutoff } }] },
            ],
          },
        });
        if (reaped.count === 0) continue;
        result.pendingRowsDeleted++;
        result.bytesFreed += Number(row.size);
        try {
          await deleteStorageObject(row.storageKey);
          result.pendingStorageObjectsDeleted++;
        } catch (err) {
          result.pendingStorageObjectsFailed++;
          console.warn("[asset-cleanup] storage delete failed for pending row", {
            id: row.id,
            key: row.storageKey,
            err,
          });
        }
      }
    },
  );

  // Phase 2 runs in batches: one findMany({ in }) resolves known keys for up
  // to 1000 listed objects, and orphans are removed with a single batched
  // DeleteObjects call — instead of one findUnique + one DeleteObject round
  // trip per key. Orphans are rare, so each candidate is still re-checked
  // with a fresh single lookup immediately before deletion (a row may have
  // been created after the batch lookup, especially on big buckets where the
  // LIST iteration takes long).
  const objectCutoff = new Date(now - o.objectMinAgeMs);
  const OBJECT_BATCH_SIZE = 1000;
  let objectBatch: StorageObjectListEntry[] = [];

  const processObjectBatch = async () => {
    if (objectBatch.length === 0) return;
    const batch = objectBatch;
    objectBatch = [];

    const knownRows = await prisma.asset.findMany({
      where: { storageKey: { in: batch.map((obj) => obj.key) } },
      select: { storageKey: true },
      take: batch.length,
    });
    const knownKeys = new Set(knownRows.map((row) => row.storageKey));

    const confirmed: StorageObjectListEntry[] = [];
    for (const obj of batch) {
      if (knownKeys.has(obj.key)) continue;
      // Safety re-check at delete time, per candidate.
      const existing = await prisma.asset.findUnique({
        where: { storageKey: obj.key },
        select: { id: true },
      });
      if (existing) continue;
      confirmed.push(obj);
    }
    if (confirmed.length === 0) return;

    try {
      const deletion = await deleteStorageObjects(confirmed.map((obj) => obj.key));
      const failedKeys = new Set(deletion.errors.map((err) => err.key));
      for (const obj of confirmed) {
        if (failedKeys.has(obj.key)) {
          result.orphanObjectsFailed++;
        } else {
          result.orphanObjectsDeleted++;
          result.bytesFreed += obj.size;
        }
      }
      for (const err of deletion.errors) {
        console.warn("[asset-cleanup] storage delete failed for orphan object", {
          key: err.key,
          code: err.code,
          message: err.message,
        });
      }
    } catch (err) {
      result.orphanObjectsFailed += confirmed.length;
      console.warn("[asset-cleanup] batched storage delete failed for orphan objects", {
        keys: confirmed.map((obj) => obj.key),
        err,
      });
    }
  };

  for await (const obj of listStorageObjects(ASSET_KEY_PREFIX)) {
    if (obj.lastModified && obj.lastModified > objectCutoff) continue;
    objectBatch.push(obj);
    if (objectBatch.length >= OBJECT_BATCH_SIZE) await processObjectBatch();
  }
  await processObjectBatch();

  const multipartCutoff = new Date(now - o.multipartMaxAgeMs);
  for await (const upload of listIncompleteMultipartUploads(ASSET_KEY_PREFIX)) {
    if (upload.initiated && upload.initiated > multipartCutoff) continue;
    try {
      await abortMultipartUpload(upload.key, upload.uploadId);
      result.multipartAborted++;
    } catch (err) {
      result.multipartAbortFailed++;
      console.warn("[asset-cleanup] abort multipart failed", {
        key: upload.key,
        uploadId: upload.uploadId,
        err,
      });
    }
  }

  // Phase 4: reap orphan image-transform variants. Batched like phase 2 — one
  // findMany resolves the live asset ids for a batch of listed variants, and
  // orphans (variants whose asset id has no row) are removed with a single
  // DeleteObjects call. Variants are regenerable, so a per-candidate re-check
  // isn't warranted: a mistakenly deleted variant just re-transforms on the
  // next read. The `objectMinAgeMs` grace still guards freshly written objects.
  let transformBatch: StorageObjectListEntry[] = [];

  const processTransformBatch = async () => {
    if (transformBatch.length === 0) return;
    const batch = transformBatch;
    transformBatch = [];

    const parsed = batch.map((obj) => ({ obj, assetId: parseTransformAssetId(obj.key) }));
    const assetIds = new Set<string>();
    for (const { assetId } of parsed) {
      if (assetId) assetIds.add(assetId);
    }
    const liveRows = await prisma.asset.findMany({
      where: { id: { in: [...assetIds] } },
      select: { id: true },
      take: assetIds.size,
    });
    const liveIds = new Set(liveRows.map((row) => row.id));

    const orphans = parsed
      .filter(({ assetId }) => assetId !== null && !liveIds.has(assetId))
      .map(({ obj }) => obj);
    if (orphans.length === 0) return;

    try {
      const deletion = await deleteStorageObjects(orphans.map((obj) => obj.key));
      const failedKeys = new Set(deletion.errors.map((err) => err.key));
      for (const obj of orphans) {
        if (failedKeys.has(obj.key)) {
          result.orphanTransformsFailed++;
        } else {
          result.orphanTransformsDeleted++;
          result.bytesFreed += obj.size;
        }
      }
      for (const err of deletion.errors) {
        console.warn("[asset-cleanup] storage delete failed for orphan transform", {
          key: err.key,
          code: err.code,
          message: err.message,
        });
      }
    } catch (err) {
      result.orphanTransformsFailed += orphans.length;
      console.warn("[asset-cleanup] batched storage delete failed for orphan transforms", {
        keys: orphans.map((obj) => obj.key),
        err,
      });
    }
  };

  for await (const obj of listStorageObjects(TRANSFORM_KEY_PREFIX)) {
    if (obj.lastModified && obj.lastModified > objectCutoff) continue;
    transformBatch.push(obj);
    if (transformBatch.length >= OBJECT_BATCH_SIZE) await processTransformBatch();
  }
  await processTransformBatch();

  return result;
}

/**
 * Load every Asset's id and storageKey into two in-memory Sets.
 *
 * Used only by `dryRunCleanup` — the executing path does per-key and batched
 * `id IN (…)` lookups instead, since the LIST iteration can take long enough on
 * a big bucket that a snapshot would race against new uploads.
 *
 * Read in ONE keyset-paginated pass returning BOTH sets, rather than two
 * unbounded `findMany()` calls. Two things were wrong with that shape: the whole
 * Asset table landed in memory with no `take`, and it landed there twice, with
 * both result arrays live at once. Dry-run is reachable from a button at
 * `/admin/assets/cleanup`, so the cost is a function of table size rather than of
 * anything the caller does — one legitimate click on a large deployment was
 * enough. Paging bounds the row objects to `SCAN_PAGE_SIZE` at a time; the Sets
 * themselves still grow with the table, which is inherent to the snapshot and
 * far cheaper than the Prisma rows.
 */
const SCAN_PAGE_SIZE = 5_000;

async function loadKnownAssets(): Promise<{ keys: Set<string>; ids: Set<string> }> {
  const keys = new Set<string>();
  const ids = new Set<string>();
  await forEachPage(
    (page) =>
      prisma.asset.findMany({
        where: keysetWhere(page.afterId),
        select: { id: true, storageKey: true },
        orderBy: { id: "asc" },
        take: page.take,
      }),
    SCAN_PAGE_SIZE,
    (rows) => {
      for (const row of rows) {
        ids.add(row.id);
        keys.add(row.storageKey);
      }
    },
  );
  return { keys, ids };
}
