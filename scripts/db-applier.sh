#!/usr/bin/env bash
# Database applier — the only production path that may dump, restore, or push
# schema. Server and worker entrypoints call this in `apply` mode; the
# dedicated db-applier image also supports `backup`, `restore`, and (via its
# entrypoint) `schedule`.
#
# Modes (first argument, or DB_APPLIER_MODE):
#   backup  — pg_dump -Fc, smoke-check, upload to S3 when configured, then
#             (optionally) ping BACKUP_HEARTBEAT_URL. When BACKUP_S3_* is not
#             configured yet it prints what to set and exits 0 — the scheduled
#             job must not go red every night for a bucket that was never
#             created. Apply mode's pre-apply backup rules stay strict.
#   apply   — delegates to scripts/apply-schema.mjs: one PostgreSQL session
#             holds the advisory lock, previews the live Prisma diff, takes
#             any required backup, re-collects the diff and requires SHA
#             equality, then applies that SQL and the schema receipt in one
#             transaction. `safe` warns and continues when the backup bucket
#             is unconfigured (a first deploy of an empty database must not be
#             blocked on backup storage) and refuses destructive SQL in the
#             plan. `dangerous` is stricter on both counts: it requires
#             APPLY_SCHEMA_CONFIRM to bind target id and schema fingerprint,
#             and unless backups are off it fails rather than proceed without
#             a pre-apply dump.
#   restore — a no-confirmation invocation previews the immutable S3 source;
#             a confirmed invocation validates the source and restores into
#             an empty destination. Explicit in-place mode also requires a
#             target snapshot and replaces public. Neither mode publishes a
#             schema receipt: complete the recovery handoff before admitting
#             runtimes. Requires target/source/nonce-bound approval and no
#             other destination connections (an explicit
#             RESTORE_ALLOW_ACTIVE_CONNECTIONS=<database name> overrides only
#             that connection check).
#
# Toggles (see scripts/lib/backup-env.sh):
#   BACKUP_ENABLED              — master switch for pg_dump uploads (default true)
#   BACKUP_PRE_APPLY_ENABLED    — pre-apply snapshot before db push (default true)
#   BACKUP_CRON                 — used by DB_APPLIER_MODE=schedule entrypoint
#   BACKUP_HEARTBEAT_URL        — optional dead-man's-switch pinged only after a
#                                 successful upload (never fails the backup)
#   BACKUP_MAX_AGE_HOURS        — read by the worker's freshness check, not here
#
# Restore: run the db-applier image in mode `restore` with RESTORE_BACKUP_S3_KEY
# and RESTORE_CONFIRM set on that one-shot job only. Every other mode refuses to
# start while restore vars are present. Never set them on web or worker.
#
# See patterns/backup-and-restore.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/backup-env.sh
source "$ROOT/scripts/lib/backup-env.sh"
source "$ROOT/scripts/lib/owned-child.sh"

MODE="${1:-${DB_APPLIER_MODE:-backup}}"
LOCK_ID=1145389648 # 0x44414450 = "DADP"

banner() {
  echo
  echo "================================================================"
  echo " $*"
  echo "================================================================"
  echo
}

run_previous_exit_trap() {
  local previous_trap="$1"
  [ -n "$previous_trap" ] || return 0
  # Saved by Bash itself, never external input. Preserve nested artifact owners
  # when EXIT replaces their handler; their state must outlive local frames.
  eval "set -- ${previous_trap#trap -- }"
  trap - EXIT
  eval "$1"
}

fatal() {
  echo "FATAL: $*" >&2
  exit 1
}

require_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    fatal "DATABASE_URL is not set."
  fi
}

