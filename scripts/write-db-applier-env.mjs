#!/usr/bin/env node
/**
 * Write a shell-sourceable env file for in-container cron backup jobs.
 * Cron does not inherit the container environment — schedule mode writes
 * /app/db-applier.env at startup and sources it before each backup run.
 */
import { writeFileSync } from "node:fs";

const dest = process.argv[2];
if (!dest) {
  console.error("FATAL: usage: write-db-applier-env.mjs <dest-path>");
  process.exit(1);
}

const KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "BACKUP_ENABLED",
  "BACKUP_PRE_APPLY_ENABLED",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
  "BACKUP_S3_REGION",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_PREFIX",
  "BACKUP_S3_FORCE_PATH_STYLE",
  "BACKUP_S3_SSE",
  // Non-secret comparison ID only — lets backup.sh refuse a reused app upload key.
  "S3_ACCESS_KEY_ID",
  // Without these two, an in-container schedule silently drops the dead-man's
  // -switch ping (so the monitoring service reports the backup as missing even
  // though it ran) and falls back to the default local retention.
  "BACKUP_HEARTBEAT_URL",
  "BACKUP_KEEP_LOCAL",
];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const lines = KEYS.filter((key) => process.env[key]).map(
  (key) => `export ${key}=${shellQuote(process.env[key])}`,
);

writeFileSync(dest, `${lines.join("\n")}\n`, { mode: 0o600 });
console.log(`Wrote ${lines.length} variables to ${dest}`);
