import { createHash } from "node:crypto";
import { isAdminRole } from "@starter/auth/roles";
import prisma from "@starter/db";
import { isEmailConfigured, sendEmail } from "@starter/mailer";
import { createRedisConnection } from "@starter/queue";

type AlertArgs = {
  queue: string;
  jobId: string | number | undefined;
  message: string;
};

const ALERT_COOLDOWN_SECONDS = 60 * 60;
/**
 * Bound on the cooldown reservation. `alertConnection` is created with
 * `maxRetriesPerRequest: null` and no command timeout, so a `set()` issued
 * while Redis is unreachable neither resolves nor rejects — it would hang the
 * alert path (and, on the fatal-error path, the worker's exit) forever.
 */
const RESERVE_TIMEOUT_MS = 2_000;
const ADMIN_PAGE_SIZE = 50;
const EMAIL_CONCURRENCY = 8;
const alertConnection = createRedisConnection();

const operationalAlertRecipientWhere = {
  emailVerified: true,
  operationalAlerts: true,
};

export async function sendOperationalFailureAlert(args: AlertArgs): Promise<void> {
  const jobLabel = args.jobId === undefined ? "unknown" : String(args.jobId);
  await sendOperationalAlert({
    source: args.queue,
    message: args.message,
    subject: `[${args.queue}] background job failed`,
    html: `
    <p>A background job failed permanently.</p>
    <dl>
      <dt>Queue</dt><dd>${escapeHtml(args.queue)}</dd>
      <dt>Job</dt><dd>${escapeHtml(jobLabel)}</dd>
      <dt>Error</dt><dd>${escapeHtml(args.message)}</dd>
    </dl>
  `,
  });
}

type OperationalAlert = {
  /** Cooldown namespace — one alert per (source, normalized message) per window. */
  source: string;
  /** Normalized into the cooldown fingerprint; numbers and ids are masked. */
  message: string;
  subject: string;
  html: string;
  cooldownSeconds?: number;
};

/**
 * Email every admin who opted into operational alerts. Deduplicated in Redis
 * so a failure that repeats every minute produces one email per cooldown
 * window. Safe to call when SMTP is unconfigured (no-op).
 */
export async function sendOperationalAlert(alert: OperationalAlert): Promise<void> {
  if (!isEmailConfigured()) return;
  if (!(await reserveAlertSlot(alert))) return;
  const { subject, html } = alert;

  let afterId: string | undefined;
  for (;;) {
    const admins = await prisma.user.findMany({
      where: {
        // Roles permit whitespace around comma-separated tokens. Do the
        // authoritative tokenization in `isAdminRole` below rather than using
        // a lossy SQL substring prefilter; pagination keeps this bounded.
        ...operationalAlertRecipientWhere,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, email: true, role: true },
      orderBy: { id: "asc" },
      take: ADMIN_PAGE_SIZE,
    });
    if (admins.length === 0) break;
    afterId = admins[admins.length - 1]?.id;
    const recipients = admins
      .filter((admin) => isAdminRole(admin.role))
      .map((admin) => admin.email);
    for (let i = 0; i < recipients.length; i += EMAIL_CONCURRENCY) {
      const slice = recipients.slice(i, i + EMAIL_CONCURRENCY);
      await Promise.allSettled(slice.map((to) => sendEmail({ to, subject, html })));
    }
    if (admins.length < ADMIN_PAGE_SIZE) break;
    if (!afterId) break;
  }
}

export function closeOperationalAlertConnection(): void {
  alertConnection.disconnect();
}

async function reserveAlertSlot(args: {
  source: string;
  message: string;
  cooldownSeconds?: number;
}): Promise<boolean> {
  const fingerprint = createHash("sha256")
    .update(args.source)
    .update("\0")
    .update(normalizeError(args.message))
    .digest("hex")
    .slice(0, 32);
  const key = `operational-alert:${args.source}:${fingerprint}`;
  const cooldown = args.cooldownSeconds ?? ALERT_COOLDOWN_SECONDS;
  try {
    const result = await withTimeout(
      alertConnection.set(key, "1", "EX", cooldown, "NX"),
      RESERVE_TIMEOUT_MS,
      "Redis timed out reserving the alert cooldown",
    );
    return result === "OK";
  } catch (err) {
    // SKIP the alert rather than send it. Redis is what makes an alert
    // once-per-hour instead of once-per-failure; without it, a failure
    // repeating every minute — which is exactly what a Redis outage causes —
    // would mail every admin every minute. A missed email is recoverable; an
    // inbox flood during an incident is not. The failure is still logged here
    // and by whatever raised it.
    console.error(
      `[${args.source}] Skipping operational alert — could not reserve the cooldown in Redis:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Reject after `timeoutMs` rather than waiting on a promise that may never settle. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

function normalizeError(message: string): string {
  return message
    .replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replaceAll(/\b\d+\b/g, "<number>")
    .trim()
    .slice(0, 500);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
