#!/usr/bin/env bash
# Database backup — runs pg_dump -Fc against $DATABASE_URL and writes a
# timestamped custom-format dump into BACKUP_DIR (default: <repo>/backups for
# local runs; scripts/db-applier.sh passes a mktemp dir inside containers, where
# /app is read-only for the `node` user). If BACKUP_S3_BUCKET is set, the dump
# is uploaded to that private S3/R2 bucket after pg_dump succeeds.
# The connection URL is parsed into PG* environment variables before pg_dump
# starts so the password is not exposed via argv.
#
# Usage:
#   DATABASE_URL=postgresql://... ./scripts/backup.sh
#
# Restore:
#   scripts/backup.sh writes pg_dump custom format (-Fc). Restore with
#   the canonical db-applier restore mode. See patterns/backup-and-restore.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/backup-env.sh
source "$ROOT/scripts/lib/backup-env.sh"
source "$ROOT/scripts/lib/owned-child.sh"

if [ "${BACKUP_REQUIRED:-0}" != "1" ] && ! backup_enabled; then
  echo "WARNING: BACKUP_ENABLED=false — skipping backup." >&2
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  echo "       Export it before running: DATABASE_URL=postgresql://... $0" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [ ! -w "$BACKUP_DIR" ]; then
  echo "FATAL: backup directory '$BACKUP_DIR' is not writable by $(id -un)." >&2
  echo "       Set BACKUP_DIR to a writable path (containers should pass a mktemp dir)." >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
# Seconds alone collide when a scheduled dump and a required pre-apply/restore
# snapshot overlap. The random suffix is non-secret and makes the S3 object
# identity collision-resistant; upload also uses an unconditional-create guard.
BACKUP_RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
OUTFILE="$BACKUP_DIR/backup-$TIMESTAMP-$BACKUP_RUN_ID.dump"

# `backup.sh` is the owner immediately above the finite local writers. On a
# supported signal it stops admitting later stages and waits for the current
# direct writer before it exits. Its db-applier parent then owns removal of the
# private BACKUP_DIR, so that removal cannot race a dump, validation, upload
# result write, heartbeat, or local-pruning consumer. Cancellation uses a private
# channel to the supervisor that owns the actual native process handle.
backup_writer_pid=""
backup_writer_control=""
backup_writer_starting=0
backup_writer_signal=""
backup_writer_pending_signal=""
drain_backup_writer() {
  local signal="$1"
  [ -z "$backup_writer_signal" ] || return
  backup_writer_signal="$signal"
  trap '' HUP INT TERM
  if [ -n "$backup_writer_pid" ]; then
    owned_child_cancel 6
    owned_child_wait "$backup_writer_control" 6 "$backup_writer_pid" || true
    backup_writer_pid=""
  fi
}
request_backup_writer_shutdown() {
  local signal="$1"
  if [ "$backup_writer_starting" = 1 ]; then
    [ -n "$backup_writer_pending_signal" ] || backup_writer_pending_signal="$signal"
    return
  fi
  drain_backup_writer "$signal"
}
run_backup_writer() {
  # Enter the start state before looking at shutdown.  A caught signal before
  # this helper's admission is rejected below without a fork; one that arrives
  # while the start is in progress is retained until `$!` is recorded, then
  # drained by this same owner.  The state therefore covers the whole handoff,
  # rather than treating a pre-start check as atomic.
  backup_writer_starting=1
  if [ -n "$backup_writer_signal" ]; then
    backup_writer_starting=0
    case "$backup_writer_signal" in
      HUP) return 129 ;;
      INT) return 130 ;;
      TERM) return 143 ;;
    esac
  fi
  backup_writer_control="$OUTFILE.control"
  owned_child_open "$backup_writer_control" 6 || return $?
  owned_child_run "$backup_writer_control" 6 native 0 "$@" &
  backup_writer_pid=$!
  backup_writer_starting=0
  if [ -n "$backup_writer_pending_signal" ]; then
    drain_backup_writer "$backup_writer_pending_signal"
  fi
  if [ -n "$backup_writer_signal" ]; then
    case "$backup_writer_signal" in
      HUP) return 129 ;;
      INT) return 130 ;;
      TERM) return 143 ;;
    esac
  fi
  local status=0
  if owned_child_wait "$backup_writer_control" 6 "$backup_writer_pid"; then
    status=0
  else
    status=$?
  fi
  case "$backup_writer_signal" in
    HUP) status=129 ;;
    INT) status=130 ;;
    TERM) status=143 ;;
  esac
  backup_writer_pid=""
  if [ ! -f "$backup_writer_control.drained" ]; then exit 125; fi
  local drained_control="$backup_writer_control"
  backup_writer_control=""
  owned_child_clear "$drained_control"
  return "$status"
}
cleanup_backup_writer() {
  trap '' HUP INT TERM
  if [ -n "$backup_writer_pid" ]; then
    owned_child_cancel 6
    owned_child_wait "$backup_writer_control" 6 "$backup_writer_pid" || true
    backup_writer_pid=""
  fi
  if ! owned_child_clear "$backup_writer_control"; then exit 125; fi
}
trap cleanup_backup_writer EXIT
trap 'request_backup_writer_shutdown HUP' HUP
trap 'request_backup_writer_shutdown INT' INT
trap 'request_backup_writer_shutdown TERM' TERM

