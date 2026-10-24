import type { ReapedAuthTokens } from "@starter/api/lib/auth-token-retention";
import { reapExpiredAuthTokens } from "@starter/api/lib/auth-token-retention";
import type { ReapExpiredAuthTokensJobData } from "@starter/queue";
import { reapExpiredAuthTokensJobSchema } from "@starter/queue";
import type { Job } from "bullmq";

export async function handleReapExpiredAuthTokensJob(
  job: Job<ReapExpiredAuthTokensJobData>,
): Promise<{ reason: "cron"; deleted: ReapedAuthTokens }> {
  const { reason } = reapExpiredAuthTokensJobSchema.parse(job.data);
  const start = Date.now();
  const { deleted } = await reapExpiredAuthTokens();
  console.log(
    `[reap-expired-auth-tokens] Job ${job.id} (${reason}) deleted ` +
      `${deleted.sessions} session(s), ${deleted.verifications} verification(s) ` +
      `in ${Date.now() - start}ms`,
  );
  return { reason, deleted };
}
