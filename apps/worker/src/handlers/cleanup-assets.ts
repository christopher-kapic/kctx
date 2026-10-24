import { runCleanup } from "@starter/api/lib/asset-cleanup";
import type { CleanupAssetsJobData } from "@starter/queue";
import { cleanupAssetsJobSchema } from "@starter/queue";
import type { Job } from "bullmq";

/**
 * Reap orphan PENDING Asset rows and orphan S3 objects under the asset
 * prefix. Same code path whether the admin clicked the button or the 24h
 * cron fired.
 *
 * Storage-only work, deliberately: `runCleanup` throws when S3 is not
 * configured and this queue's scheduler is registered only `if (storage)`.
 */
export async function handleCleanupAssetsJob(job: Job<CleanupAssetsJobData>) {
  // Parsed rather than destructured: the payload crosses a queue boundary, so
  // payload drift must fail loudly instead of sweeping with an undefined threshold.
  const { reason, pendingMaxAgeMs, objectMinAgeMs, multipartMaxAgeMs } =
    cleanupAssetsJobSchema.parse(job.data);
  const start = Date.now();
  const result = await runCleanup({
    pendingMaxAgeMs,
    objectMinAgeMs,
    multipartMaxAgeMs,
  });
  console.log(`[cleanup-assets] Job ${job.id} (${reason}) finished in ${Date.now() - start}ms`, {
    result,
  });
  return { reason, ...result };
}
