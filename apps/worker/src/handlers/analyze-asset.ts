import { analyzeStoredAsset } from "@starter/api/lib/assets";
import type { AnalyzeAssetJobData } from "@starter/queue";
import { analyzeAssetJobSchema } from "@starter/queue";
import type { Job } from "bullmq";

/**
 * Re-derive an Asset's width/height/blurhash from the bytes in S3 and flip
 * metadataState to SERVER_VERIFIED. Enqueued by the presigned-upload finalize
 * handler so client-supplied hints are eventually replaced with server-verified
 * values.
 *
 * Lazy import on the API side keeps sharp out of bundles that don't need it.
 */
export async function handleAnalyzeAssetJob(job: Job<AnalyzeAssetJobData>) {
  // Parsed rather than destructured: the payload crosses a queue boundary, so
  // payload drift must fail loudly instead of analyzing a bogus id.
  const { assetId } = analyzeAssetJobSchema.parse(job.data);
  const result = await analyzeStoredAsset(assetId);
  if (!result) {
    console.warn(
      `[analyze-asset] Job ${job.id}: asset ${assetId} not analyzable (missing or pending)`,
    );
    return { skipped: true, assetId };
  }
  return {
    assetId,
    metadataState: result.metadataState,
    width: result.width,
    height: result.height,
  };
}
