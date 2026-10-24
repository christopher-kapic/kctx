import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { backupCommonConfigWarnings } from "./backup-config.js";
import { sharedVars } from "./vars/shared.js";

// ---------------------------------------------------------------------------
// Worker-safe environment — validation only.
//
// This module validates ONLY the variables that the BullMQ worker (and the
// packages it shares with the server: @starter/db, @starter/queue,
// @starter/api/lib/storage, @starter/i18n-translate, @starter/mailer) actually
// read. It is the import target for every worker-reachable module.
//
// The server's full surface lives in ./server.ts, which `extends` this module
// and adds the server-only variables (Better-Auth, CORS, SSO, VAPID,
// rate limits, admin emails, image proxy, …). Importing `@starter/env/server`
// from worker-graph code would force the worker to set BETTER_AUTH_URL,
// BETTER_AUTH_SECRET, etc. — variables the worker never uses. SMTP is included
// here because the worker can send operational-alert emails without needing
// Better-Auth URL/secret validation.
//
// The strict-boolean helper lives in ./vars/shared.ts.
//
// Do NOT load `.env` here. This file is imported by auth/db and by the web SSR
// graph; a dotenv side effect left `dotenv` as a Vite SSR runtime external and
// broke production containers. Process entrypoints load the root `.env` first,
// via `@starter/env/load-dotenv` or `loadRootDotenv()` — see that file for the
// full rule, and `pnpm env:check-entrypoints` for the gate that enforces it.
//
// The variable declarations themselves live in ./vars/shared.ts — a
// side-effect-free module, so `pnpm env:check` can read the key set without
// triggering validation. Declare new variables there, never inline in the
// `createEnv` call.
// ---------------------------------------------------------------------------

export {
  type BackupConfig,
  backupCommonConfigWarnings,
  backupMonitorConfigWarnings,
} from "./backup-config.js";

export const env = createEnv({
  server: sharedVars,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  // `S3_REGION` defaults to "auto", which is a Cloudflare R2 convention and
  // meaningless to AWS. With no `S3_ENDPOINT` the SDK addresses the bucket at
  // `s3.<region>.amazonaws.com`, so the default silently produces the
  // nonexistent host `s3.auto.amazonaws.com` — every upload fails at request
  // time with a DNS error that names nothing useful. Only reachable when S3 is
  // actually enabled (`S3_BUCKET` set) and pointed at real AWS.
  createFinalSchema: (shape) =>
    z.object(shape).superRefine((value, ctx) => {
      if (value.S3_BUCKET && !value.S3_ENDPOINT && value.S3_REGION === "auto") {
        ctx.addIssue({
          code: "custom",
          path: ["S3_REGION"],
          message:
            'S3_REGION must be a real AWS region (e.g. "us-east-1") when S3_ENDPOINT is unset. ' +
            'The default "auto" is an R2 convention — set S3_ENDPOINT for R2/MinIO/B2/Spaces.',
        });
      }
      // These are shared backup-location warnings only. Writer and freshness
      // credentials intentionally have different grants, so their validators
      // run at their respective consumers rather than making a monitor-only
      // worker look misconfigured for lacking the dump key.
      for (const warning of backupCommonConfigWarnings(value)) {
        console.warn(`WARNING: ${warning}`);
      }
    }),
});

export const S3_FORCE_PATH_STYLE: boolean = env.S3_FORCE_PATH_STYLE;
