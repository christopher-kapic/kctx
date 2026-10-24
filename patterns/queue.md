# Background Jobs (BullMQ)

Background jobs use one shared runtime in `apps/worker/src/runtime.ts`, powered by [BullMQ](https://docs.bullmq.io/) + Redis. By default it runs inside the app (`WORKER_MODE=embedded`). A separate worker container is optional, not a prerequisite for queues or backup monitoring.

## Architecture

```
packages/queue/       → Shared: connection, queue instances, job schemas
packages/api/         → Producer: adds jobs via oRPC procedures
apps/worker/          → Consumer: processes jobs
```

Set `WORKER_MODE=external` on the server when deploying a dedicated worker. Both need the same database, Redis, and enabled-feature configuration. Never share a Redis database across dev/prod: queue names and consumer health are scoped to that Redis database. There is no automatic embedded fallback when an external worker disappears.

The shared runtime starts all consumers only after scheduler registration succeeds. Embedded mode limits each queue to one concurrent job (different queues can still run concurrently); external mode honors existing per-queue concurrency knobs. Allow memory for native image processing (the `analyze-asset` handler decodes with sharp, whose buffers live outside the V8 heap), not just the Node heap; choose an external worker when that load should be isolated from HTTP.

`/ready` checks consumer availability as well as Postgres/Redis. External consumers publish a Redis-server-time heartbeat every five seconds, expiring after fifteen seconds; a missing worker makes readiness fail. The worker image's Docker health check uses a production-only loopback endpoint on port 3001, which must not be published. Both images allow 480 seconds of startup grace for the default 300-second schema gate plus bounded dependency/consumer startup. If you raise the schema wait limit, raise the image/orchestrator startup grace too. Heartbeats are availability signals, not job ownership locks: BullMQ and the existing per-execution leases retain that ownership.

Each heartbeat covers the runtime's complete registered queue inventory under a unique replica UUID. The server requires an unexpired external consumer for every queue in its own `QUEUE_NAMES`: an older worker missing a newly added queue cannot admit the new server, while adjacent releases with the same queues can overlap. Heartbeats do not prove handler or payload compatibility; keep those contracts compatible across adjacent releases. Old process-only heartbeats cannot satisfy this inventory check.

Both process hosts install signal and fatal handlers before starting consumers and pass startup cancellation into the runtime. During cancellation, consumers stop accepting jobs immediately even if the initial heartbeat is pending; active jobs drain before shared Prisma and producer clients disconnect. A failed or timed-out drain exits under the host watchdog without treating a rejected startup as proof that jobs have stopped. The runtime cannot restart within the same process.

### Scaling

- **Server** (producer): stateless, autoscales freely.
- **Worker** (consumer): needs at least 1 replica running. Scales horizontally — BullMQ handles job locking so multiple workers safely consume the same queue.
- **Redis**: required infrastructure. Use managed Redis (AWS ElastiCache, Upstash, …) or a container. If Redis is configured with `maxmemory`, its policy must be `noeviction` — BullMQ is not safe under eviction ([patterns/deployment-vps.md § 5. Provision managed Redis](./deployment-vps.md#5-provision-managed-redis)).

## Observability

The starter ships two operator-facing failure surfaces:

- `/admin/jobs` lists failed jobs across every registered queue via `orpc.queue.listFailed`. It is admin-only and intentionally read-only; use it to inspect recent failures before checking provider logs.
- The worker sends operational-alert email to verified admins who have enabled alerts in settings. Alerts use the same `SMTP_*` transport as auth email, are best-effort, and are throttled per queue/error fingerprint for one hour so a repeated deterministic failure does not flood the mail provider.

If SMTP is not configured or no verified admin has alerts enabled, the jobs page remains the primary in-app signal.

## Adding a new job

### 1. Define the job schema in `packages/queue/src/jobs.ts`

```ts
import { z } from "zod";

export const sendEmailJobSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
});

export type SendEmailJobData = z.infer<typeof sendEmailJobSchema>;

export const QUEUE_NAMES = {
  echo: "echo",
  email: "email",      // ← add the queue name
} as const;
```

### 2. Create the queue in `packages/queue/src/index.ts`

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";
import { QUEUE_NAMES } from "./jobs.js";

export const emailQueue = new Queue(QUEUE_NAMES.email, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 5000 },
  },
});
```

### 3. Add a producer (oRPC procedure) in `packages/api/src/routers/queue.ts`

```ts
import { emailQueue, sendEmailJobSchema } from "@starter/queue";
import { protectedProcedure } from "../index";

// Inside the queueRouter object:
enqueueEmail: protectedProcedure
  .input(sendEmailJobSchema)
  .handler(async ({ input }) => {
    const job = await emailQueue.add("send-email", input);
    return { jobId: job.id };
  }),