load_pg_env() {
  require_database_url
  local pg_env
  pg_env="$(
    node -e '
      const u = new URL(process.env.DATABASE_URL);
      const SQ = String.fromCharCode(39);
      const q = (v) => SQ + String(v).split(SQ).join(SQ + "\\" + SQ + SQ) + SQ;
      const dec = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
      const out = [];
      out.push("export PGHOST=" + q(dec(u.hostname)));
      out.push("export PGPORT=" + q(u.port || "5432"));
      if (u.username) out.push("export PGUSER=" + q(dec(u.username)));
      if (u.password) out.push("export PGPASSWORD=" + q(dec(u.password)));
      const db = dec(u.pathname.replace(/^\//, "").split("?")[0]);
      if (db) out.push("export PGDATABASE=" + q(db));
      const sslmode = u.searchParams.get("sslmode");
      if (sslmode) out.push("export PGSSLMODE=" + q(sslmode));
      process.stdout.write(out.join("\n") + "\n");
    '
  )" || fatal "could not parse DATABASE_URL for libpq."
  eval "$pg_env"
}

target_identity() {
  node "$ROOT/scripts/lib/backup-identity.mjs"
}

bounded_client() {
  node "$ROOT/scripts/lib/bounded-child.mjs" "$@"
}

db_query() {
  PGCONNECT_TIMEOUT=10 PGOPTIONS="-c lock_timeout=5s -c statement_timeout=60s" bounded_client 75000 psql -X -q -v ON_ERROR_STOP=1 "$@"
}

with_schema_lock() {
  local operation="$1"
  load_pg_env
  if [ "$operation" = restore ]; then
    local server_version
    server_version="$(db_query -A -t -c 'SHOW server_version_num')" || fatal "could not read the PostgreSQL version."
    [[ "$server_version" =~ ^[0-9]+$ ]] && [ "$server_version" -ge 170000 ] || fatal "restore requires a PostgreSQL 17 or newer database server for bounded transaction execution; detected server_version_num '${server_version}'. Re-provision the database on PostgreSQL 17 or newer — no setting or flag upgrades the server."
  fi
  # Keep the advisory-lock psql session open through Bash-3-compatible FIFOs.
  # The applier itself is a separate direct child, not a psql `\\!` shell: this
  # removes the old late completion-status writer entirely. psql writes a
  # private result file, while this owner drains it before removing the dir.
  # EXIT runs after Bash may have unwound function locals. These uniquely named
  # owner fields deliberately have shell lifetime, reset at each invocation.
  lock_dir="" lock_commands="" lock_results=""
  lock_psql_pid="" lock_operation_pid="" lock_operation_control="" lock_shutdown_status=""
  lock_starting=0 lock_pending_signal="" lock_commands_open=0 lock_cleanup_started=0 lock_shutdown_return_status=0
  previous_lock_traps="$(trap -p EXIT HUP INT TERM || true)"
  previous_lock_exit_trap="$(trap -p EXIT || true)"
  restore_lock_traps() {
    trap - EXIT HUP INT TERM
    eval "$previous_lock_traps"
  }
  cleanup_lock_files() {
    [ -z "$lock_dir" ] || rm -rf "$lock_dir"
  }
  close_lock_commands() {
    if [ "$lock_commands_open" = 1 ]; then
      exec 3>&-
      lock_commands_open=0
    fi
  }
  finish_lock_session() {
    if [ "$lock_commands_open" = 1 ]; then
      printf 'SELECT pg_advisory_unlock(%s);\n\\q\n' "$LOCK_ID" >&3 || true
    fi
    close_lock_commands
    if [ -n "$lock_psql_pid" ]; then
      # The direct supervisor observes command EOF and bounds the final drain.
      wait "$lock_psql_pid" 2>/dev/null || true
      lock_psql_pid=""
    fi
  }
  cleanup_lock_owner() {
    if [ "$lock_cleanup_started" != 0 ]; then [ -z "$lock_operation_control" ] || return 125; return 0; fi
    lock_cleanup_started=1
    if [ -n "$lock_operation_pid" ]; then
      owned_child_cancel 7
      owned_child_wait "$lock_operation_control" 7 "$lock_operation_pid" || true
      lock_operation_pid=""
    fi
    finish_lock_session
    if [ -n "$lock_operation_control" ] && [ ! -f "$lock_operation_control.drained" ]; then return 125; fi
    lock_operation_control=""
    cleanup_lock_files
  }
  cleanup_lock_owner_exit() {
    trap '' HUP INT TERM
    cleanup_lock_owner || exit 125
    run_previous_exit_trap "$previous_lock_exit_trap"
  }
  drain_lock_psql() {
    local signal="$1"
    if [ "$lock_starting" = 1 ]; then
      [ -n "$lock_pending_signal" ] || lock_pending_signal="$signal"
      return
    fi
    [ -n "$lock_shutdown_status" ] && return
    lock_shutdown_status="$signal"
    # The channel remains bound to the original owner even after Bash reaps it.
    if [ -n "$lock_operation_pid" ]; then
      owned_child_cancel 7
    fi
  }
  lock_shutdown_return() {
    # A trap records shutdown but deliberately leaves the current command's
    # resources intact until this checkpoint.  Bash resumes the interrupted
    # command after a trap handler returns; removing FIFO peers in that handler
    # would make that resumed command reopen a deleted path.  Every transition
    # below reaches this checkpoint before another effect, where this owner can
    # drain its recorded children and remove the finite artifact exactly once.
    trap '' HUP INT TERM
    cleanup_lock_owner
    restore_lock_traps
    case "$lock_shutdown_status" in
      HUP) lock_shutdown_return_status=129 ;;
      INT) lock_shutdown_return_status=130 ;;
      TERM) lock_shutdown_return_status=143 ;;
    esac
  }
  trap cleanup_lock_owner_exit EXIT
  trap 'drain_lock_psql HUP' HUP
  trap 'drain_lock_psql INT' INT
  trap 'drain_lock_psql TERM' TERM
  lock_dir="$(mktemp -d)" || fatal "could not allocate a schema-lock directory."
  lock_commands="$lock_dir/commands"
  lock_results="$lock_dir/results"
  mkfifo "$lock_commands" || fatal "could not create the schema-lock command FIFO."
  : >"$lock_results" || fatal "could not allocate the schema-lock result file."
  if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
  # Open the sole command FIFO peer before creating its only consumer. O_RDWR
  # is intentional and non-blocking for a FIFO. The psql result is a regular
  # private file instead: retaining a writer on a result FIFO would suppress
  # EOF when psql exits before lock readiness, so failure could wait forever.
  exec 3<>"$lock_commands"
  lock_commands_open=1
  if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
  echo "Acquiring schema advisory lock ($LOCK_ID)..."
  lock_starting=1
  PGAPPNAME=starter-db-applier-lock PGCONNECT_TIMEOUT=10 PGOPTIONS="-c lock_timeout=300s -c statement_timeout=310s" node "$ROOT/scripts/lib/bounded-child.mjs" 0 --close-input psql -X -q -A -t -v ON_ERROR_STOP=1 <"$lock_commands" >"$lock_results" 3>&- &
  lock_psql_pid=$!
  lock_starting=0
  if [ -n "$lock_pending_signal" ]; then drain_lock_psql "$lock_pending_signal"; fi
  if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
  printf "SET lock_timeout = '300s';\nSELECT pg_advisory_lock(%s);\nSELECT pg_backend_pid();\n" "$LOCK_ID" >&3
  local lock_backend_pid="" lock_ready_deadline=$((SECONDS + 300))
  while :; do
    if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
    lock_backend_pid="$(awk '/^[[:space:]]*[0-9]+[[:space:]]*$/{gsub(/[[:space:]]/, ""); print; exit}' "$lock_results")"
    [ -z "$lock_backend_pid" ] || break
    # This is only a best-effort readiness probe, never cancellation authority.
    # The deadline also bounds waiting if Bash has already reaped this PID.
    if ! kill -0 "$lock_psql_pid" 2>/dev/null; then
      break
    fi
    if [ "$SECONDS" -ge "$lock_ready_deadline" ]; then
      break
    fi
    sleep 0.05
  done
  if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
  [ -n "$lock_backend_pid" ] || {
    cleanup_lock_owner
    restore_lock_traps
    fatal "could not acquire the schema advisory lock."
  }
  if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
  lock_starting=1
  owned_child_open "$lock_dir/operation-control" 7 || fatal "could not open child cancellation channel."
  lock_operation_control="$lock_dir/operation-control"
  DB_APPLIER_LOCK_HELD=1 DB_APPLIER_LOCK_PID="$lock_backend_pid" owned_child_run "$lock_operation_control" 7 cooperative 0 bash "$0" "$operation" 3>&- &
  lock_operation_pid=$!
  lock_starting=0
  if [ -n "$lock_pending_signal" ]; then drain_lock_psql "$lock_pending_signal"; fi
  if [ -n "$lock_shutdown_status" ]; then lock_shutdown_return; return "$lock_shutdown_return_status"; fi
  local operation_status=0
  if owned_child_wait "$lock_operation_control" 7 "$lock_operation_pid"; then
    operation_status=0
  else
    operation_status=$?
  fi
  if [ -n "$lock_shutdown_status" ]; then
    lock_shutdown_return
    return "$lock_shutdown_return_status"
  fi
  lock_operation_pid=""
  cleanup_lock_owner
  restore_lock_traps
  return "$operation_status"
}