# The helpers below also check this boundary, but checking here prevents a
# caught signal before the first stage from doing further backup work first.
if [ -n "$backup_writer_signal" ]; then
  case "$backup_writer_signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
fi

echo "Writing backup to $OUTFILE"

# Parse the connection URL into PG* env vars so the password never appears in
# argv. node emits each field NUL-terminated; `read -d ''` assigns the raw bytes
# literally, so passwords containing $, backticks, backslashes, or spaces are
# handled correctly (an `eval` of quoted strings is not safe for those).
{
  IFS= read -r -d '' PGHOST
  IFS= read -r -d '' PGPORT
  IFS= read -r -d '' PGDATABASE
  IFS= read -r -d '' PGUSER
  IFS= read -r -d '' PGPASSWORD
  IFS= read -r -d '' DB_SSLMODE
} < <(
  node -e '
const url = new URL(process.env.DATABASE_URL);
const fields = [
  url.hostname,
  url.port || "5432",
  url.pathname.replace(/^\/+/, "").split("?")[0],
  decodeURIComponent(url.username),
  decodeURIComponent(url.password),
  url.searchParams.get("sslmode") || "",
];
process.stdout.write(fields.map((value) => `${value}\0`).join(""));
'
)
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
[ -n "$DB_SSLMODE" ] && export PGSSLMODE="$DB_SSLMODE"

# pg_dump can dump a server OLDER than itself, never a newer one. If the image's
# postgresql-client falls behind the managed Postgres major, every backup fails
# with a message most people cannot act on — so check it here and say what to fix.
pg_client_supports_server() {
  [ "$1" -ge "$2" ]
}

if ! SERVER_VERSION_NUM="$(PGCONNECT_TIMEOUT=10 PGOPTIONS='-c statement_timeout=60s -c lock_timeout=5s' node "$ROOT/scripts/lib/bounded-child.mjs" 75000 psql -X -Atqc 'SHOW server_version_num' 2>&1)"; then
  echo "FATAL: could not read the server version from $PGHOST:$PGPORT/$PGDATABASE." >&2
  echo "       psql said: $SERVER_VERSION_NUM" >&2
  echo "       pg_dump would fail on the same connection — fix DATABASE_URL or network access." >&2
  exit 1
fi
if [ -n "$backup_writer_signal" ]; then
  case "$backup_writer_signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
fi
case "$SERVER_VERSION_NUM" in
  '' | *[!0-9]*)
    echo "FATAL: unexpected server_version_num from Postgres: '$SERVER_VERSION_NUM'." >&2
    exit 1
    ;;
esac
SERVER_MAJOR=$((SERVER_VERSION_NUM / 10000))
CLIENT_MAJOR="$(pg_dump --version | awk '{print $3}' | sed 's/[^0-9].*//')"
if [ -z "$CLIENT_MAJOR" ]; then
  echo "FATAL: could not parse the pg_dump version ($(pg_dump --version 2>&1))." >&2
  exit 1
