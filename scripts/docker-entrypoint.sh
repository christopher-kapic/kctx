#!/bin/sh
# Docker entrypoint — runs before the container CMD.
#
# Responsibilities:
#   1. Validate required environment variables.
#   2. Refuse every restore-only env var (restore is a guarded db-applier mode).
#   3. Gate schema sync on APPLY_SCHEMA by delegating to scripts/db-applier.sh
#      (advisory lock → non-authoritative preview or
#      guarded live diff/confirmation → backup → re-collect SHA →
#      migrate-diff SQL and receipt in one transaction).
#   4. exec the container CMD.
#
# Either image (server or worker) can lead schema sync via this entrypoint;
# the alternative topology is a deploy-gated one-shot db-applier job (the
# Dokploy setup). See
# patterns/schema-push.md and infra-notes.md.
#
# APPLY_SCHEMA values:
#   off       — skip schema sync. Normal app boot. Default when unset.
#   safe      — apply the guarded migrate-diff SQL if it is not
#               destructive (drop column, narrow type, etc.).
#   dangerous — apply that hashed SQL. Requires a fresh,
#               target/fingerprint/live-plan-bound APPLY_SCHEMA_CONFIRM.

set -e

# --- 1. Required env vars ---
missing=""
required_vars="DATABASE_URL REDIS_URL"
case " $* " in
  *" apps/server/dist/index.mjs"*|*" apps/server/"*)
    required_vars="$required_vars BETTER_AUTH_SECRET"
    ;;
esac

for var in $required_vars; do
  eval val=\$$var
  if [ -z "$val" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "FATAL: Missing required environment variable(s):$missing" >&2
  echo "       Set them in your orchestrator (e.g. Dokploy)." >&2
  # Deliberate: this check reads the process environment only. The Node bundle
  # CAN read a repo-root .env (see @starter/env/load-dotenv), so a mounted
  # /app/.env would satisfy the app but not this gate — and that asymmetry is
  # confusing enough to name here. The container contract is injected env: the
  # image ships no .env, and this check plus the psql readiness probe below both
  # depend on the values being in the environment.
  echo "       A mounted /app/.env does not satisfy this check — the container" >&2
  echo "       contract is injected environment variables, not an env file." >&2
  exit 1
fi

if [ "$NODE_ENV" = "production" ] && [ -z "$ADMIN_EMAILS" ]; then
  if [ "$SIGNUP_ENABLED" = "true" ]; then
    echo "WARNING: ADMIN_EMAILS is empty. No users will be granted admin privileges." >&2
    echo "         Set ADMIN_EMAILS to a comma-separated list of email addresses." >&2
  else
    # Matches the Node env-layer boot guard in packages/env/src/server.ts:
    # signup disabled + empty allowlist means no NEW admin can be bootstrapped.
    # The server keeps booting (provisioned installs hold their admins in the
    # database) — this is the best-effort early signal for the fresh-install
    # case. If no admin exists yet, set ADMIN_EMAILS before the first signup.
    echo "WARNING: ADMIN_EMAILS is empty and SIGNUP_ENABLED is not \"true\" —" >&2
    echo "         no new admin can be bootstrapped. If no admin exists yet," >&2
    echo "         set ADMIN_EMAILS to a comma-separated list of operator emails." >&2
  fi
fi

# Restore is a one-shot, guarded db-applier entrypoint mode. App/worker images
# retain pg_restore and helpers for the approved legacy apply path's
# `pg_restore --list` dump validation, so this boot gate is a supported-entrypoint
# guard, not an image-capability sandbox. Check the complete restore inventory:
# a leftover ETag or connection override must fail as loudly as the key itself.
restore_vars_present=false
for restore_var in \
  RESTORE_BACKUP_S3_KEY RESTORE_BACKUP_S3_ETAG RESTORE_BACKUP_S3_VERSION_ID \
  RESTORE_CONFIRM RESTORE_CONFIRM_NONCE RESTORE_ALLOW_ACTIVE_CONNECTIONS RESTORE_TARGET_MODE; do
  eval restore_val=\$$restore_var
  if [ -n "$restore_val" ]; then
    restore_vars_present=true
    break
  fi
done
if [ "$restore_vars_present" = true ]; then
  echo "FATAL: restore-only environment variables are set on this service." >&2
  echo "       Restore is supported only through an explicit one-shot db-applier" >&2
  echo "       job in mode restore (Dockerfile.db-applier)." >&2
  echo "       Unset RESTORE_BACKUP_S3_KEY, RESTORE_BACKUP_S3_ETAG," >&2
  echo "       RESTORE_BACKUP_S3_VERSION_ID, RESTORE_CONFIRM," >&2
  echo "       RESTORE_CONFIRM_NONCE, RESTORE_ALLOW_ACTIVE_CONNECTIONS, and RESTORE_TARGET_MODE here." >&2
  exit 1
fi

# --- 2. Schema sync ---
APPLY_SCHEMA="${APPLY_SCHEMA:-off}"
case "${WAIT_FOR_SCHEMA:-false}" in
  true)
    if [ "$APPLY_SCHEMA" != off ]; then
      echo "FATAL: WAIT_FOR_SCHEMA=true requires APPLY_SCHEMA=off. Select one schema leader." >&2
      exit 1
    fi
    node /app/scripts/wait-for-schema.mjs
    ;;
  false) ;;
  *) echo "FATAL: WAIT_FOR_SCHEMA must be true or false." >&2; exit 1 ;;
esac
case "$APPLY_SCHEMA" in
  off)
    echo "APPLY_SCHEMA=off — skipping schema sync."
    ;;
  safe|dangerous)
    if [ ! -f /app/scripts/db-applier.sh ]; then
      echo "FATAL: scripts/db-applier.sh is missing from this image." >&2
      exit 1
    fi
    bash /app/scripts/db-applier.sh apply
    ;;
  *)
    echo "FATAL: APPLY_SCHEMA=$APPLY_SCHEMA is invalid. Use off, safe, or dangerous." >&2
    exit 1
    ;;
esac

# --- 3. Hand off to the container CMD ---
exec "$@"