run_backup() {
  require_database_url
  if [ ! -x "$ROOT/scripts/backup.sh" ] && [ ! -f "$ROOT/scripts/backup.sh" ]; then
    fatal "scripts/backup.sh is missing from this image."
  fi
  # Dump into a private temp dir, never under /app: the runtime images own /app
  # as root and run as `node`, and S3 is the durable store. A container-local
  # retention window would be meaningless on an ephemeral filesystem anyway.
  backup_dump_dir=""
  backup_pid="" backup_control="" backup_starting=1 backup_cleanup_started=0 backup_pending_signal="" backup_status=0 backup_shutdown_status=""
  backup_previous_traps="$(trap -p EXIT HUP INT TERM || true)"
  backup_previous_exit_trap="$(trap -p EXIT || true)"
  restore_backup_traps() {
    trap - EXIT HUP INT TERM
    eval "$backup_previous_traps"
  }
  cleanup_backup_dir() {
    if [ "$backup_cleanup_started" != 0 ]; then [ -z "$backup_control" ] || return 125; return 0; fi
    backup_cleanup_started=1
    if [ -n "$backup_pid" ]; then
      owned_child_cancel 8
      owned_child_wait "$backup_control" 8 "$backup_pid" || true
      backup_pid=""
    fi
    if [ -n "$backup_control" ] && [ ! -f "$backup_control.drained" ]; then return 125; fi
    backup_control=""
    [ -z "$backup_dump_dir" ] || rm -rf "$backup_dump_dir"
  }
  cleanup_backup_dir_exit() {
    trap '' HUP INT TERM
    # Unknown child lifetime also retains outer snapshot/source artifacts; an
    # uploader may still own their result path. Do not cascade their EXIT traps.
    cleanup_backup_dir || exit 125
    run_previous_exit_trap "$backup_previous_exit_trap"
  }
  stop_backup_and_cleanup() {
    local signal="$1"
    [ -z "$backup_shutdown_status" ] || return
    backup_shutdown_status="$signal"
    case "$signal" in
      HUP) backup_status=129 ;;
      INT) backup_status=130 ;;
      TERM) backup_status=143 ;;
    esac
    # backup.sh owns and drains its actual foreground writer before it exits.
    # This owner waits for that direct shell, so no dump/uploader/result writer
    # can reopen the directory after cleanup. Repeats are ignored while drain
    # runs. Cancellation travels over the original child's private channel.
    trap '' HUP INT TERM
    if [ -n "$backup_pid" ]; then
      owned_child_cancel 8
      owned_child_wait "$backup_control" 8 "$backup_pid" || true
      backup_pid=""
    fi
    cleanup_backup_dir
  }
  request_backup_shutdown() {
    local signal="$1"
    # A trap can run after the child has been forked but before `$!` is copied.
    # Keep that signal pending until the direct-child identity is recorded;
    # cleaning or signalling in that handoff window would reintroduce the
    # leader/descendant race this owner model removes.
    if [ "$backup_starting" = 1 ]; then
      [ -n "$backup_pending_signal" ] || backup_pending_signal="$signal"
      return
    fi
    stop_backup_and_cleanup "$signal"
  }
  trap cleanup_backup_dir_exit EXIT
  trap 'request_backup_shutdown HUP' HUP
  trap 'request_backup_shutdown INT' INT
  trap 'request_backup_shutdown TERM' TERM
  # Install the owner before allocation. An allocation/setup failure and an
  # explicit fatal both run EXIT cleanup; an empty path is deliberately a no-op.
  if ! backup_dump_dir="$(mktemp -d)"; then
    restore_backup_traps
    echo "FATAL: could not allocate a private backup directory." >&2
    return 1
  fi
  # `backup_starting` is the owner-visible admission state, not a best-effort
  # preflight flag.  A signal observed before the child start is rejected here;
  # one observed after this boundary stays pending until `$!` is recorded and
  # is then drained below.
  if [ -n "$backup_pending_signal" ]; then
    backup_starting=0
    request_backup_shutdown "$backup_pending_signal"
  fi
  if [ -n "$backup_shutdown_status" ]; then
    restore_backup_traps
    case "$backup_shutdown_status" in
      HUP) return 129 ;;
      INT) return 130 ;;
      TERM) return 143 ;;
    esac
  fi
  owned_child_open "$backup_dump_dir/backup-control" 8 || fatal "could not open child cancellation channel."
  backup_control="$backup_dump_dir/backup-control"
  BACKUP_DIR="$backup_dump_dir" owned_child_run "$backup_control" 8 cooperative 0 bash "$ROOT/scripts/backup.sh" &
  backup_pid=$!
  backup_starting=0
  if [ -n "$backup_pending_signal" ]; then
    stop_backup_and_cleanup "$backup_pending_signal"
  fi
  if [ -n "$backup_shutdown_status" ]; then
    restore_backup_traps
    case "$backup_shutdown_status" in
      HUP) return 129 ;;
      INT) return 130 ;;
      TERM) return 143 ;;
    esac
  fi
  if owned_child_wait "$backup_control" 8 "$backup_pid"; then
    backup_status=0
  else
    backup_status=$?
  fi
  case "$backup_shutdown_status" in
    HUP) backup_status=129 ;;
    INT) backup_status=130 ;;
    TERM) backup_status=143 ;;
  esac
  backup_pid=""
  cleanup_backup_dir || exit 125
  restore_backup_traps
  return "$backup_status"
}