fi
if ! pg_client_supports_server "$CLIENT_MAJOR" "$SERVER_MAJOR"; then
  echo "FATAL: pg_dump is version $CLIENT_MAJOR but the server is version $SERVER_MAJOR." >&2
  echo "       A newer client can dump an older server; the reverse is not supported." >&2
  echo "       Raise ARG PG_MAJOR in Dockerfile, Dockerfile.worker, and Dockerfile.db-applier" >&2
  echo "       to $SERVER_MAJOR (and your Postgres server's major), rebuild the images," >&2
  echo "       then re-run. \`pnpm docker:check-copy\` verifies the three files agree." >&2
  exit 1
fi
echo "INFO: pg_dump client major $CLIENT_MAJOR, server major $SERVER_MAJOR."

# Backup-bucket configuration is enforced HERE, at the moment a dump would be
# written — not in packages/env, which the web server and the worker boot on.
# A backup-only mistake must never crash-loop the app; it must stop the backup
# and say exactly what to fix. The same writer rules are re-checked in
# scripts/lib/backup-s3-env.mjs (the upload/download helpers). Shared env boot
# logs only bucket/region warnings because the normal worker does not hold this
# dump-writer credential.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if [ -z "${BACKUP_S3_ACCESS_KEY_ID:-}" ] || [ -z "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
    echo "FATAL: BACKUP_S3_BUCKET is set but BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY are missing." >&2
    echo "       Use a dedicated dump-writer key (GetObject/PutObject/AbortMultipartUpload only)." >&2
    echo "       Never S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY." >&2
    exit 1
  fi
  if [ -n "${S3_ACCESS_KEY_ID:-}" ] && [ "${BACKUP_S3_ACCESS_KEY_ID}" = "${S3_ACCESS_KEY_ID}" ]; then
    echo "FATAL: BACKUP_S3_ACCESS_KEY_ID matches S3_ACCESS_KEY_ID. Backups need a distinct key so a" >&2
    echo "       stolen app-upload credential cannot read database dumps." >&2
    exit 1
  fi
  # "auto" is a Cloudflare R2 convention. With no endpoint the AWS SDK would
  # address the bucket at the nonexistent host s3.auto.amazonaws.com and every
  # upload would fail with a DNS error that names nothing useful.
  if [ -z "${BACKUP_S3_ENDPOINT:-}" ] && [ "${BACKUP_S3_REGION:-auto}" = "auto" ]; then
    echo "FATAL: BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset." >&2
    echo "       The default \"auto\" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces." >&2
    exit 1
  fi
fi

# The reserved control schema holds this target's own schema-release receipts.
# A restored source must never replace the target's control state.
run_backup_writer pg_dump -Fc --no-owner --no-privileges --exclude-schema=starter_control -f "$OUTFILE"

if ! run_backup_writer pg_restore --list "$OUTFILE" >/dev/null; then
  echo "FATAL: pg_restore --list rejected $OUTFILE (dump is corrupt or empty)." >&2
  exit 1
fi

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  run_backup_writer node "$(dirname "$0")/upload-backup-to-s3.mjs" "$OUTFILE"
  # The heartbeat attests that a dump landed off-site, so it is only sent after
  # the upload succeeds. A failed ping never fails the backup (see the script).
  if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
    run_backup_writer node "$(dirname "$0")/backup-heartbeat.mjs"
  fi
elif [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  echo "WARNING: BACKUP_HEARTBEAT_URL is set but BACKUP_S3_BUCKET is not — heartbeat not sent (no off-site upload to attest to)." >&2
fi

# Keep a small local window so a full disk cannot be the first failure mode.
# Uploaded objects are not pruned here — use the bucket lifecycle rule.
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-7}"
# Keep this a direct file consumer: cancelling a shell pipeline would not prove
# its rm descendant had stopped before the parent removed BACKUP_DIR.
run_backup_writer node -e '
  const fs = require("node:fs"), path = require("node:path");
  const [directory, value] = process.argv.slice(1), keep = Number(value);
  if (!Number.isSafeInteger(keep) || keep < 0) process.exit(1);
  const dumps = fs.readdirSync(directory).filter((name) => /^backup-.*\.dump$/.test(name))
    .map((name) => ({ file: path.join(directory, name), time: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const dump of dumps.slice(keep)) fs.unlinkSync(dump.file);
' "$BACKUP_DIR" "$KEEP_LOCAL"

trap - EXIT HUP INT TERM
echo "Done."