```

**Pick the procedure level deliberately.** `protectedProcedure` is the right default *only* when enqueuing is a legitimate action for any signed-in user (e.g. a user triggering their own export email). If the job is operational or expensive — bulk sends, reindexing, transcodes, anything a normal user has no reason to trigger — gate it with `adminOr404Procedure` instead, so non-admins get a 404 rather than a working enqueue endpoint. The shipped demo `enqueueEcho` in `packages/api/src/routers/queue.ts` uses `adminOr404Procedure` for exactly this reason: it exists to prove the queue works, not as a user-facing feature. When in doubt, start admin-gated and loosen only when a real user flow needs it.

### 4. Add a worker in `apps/worker/src/runtime.ts`

```ts
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { createRedisConnection, QUEUE_NAMES } from "@starter/queue";
import type { SendEmailJobData } from "@starter/queue";

// Inside startWorkerRuntime: use its tracked factory so startup, health and
// shutdown include the new consumer automatically.
const emailWorker = createWorker<SendEmailJobData>(
  QUEUE_NAMES.email,
  async (job: Job<SendEmailJobData>) => {
    // Your processing logic here
    console.log(`Sending email to ${job.data.to}`);
  },
  { connection, concurrency: embedded ? 1 : 5 },
);

emailWorker.on("completed", (job) => {
  console.log(`[email] Job ${job.id} completed`);
});

emailWorker.on("failed", (job, err) => {
  console.error(`[email] Job ${job?.id} failed:`, err.message);
});
```

## Recurring / cron jobs

BullMQ's current recurring-work primitive is the **Job Scheduler** API. Upsert
each scheduler at worker startup so its schedule survives restarts and
configuration changes. The starter does this for the asset cleanup sweep in
`apps/worker/src/runtime.ts`:

```ts
await cleanupAssetsQueue.upsertJobScheduler(
  CLEANUP_ASSETS_JOB_SCHEDULER_ID,
  { pattern: CLEANUP_ASSETS_CRON_PATTERN },
  { name: "cleanup-assets", data: { reason: "cron" } },
);
```

Treat the first argument as durable infrastructure identity: define it as a
stable `*_JOB_SCHEDULER_ID` constant and never derive it from the cron pattern.
`upsertJobScheduler` is idempotent by that ID, including when several worker
replicas boot together. Changing `CLEANUP_ASSETS_CRON_PATTERN` updates the
existing scheduler on the next worker start instead of leaving an old schedule
behind.

Remove a recurring job **before deleting its queue or worker registration**, by
calling the same queue's `removeJobScheduler` with the exact stable ID:

```ts
await cleanupAssetsQueue.removeJobScheduler(CLEANUP_ASSETS_JOB_SCHEDULER_ID);
```

Do this as a one-shot deployment step while Redis and the old queue contract
still exist. Removing source code alone does not remove scheduler state already
stored in Redis.

For the asset cleanup itself, see [patterns/assets.md § Cleanup — orphan PENDING rows and unreferenced S3 objects](./assets.md#cleanup--orphan-pending-rows-and-unreferenced-s3-objects).

## Running locally

```bash
# App and embedded consumers (one process)
pnpm dev:server

# Alternatively, dedicated consumers: opt the server out explicitly
WORKER_MODE=external pnpm dev:server
pnpm dev:worker

# Or run everything together (the dev wrapper selects external automatically)
pnpm dev
```

## Job options

```ts
await queue.add("job-name", data, {
  delay: 5000,              // delay in ms before processing
  priority: 1,              // lower = higher priority
  attempts: 5,              // total retry attempts
  backoff: {
    type: "exponential",    // or "fixed"
    delay: 1000,            // initial delay
  },
  removeOnComplete: true,   // or { age: 3600, count: 1000 }
  removeOnFail: false,      // keep failed jobs for inspection
});
```

## Running short jobs without the queue

If you remove BullMQ, operator-triggered jobs that are genuinely short (the **seed** button is the canonical example) can run synchronously inside the request instead of being enqueued. The hard constraints (seconds not minutes, no retries, must be idempotent) and a worked before/after swap are in [patterns/removable/queue.md § Running a short job inline without the queue](./removable/queue.md#running-a-short-job-inline-without-the-queue).

## Removal

To remove BullMQ from the starter (full recipe + restore steps: [patterns/removable/queue.md](./removable/queue.md)):

1. Remove every BullMQ producer and the owning feature, or replace it with the recipe's tested synchronous/external path.
2. Delete `apps/worker/` and shrink `packages/queue/` to its Redis connection exports.
3. Keep `REDIS_URL`, `ioredis`, and `@starter/queue`: the server's fail-closed distributed rate limiters still require them.
4. Remove the queue inspection router/UI and worker-only scripts, deployment resources, and BullMQ dependency.
5. Run the recipe's exhaustive producer audit and verification list.

Do not use this summary as a deletion checklist. The [full removal recipe](./removable/queue.md) is canonical because it accounts for rate limiting, each job producer, deployment wiring, and restoration.