logical_backups_enabled() {
  backup_enabled && pre_apply_backup_enabled
}

run_mandatory_pre_apply_backup() {
  if ! backup_s3_configured; then
    echo "FATAL: Logical backups are enabled but BACKUP_S3_BUCKET and BACKUP_S3_* credentials are not configured." >&2
    return 1
  fi
  echo "Taking a required pre-apply backup to s3://${BACKUP_S3_BUCKET} ..."
  run_backup
}

run_required_target_snapshot() {
  if ! backup_s3_configured; then
    echo "FATAL: restore requires an off-site target snapshot: configure BACKUP_S3_BUCKET and BACKUP_S3_* credentials." >&2
    return 1
  fi
  snapshot_result_file=""
  previous_snapshot_traps="$(trap -p EXIT HUP INT TERM || true)"
  previous_snapshot_exit_trap="$(trap -p EXIT || true)"
  restore_snapshot_traps() {
    trap - EXIT HUP INT TERM
    eval "$previous_snapshot_traps"
  }
  cleanup_snapshot_result() { [ -z "$snapshot_result_file" ] || rm -f "$snapshot_result_file"; }
  cleanup_snapshot_result_exit() {
    trap '' HUP INT TERM
    cleanup_snapshot_result || true
    run_previous_exit_trap "$previous_snapshot_exit_trap"
  }
  trap cleanup_snapshot_result_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The result owner exists before allocation, so a failed allocation or a
  # nested explicit exit cannot retain a result artifact.
  if ! snapshot_result_file="$(mktemp)"; then
    restore_snapshot_traps
    echo "FATAL: could not allocate a target snapshot result file." >&2
    return 1
  fi
  # Backup output is operational logging. Keep the snapshot in this owner shell
  # so cancellation reaches run_backup; command substitution would hide its child.
  if BACKUP_REQUIRED=1 BACKUP_RESULT_FILE="$snapshot_result_file" run_backup >&2; then
    :
  else
    local snapshot_backup_status=$?
    case "$snapshot_backup_status" in
      129 | 130 | 143)
        exit "$snapshot_backup_status"
        ;;
    esac
    cleanup_snapshot_result
    restore_snapshot_traps
    echo "FATAL: target snapshot failed; restore will not mutate this database." >&2
    return 1
  fi
  local snapshot
  snapshot="$(node -e '
    const fs = require("node:fs"); const crypto = require("node:crypto");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!value.key || !value.eTag || !value.bucket || !value.region) process.exit(2);
    process.stdout.write(crypto.createHash("sha256").update(`${value.key}\\n${value.eTag}\\n${value.versionId ?? ""}\\n${value.bucket}\\n${value.endpoint ?? ""}\\n${value.region}`).digest("hex"));
  ' "$snapshot_result_file")" || {
    cleanup_snapshot_result
    restore_snapshot_traps
    echo "FATAL: target snapshot upload did not return immutable object identity." >&2
    return 1
  }
  cleanup_snapshot_result
  restore_snapshot_traps
  REQUIRED_TARGET_SNAPSHOT="$snapshot"
}

