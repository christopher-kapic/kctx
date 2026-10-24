import { ORPCError } from "@orpc/server";
import { env } from "@starter/env/server";
import { ensureRunnableJob, seedQueue } from "@starter/queue";
import { z } from "zod";

import { adminOr404Procedure } from "../index";

/**
 * Type-to-confirm phrase the operator must enter before a seed runs. The
 * server is the source of truth — never trust the client. Production uses a
 * deliberately loud phrase because seeding a live database is a foot-cannon
 * (the "Allow with extra confirm" policy chosen at design time; the safest
 * version of that is a stricter phrase + a loud UI warning, both below).
 *
 * Exported so it can be unit-tested directly without standing up the env.
 */
export function requiredConfirmPhrase(nodeEnv: string): string {
  return nodeEnv === "production" ? "SEED PRODUCTION" : "seed";
}

export const seedRouter = {
  /**
   * Drives the admin page: which confirm phrase to require and whether to
   * show the production danger banner. Admin-gated so it leaks nothing.
   */
  info: adminOr404Procedure.handler(() => {
    const isProduction = env.NODE_ENV === "production";
    return {
      isProduction,
      requiredConfirmPhrase: requiredConfirmPhrase(env.NODE_ENV),
    };
  }),

  /**
   * Enqueue the seed on the BullMQ `seed` queue. Returns the job id so the UI
   * can poll `queue.getJob({ queue: "seed" })` for the per-step summary.
   *
   * ── If you remove BullMQ ────────────────────────────────────────────────
   * The queue is a removable pattern. With it gone, replace the enqueue below
   * with a synchronous inline run (the request blocks — only safe because the
   * seed is required to be short). The exact before/after swap and its hard
   * constraints are documented in:
   *   patterns/removable/queue.md
   *     § Running a short job inline without the queue
   * In short: drop the `@starter/queue` import, `import { runSeed } from
   * "@starter/db/seed"`, `const result = await runSeed();` here, return
   * `{ result }`, and have the UI render `result` directly instead of polling.
   * ────────────────────────────────────────────────────────────────────────
   */
  run: adminOr404Procedure
    .input(z.object({ confirm: z.string() }))
    .handler(async ({ input, context }) => {
      const expected = requiredConfirmPhrase(env.NODE_ENV);
      if (input.confirm.trim() !== expected) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Confirmation phrase does not match. Type "${expected}" exactly to run the seed.`,
        });
      }

      // One seed job at a time — the jobId is a constant, so a second admin
      // pressing the button while a run is queued joins that run instead of
      // starting a rival one. `ensureRunnableJob` re-stamps the payload before
      // requeueing a retained job, so the `requestedBy` the worker logs is
      // whoever asked for THIS run rather than whoever seeded first.
      const job = await ensureRunnableJob(
        seedQueue,
        "seed",
        { requestedBy: context.session.user.id },
        "seed",
      );
      // Report a missing id as missing rather than echoing the jobId we asked
      // for: the UI polls this value, and inventing "seed" for a job BullMQ
      // never confirmed would have it poll a job that does not exist.
      return { jobId: job.id ?? null };
    }),
};