assert_dangerous_backup_policy() {
  if logical_backups_enabled; then
    run_mandatory_pre_apply_backup || return 1
    return 0
  fi
  if [ "${APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP:-}" != "I_ACCEPT_PROVIDER_BACKUP_ONLY" ]; then
    cat >&2 <<EOF
FATAL: APPLY_SCHEMA=dangerous with logical backups disabled requires explicit acknowledgment.

When BACKUP_ENABLED=false or BACKUP_PRE_APPLY_ENABLED=false, destructive schema
deploys rely on provider snapshots/PITR only — not pg_dump uploads.

  Set APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP=I_ACCEPT_PROVIDER_BACKUP_ONLY
  for this deploy only, then unset it after schema sync completes.

See patterns/backup-and-restore.md (Provider-only profile).
EOF
    return 1
  fi
    # destructive:audited — explanatory text only; this does not invoke Prisma.
    echo "WARNING: APPLY_SCHEMA=dangerous without logical pre-apply backup." >&2
  echo "         Provider snapshot/PITR is the rollback path for this deploy." >&2
}

maybe_pre_apply_backup() {
  if ! pre_apply_backup_enabled; then
    echo "WARNING: BACKUP_PRE_APPLY_ENABLED=false — skipping pre-apply backup." >&2
    return 0
  fi
  if ! backup_enabled; then
    echo "WARNING: BACKUP_ENABLED=false — skipping pre-apply backup." >&2
    return 0
  fi
  if ! backup_s3_configured; then
    # WARN, DO NOT FATAL. `safe` refuses destructive SQL in the plan, so the
    # snapshot is defence in depth here rather than the rollback path it is
    # for `dangerous` (see assert_dangerous_backup_policy, which still
    # hard-fails).
    # Failing here bricked the first deploy of a brand-new, empty database until
    # backup storage existed, and pointed the operator at turning a safety
    # toggle off — which then also silences the warning below on every later
    # deploy, when there IS data to lose.
    cat >&2 <<EOF

================================================================
 WARNING: no pre-apply backup was taken.

 BACKUP_PRE_APPLY_ENABLED=true, but BACKUP_S3_BUCKET and the
 BACKUP_S3_* credentials are not configured, so there is no
 logical dump of this database from immediately before the
 schema change about to be applied.

 # destructive:audited — explanatory error text only.
 APPLY_SCHEMA=safe continues anyway: it refuses destructive
 SQL in the plan, so a provider snapshot / PITR remains the
 rollback path.

 Configure the backup bucket before you rely on this database.
 See patterns/backup-and-restore.md.
================================================================

EOF
    return 0
  fi
  echo "Taking a pre-apply backup to s3://${BACKUP_S3_BUCKET} ..."
  run_backup || return 1
}

apply_schema() {
  require_database_url
  local apply_schema="${APPLY_SCHEMA:-off}"
  case "$apply_schema" in
    off)
      echo "APPLY_SCHEMA=off — nothing to apply."
      return 0
      ;;
    safe | dangerous) ;;
    *)
      fatal "APPLY_SCHEMA=$apply_schema is invalid. Use off, safe, or dangerous."
      ;;
  esac

  if restore_vars_present; then
    fatal "restore-only variables are set. Apply and restore are mutually exclusive; unset every RESTORE_* variable."
  fi

  # Ordinary apply has one advisory/DDL session, including its atomic receipt.
  exec node "$ROOT/scripts/apply-schema.mjs"
}

restore_vars_present() {
  [ -n "${RESTORE_BACKUP_S3_KEY:-}" ] || [ -n "${RESTORE_BACKUP_S3_ETAG:-}" ] || \
    [ -n "${RESTORE_BACKUP_S3_VERSION_ID:-}" ] || [ -n "${RESTORE_CONFIRM:-}" ] || \
    [ -n "${RESTORE_CONFIRM_NONCE:-}" ] || [ -n "${RESTORE_ALLOW_ACTIVE_CONNECTIONS:-}" ] || \
    [ -n "${RESTORE_TARGET_MODE:-}" ]
}

validate_nonce() {
  if ! [[ "$1" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
    fatal "destructive confirmation requires a fresh 8-128 character nonce (letters, numbers, _ or -)."
  fi
}

# Refuse other destination connections before either restore mode. Replacement
# inspection clients must disconnect; in-place runtimes and other writers must
# drain. The separate database timeout bounds conflicting object-lock waits.
assert_no_other_connections() {
  # Everything below names the database, so it has to exist. PGDATABASE is
  # parsed out of DATABASE_URL's path; a URL with no /<database> leaves it
  # unset, which under `set -u` would abort with a bare "unbound variable" a few
  # lines down instead of telling anyone what is wrong.
  if [ -z "${PGDATABASE:-}" ]; then
    echo "FATAL: DATABASE_URL does not name a database." >&2
    echo "       It must end with /<database-name>, for example:" >&2
    echo "         <database connection URL>" >&2
    echo "       Fix DATABASE_URL on this job; verify the destination with" >&2
    echo "       read-only queries before retrying." >&2
    fatal "restore target must name a database."
  fi
  if ! [[ "${DB_APPLIER_LOCK_PID:-}" =~ ^[0-9]+$ ]]; then
    fatal "restore is missing its owning advisory-lock backend PID; refusing to guess which connection is safe to ignore."
  fi
  local others
  others="$(
    db_query -A -t -c \
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND NOT (pid = ${DB_APPLIER_LOCK_PID} AND application_name = 'starter-db-applier-lock');"
  )" || fatal "could not query pg_stat_activity to check for live connections to $PGDATABASE."
  others="$(printf '%s' "$others" | tr -d '[:space:]')"
  [[ "$others" =~ ^[0-9]+$ ]] || fatal "could not interpret the target connection count."
  if [ "$others" = "0" ]; then
    return 0
  fi
  # The override names the database, so a value left lying around cannot
  # authorize a restore over a different one (same reasoning as RESTORE_CONFIRM).
  if [ "${RESTORE_ALLOW_ACTIVE_CONNECTIONS:-}" = "$PGDATABASE" ]; then
    echo "WARNING: $others other connection(s) to $PGDATABASE — proceeding because RESTORE_ALLOW_ACTIVE_CONNECTIONS names this database." >&2
    return 0
  fi
  cat >&2 <<EOF
FATAL: $others other connection(s) are still using the database "$PGDATABASE".

Restore requires its destination connections to be drained.

  1. For an empty replacement, disconnect inspection clients from this target;
     the original deployment can keep using its original database during preparation.
     For in-place recovery, stop and drain every app, worker, schema job, backup
     runner, and other writer in the recovery handoff inventory.
  2. After this job exits, remove every RESTORE_* variable, correct the refusal,
     and preview and confirm again with a fresh nonce. Verify the destination
     with read-only queries first: this refusal happened before any mutation.
  3. After restore succeeds, complete the recovery handoff below. Restore does
     not publish a schema receipt: run the selected release's ordinary guarded
     apply before its matching followers. Move/redeploy every database consumer
     and verify runtime, data, destination backups, schedules, and monitoring
     before completing recovery.

If those connections are something you cannot stop (a connection pooler, your
provider's own monitoring) and you are certain nothing is writing, set:

  RESTORE_ALLOW_ACTIVE_CONNECTIONS=$PGDATABASE

This overrides only the connection check, not target validation or recovery handoff.
Complete recipe: patterns/backup-and-restore.md#replacement-database-recovery-handoff
EOF
  fatal "restore refused before mutation."
}

assert_empty_restore_target() {
  # Check all application-owned catalogs, not just tables. A sequence, enum,
  # function, extra schema, or extension means this is not a fresh destination.
  # starter_control holds this destination's own schema receipts and is never
  # restored over.
  local occupied
  occupied="$(db_query -A -t <<'SQL'
SELECT EXISTS (
  SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema', 'starter_control') AND nspname !~ '^pg_'
  UNION ALL
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'
);
SQL
)" || fatal "could not validate the empty restore destination."
  occupied="$(printf '%s' "$occupied" | tr -d '[:space:]')"
  [ "$occupied" = f ] || fatal "empty-target restore requires a new empty database. Create a separate destination and point only this restore job at it. No application data was changed."
}

restore_backup() {
  require_database_url
  local key="${RESTORE_BACKUP_S3_KEY:-}"
  local confirm="${RESTORE_CONFIRM:-}"
  if [ -z "$key" ]; then
    fatal "restore requires RESTORE_BACKUP_S3_KEY. An exact source ETag is also required."
  fi
  if [ "${APPLY_SCHEMA:-off}" != "off" ]; then
    fatal "APPLY_SCHEMA=${APPLY_SCHEMA} is set. Restore and apply are mutually exclusive. Set APPLY_SCHEMA=off."
  fi
  if ! backup_s3_configured; then
    fatal "restore requires BACKUP_S3_BUCKET and BACKUP_S3_* credentials."
  fi

  if [ "${DB_APPLIER_LOCK_HELD:-}" != "1" ]; then
    with_schema_lock restore
    return
  fi
  restore_backup_locked "$key" "$confirm"
}

download_restore_source() {
  local dump="$1" key="$2"
  run_restore_writer bounded_client 0 node "$ROOT/scripts/download-backup-from-s3.mjs" "$dump" "$key" || return $?
  run_restore_writer bounded_client 120000 pg_restore --list "$dump" >/dev/null || return $?
  RESTORE_SOURCE_IDENTITY="$(node -e '
    const fs = require("node:fs"); const crypto = require("node:crypto");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!value.key || !value.eTag || !value.bucket || !value.region) process.exit(2);
    process.stdout.write(crypto.createHash("sha256").update(`${value.key}\\n${value.eTag}\\n${value.versionId ?? ""}\\n${value.bucket}\\n${value.endpoint ?? ""}\\n${value.region}`).digest("hex"));
  ' "${dump}.identity.json")" || return $?
}

restore_backup_locked() {
  local key="$1" confirm="$2"
  local target_mode="${RESTORE_TARGET_MODE:-empty-target}" confirm_kind=RESTORE
  case "$target_mode" in
    empty-target) ;;
    in-place) confirm_kind=RESTORE-IN-PLACE ;;
    *) fatal "RESTORE_TARGET_MODE must be empty-target or in-place." ;;
  esac
  load_pg_env
  local target
  target="$(target_identity)"

  banner "RESTORING database from s3://$BACKUP_S3_BUCKET/$key"
  if [ "$target_mode" = in-place ]; then
    echo "IN-PLACE restore replaces the destination public schema. Stop and drain all writers, schema jobs, and backup runners first."
  else
    echo "Restoring into a new empty destination. The existing application's database is preserved."
  fi
  echo "See patterns/backup-and-restore.md."

  restore_source_dir=""
  restore_writer_pid="" restore_writer_control="" restore_writer_starting=0 restore_writer_pending_signal="" restore_shutdown_signal=""
  restore_cleanup_started=0
  cleanup_restore_source() {
    if [ "$restore_cleanup_started" != 0 ]; then [ -z "$restore_writer_control" ] || exit 125; return 0; fi
    restore_cleanup_started=1
    trap '' HUP INT TERM
    if [ -n "$restore_writer_pid" ]; then
      owned_child_cancel 9
      owned_child_wait "$restore_writer_control" 9 "$restore_writer_pid" || true
      restore_writer_pid=""
    fi
    if [ -n "$restore_writer_control" ] && [ ! -f "$restore_writer_control.drained" ]; then exit 125; fi
    restore_writer_control=""
    [ -z "$restore_source_dir" ] || rm -rf "$restore_source_dir" || true
  }
  run_restore_writer() {
    # Start ownership before inspecting shutdown.  A signal already delivered
    # at helper entry is rejected without a fork; one delivered after this
    # admission boundary remains pending until `$!` is recorded and is then
    # drained by the same source-directory owner.
    restore_writer_starting=1
    if [ -n "$restore_shutdown_signal" ]; then
      restore_writer_starting=0
      case "$restore_shutdown_signal" in
        HUP) return 129 ;;
        INT) return 130 ;;
        TERM) return 143 ;;
      esac
    fi
    # Avoid nesting a second native supervisor. Archive helpers own their own
    # bounded native client, so their outer supervisor allows that drain to end.
    local timeout=0 child_mode=native
    if [ "$1" = bounded_client ]; then
      shift
      timeout="$1"; shift
    elif [ "$1" = node ] && [ "$2" = "$ROOT/scripts/lib/bounded-child.mjs" ]; then
      shift 2
      timeout="$1"; shift
    elif [ "$1" = node ] && [ "$2" = "$ROOT/scripts/restore-archive.mjs" ]; then
      child_mode=cooperative
    fi
    owned_child_open "$restore_source_dir/writer-control" 9 || fatal "could not open child cancellation channel."
    restore_writer_control="$restore_source_dir/writer-control"
    owned_child_run "$restore_writer_control" 9 "$child_mode" "$timeout" "$@" <&0 &
    restore_writer_pid=$!
    restore_writer_starting=0
    if [ -n "$restore_writer_pending_signal" ]; then
      shutdown_restore_source "$restore_writer_pending_signal"
    fi
    local status=0
    if owned_child_wait "$restore_writer_control" 9 "$restore_writer_pid"; then
      status=0
    else
      status=$?
    fi
    restore_writer_pid=""
    if [ ! -f "$restore_writer_control.drained" ]; then exit 125; fi
    local drained_control="$restore_writer_control"
    restore_writer_control=""
    owned_child_clear "$drained_control"
    return "$status"
  }
  shutdown_restore_source() {
    local signal="$1"
    if [ "$restore_writer_starting" = 1 ]; then
      [ -n "$restore_writer_pending_signal" ] || restore_writer_pending_signal="$signal"
      return
    fi
    [ -z "$restore_shutdown_signal" ] || return
    restore_shutdown_signal="$signal"
    # The supervisor bounds native-client drain. No shell PID is signal
    # authority; a drained writer leaves the server as the outcome authority.
    trap '' HUP INT TERM
    if [ -n "$restore_writer_pid" ]; then
      owned_child_cancel 9
      owned_child_wait "$restore_writer_control" 9 "$restore_writer_pid" || true
      restore_writer_pid=""
    fi
    case "$signal" in
      HUP) exit 129 ;;
      INT) exit 130 ;;
      TERM) exit 143 ;;
    esac
  }
  # This artifact-owning invocation runs the source download, target snapshot,
  # and restore in the foreground. Its EXIT trap owns the source directory even
  # when a helper calls `fatal`/`exit`; a command-substitution child used for
  # the target snapshot cannot own or clean this parent artifact.
  trap cleanup_restore_source EXIT
  trap 'shutdown_restore_source HUP' HUP
  trap 'shutdown_restore_source INT' INT
  trap 'shutdown_restore_source TERM' TERM
  restore_source_dir="$(mktemp -d)" || fatal "could not allocate a private restore source directory."
  local dump="$restore_source_dir/restore.dump"
  local source_identity
  if [ -z "$confirm" ]; then
    if ! download_restore_source "$dump" "$key"; then
      cleanup_restore_source
      trap - EXIT HUP INT TERM
      fatal "could not validate the immutable restore source for preview."
    fi
    source_identity="$RESTORE_SOURCE_IDENTITY"
    cat <<EOF
Restore plan (no mutation was attempted):
  target-id: $target
  target-mode: $target_mode
  source-sha256: $source_identity
Set RESTORE_CONFIRM_NONCE to a fresh nonce, then set:
  RESTORE_CONFIRM=$confirm_kind:$target:$source_identity:<fresh-nonce>
and re-run this one-shot restore job. The conditional source download will be
repeated before the target snapshot and destructive boundary.
EOF
    cleanup_restore_source
    trap - EXIT HUP INT TERM
    return 0
  fi
  local nonce="${RESTORE_CONFIRM_NONCE:-}"
  validate_nonce "$nonce"
  if ! download_restore_source "$dump" "$key"; then
    cleanup_restore_source
    trap - EXIT HUP INT TERM
    fatal "could not revalidate the immutable source before the destructive boundary."
  fi
  source_identity="$RESTORE_SOURCE_IDENTITY"
  local expected="$confirm_kind:$target:$source_identity:$nonce"
  if [ "$confirm" != "$expected" ]; then
    cat >&2 <<EOF
FATAL: RESTORE_CONFIRM does not bind this target and immutable source.
  target-id: $target
  source-sha256: $source_identity
RESTORE_CONFIRM must be $confirm_kind:<target-id>:<source-sha256>:<fresh-nonce>.
EOF
    cleanup_restore_source
    trap - EXIT HUP INT TERM
    exit 1
  fi
  # Render and validate before the destructive boundary. Unknown archive
  # format cannot reach the target. Body and COPY data are never rewritten.
  if ! run_restore_writer node "$ROOT/scripts/restore-archive.mjs" prepare "$dump" "$restore_source_dir/restore.sql"; then
    fatal "could not prepare a bounded restore script; no application mutation was attempted."
  fi
  assert_no_other_connections
  local snapshot_identity=""
  if [ "$target_mode" = empty-target ]; then
    assert_empty_restore_target
  else
    # Only replacement has existing data to snapshot. Check connections first
    # so a refused operation need not take a target dump.
    if ! run_required_target_snapshot; then
      cleanup_restore_source
      trap - EXIT HUP INT TERM
      fatal "required target snapshot failed before restore mutation."
    fi
    snapshot_identity="$REQUIRED_TARGET_SNAPSHOT"
    assert_no_other_connections
  fi

  if [ "$target_mode" = in-place ]; then
  echo "Replacing schema public for the explicitly approved in-place restore..."
  # lock_timeout, like apply mode: if something DOES hold a conflicting lock
  # despite the check above, fail in a minute with an error you can read instead
  # of hanging forever under the banner with no further output.
  if ! PGCONNECT_TIMEOUT=10 PGOPTIONS="-c lock_timeout=5s -c statement_timeout=60s" run_restore_writer node "$ROOT/scripts/lib/bounded-child.mjs" 75000 psql -X -q -v ON_ERROR_STOP=1 <<EOF
SET lock_timeout = '5s';
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
EOF
  then
    cleanup_restore_source
    trap - EXIT HUP INT TERM
    fatal "restore could not establish an empty target; the destination state is unknown. Inspect it with read-only queries before any retry."
  fi
  fi

  if ! run_restore_writer node "$ROOT/scripts/restore-archive.mjs" apply "$restore_source_dir/restore.sql"; then
    echo "FATAL: pg_restore failed in $target_mode mode." >&2
    echo "       Outcome is unknown. Do not start server or worker, and do not rerun" >&2
    echo "       until the destination has been inspected with read-only queries" >&2
    echo "       and, where needed, rebuilt from a fresh empty target." >&2
    cleanup_restore_source
    trap - EXIT HUP INT TERM
    exit 1
  fi
  cleanup_restore_source
  trap - EXIT HUP INT TERM
  echo "Restore complete."
  echo "Data restore only: no schema receipt was published; recovery handoff is still required."
  echo "Remove every RESTORE_* variable and the restore command/mode before reusing this job."
  echo "Validate records with read-only database queries before starting any app or worker."
  echo "During maintenance, stop and drain old writers; repoint every app, worker, schema applier, backup schedule, and monitoring consumer."
  echo "Redeploy affected services/jobs after updating environment references; existing containers retain their old settings."
  echo "Run the selected release's ordinary guarded apply on the destination before its matching followers."
  echo "Starting an app leader or embedded runtime can immediately run jobs; reconcile the queue and external effects first."
  echo "Verify runtime readiness, restored data, a new backup of this destination, and its backup schedule/monitoring before completing recovery."
  if [ "$target_mode" = empty-target ]; then
    echo "Keep the original database intact; returning after replacement writes requires reconciliation."
  fi
  echo "Complete recipe: patterns/backup-and-restore.md#replacement-database-recovery-handoff"
}

# Test-only library mode exposes the orchestration helpers to an inert shell
# harness. It never reaches a mode handler or a database client by itself.
if [ "${DB_APPLIER_LIBRARY_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ "$MODE" != "restore" ] && restore_vars_present; then
  fatal "restore-only variables are set but mode '$MODE' is not restore. Unset every RESTORE_* variable."
fi

case "$MODE" in
  backup)
    banner "DB applier mode=backup"
    # Not configured yet is not a failure. The documented first deploy leaves the
    # BACKUP_S3_* prompts blank, so this scheduled job would otherwise fail every
    # night from day one — and a nightly red cron nobody can fix by fixing
    # anything trains people to ignore it. The worker still registers the
    # freshness check when BACKUP_ENABLED=true even without a bucket yet — it
    # reports setup-missing and alerts like any other attention state
    # (apps/worker/src/index.ts, handlers/check-backup-freshness.ts). Apply mode
    # stays strict: APPLY_SCHEMA=dangerous still refuses to run without a pre-apply dump.
    if backup_enabled && ! backup_s3_configured; then
      cat >&2 <<EOF

================================================================
 SKIPPED: no backup was taken — the backup bucket is not set up.

 This job dumps the database and uploads it off-site, and there
 is nowhere to upload it to yet. Nothing failed; nothing was
 backed up either.

 To turn backups on, set these on the *server* service (this job
 and the worker read them from there):

   BACKUP_S3_BUCKET
   BACKUP_S3_ACCESS_KEY_ID
   BACKUP_S3_SECRET_ACCESS_KEY
   BACKUP_S3_ENDPOINT          (only for R2 / B2 / MinIO)

 If you are relying on your provider's own snapshots instead,
 set BACKUP_ENABLED=false in the backup-defaults environment
 group and delete this scheduled job.

 See patterns/backup-and-restore.md.
================================================================

EOF
      exit 0
    fi
    run_backup
    ;;
  apply)
    apply_schema
    ;;
  restore)
    restore_backup
    ;;
  *)
    fatal "unknown mode '$MODE'. Use backup, apply, or restore."
    ;;
esac
