#!/usr/bin/env bash
# Entrypoint for Dockerfile.db-applier only.
#
# Mode = first argument, else DB_APPLIER_MODE, else `backup`.
#
# 1. `restore` runs a one-shot restore and exits. It requires the mode to be
#    literally `restore` and RESTORE_BACKUP_S3_KEY. A first invocation without
#    RESTORE_CONFIRM is the non-mutating source/target planning step.
#    Restore additionally requires an exact source ETag and a target-bound,
#    nonce-bound confirmation after source validation.
#    Restore variables present in ANY other mode are a fatal error, so a
#    leftover restore key — on this job, or inherited from anywhere else —
#    cannot turn the nightly `backup` cron into a database replacement. Set the
#    restore variables on the one-shot restore job ONLY: never on the server or
#    worker services, and never in a shared environment group. Never mount this
#    entrypoint on the web or worker images — see patterns/backup-and-restore.md.
# 2. `schedule` runs cron in the foreground (BACKUP_CRON required). Use when the
#    platform has no native cron — platforms with cron should invoke `backup`
#    mode on a schedule instead (see patterns/backup-and-restore.md).
# 3. Otherwise delegate to scripts/db-applier.sh with the mode.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/backup-env.sh
source "$ROOT/scripts/lib/backup-env.sh"

ENV_FILE=/app/db-applier.env

validate_schedule_config() {
  if ! gosu node bash -c "
    set -a
    source '$ENV_FILE'
    set +a
    source '$ROOT/scripts/lib/backup-env.sh'
    backup_enabled || exit 1
    backup_s3_configured || exit 1
    [ -n \"\${DATABASE_URL:-}\" ] || exit 1
  "; then
    echo "FATAL: schedule mode configuration is incomplete after writing $ENV_FILE." >&2
    echo "       Check DATABASE_URL, BACKUP_ENABLED, and BACKUP_S3_*." >&2
    exit 1
  fi
}

# Exactly five whitespace-separated fields on a single line. This is a shape
# check, not a cron parser: it catches the mistakes people actually make (a
# 6-field "seconds" expression copied from another scheduler, a stray newline
# from a pasted dashboard value, an empty or one-word value).
backup_cron_help() {
  echo "       Expected: <minute> <hour> <day-of-month> <month> <day-of-week>" >&2
  echo "       For example, 3am every day:  BACKUP_CRON='0 3 * * *'" >&2
  echo "       No seconds field, and all five on one line." >&2
}

validate_backup_cron() {
  local cron="${BACKUP_CRON:-}"
  local fields
  if [ "$cron" != "${cron%%$'\n'*}" ]; then
    echo "FATAL: BACKUP_CRON contains a newline." >&2
    backup_cron_help
    exit 1
  fi
  # `read -a` splits on IFS but does NOT glob, so the `*` fields stay literal
  # (plain word splitting would expand them against the working directory).
  local -a parts=()
  read -r -a parts <<<"$cron"
  fields=${#parts[@]}
  if [ "$fields" -ne 5 ]; then
    echo "FATAL: BACKUP_CRON must have exactly 5 fields, but it has $fields ('$cron')." >&2
    backup_cron_help
    exit 1
  fi
}

run_schedule() {
  if ! backup_enabled; then
    echo "FATAL: BACKUP_ENABLED=false — schedule mode requires logical backups." >&2
    echo "       Remove the schedule service or set BACKUP_ENABLED=true." >&2
    echo "       For provider-only recovery, see patterns/backup-and-restore.md" >&2
    echo "       (Provider-only profile) and skip db-applier entirely." >&2
    exit 1
  fi

  if [ -z "${BACKUP_CRON:-}" ]; then
    echo "FATAL: DB_APPLIER_MODE=schedule requires BACKUP_CRON (5-field cron expression)." >&2
    exit 1
  fi

  # BACKUP_CRON is interpolated into /etc/cron.d below, where a newline would
  # append an extra crontab line and a wrong field count would make cron reject
  # (or misread) the whole file — either way the nightly dump silently never
  # runs. Check the shape here and say what it should look like.
  validate_backup_cron

  if ! backup_s3_configured; then
    echo "FATAL: scheduled backups require BACKUP_S3_BUCKET and BACKUP_S3_* credentials." >&2
    exit 1
  fi

  node "$ROOT/scripts/write-db-applier-env.mjs" "$ENV_FILE"
  chown node:node "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  validate_schedule_config

  echo "Starting backup scheduler (BACKUP_CRON=$BACKUP_CRON) ..."
  cat >/etc/cron.d/db-applier-backup <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${BACKUP_CRON} root gosu node bash -c 'set -a; source ${ENV_FILE}; set +a; cd /app && ./scripts/db-applier.sh backup' >> /var/log/db-applier-backup.log 2>&1
EOF
  chmod 0644 /etc/cron.d/db-applier-backup
  touch /var/log/db-applier-backup.log
  chown node:node /var/log/db-applier-backup.log
  # cron writes each run to the log file, so nothing would reach the container's
  # stdout and a failing nightly dump would be invisible in any platform log
  # viewer. Tail the same file in the background (inherited by `exec cron -f`,
  # which keeps this PID) so the log stream carries every run as well.
  tail -F /var/log/db-applier-backup.log &
  exec cron -f
}

MODE="${1:-${DB_APPLIER_MODE:-backup}}"

restore_vars_present() {
  [ -n "${RESTORE_BACKUP_S3_KEY:-}" ] || [ -n "${RESTORE_BACKUP_S3_ETAG:-}" ] || \
    [ -n "${RESTORE_BACKUP_S3_VERSION_ID:-}" ] || [ -n "${RESTORE_CONFIRM:-}" ] || \
    [ -n "${RESTORE_CONFIRM_NONCE:-}" ] || [ -n "${RESTORE_ALLOW_ACTIVE_CONNECTIONS:-}" ] || \
    [ -n "${RESTORE_TARGET_MODE:-}" ]
}

# Restore never fires implicitly. The mode must say `restore`; otherwise any
# restore variable in the environment is a configuration error, not a trigger.
if [ "$MODE" != "restore" ] && restore_vars_present; then
  echo "FATAL: restore-only variables are set but the mode is '$MODE'." >&2
  echo "       Restore only runs when the mode is explicitly 'restore' (argument or" >&2
  echo "       DB_APPLIER_MODE=restore) on a one-shot job. A leftover restore key must" >&2
  echo "       never turn a backup or apply run into a database replacement." >&2
  echo "       Unset all RESTORE_* variables on this service, then re-run." >&2
  exit 1
fi

case "$MODE" in
  restore)
    if [ -z "${RESTORE_BACKUP_S3_KEY:-}" ]; then
      echo "FATAL: restore requires RESTORE_BACKUP_S3_KEY and an exact source ETag." >&2
      echo "       The first one-shot invocation prints the target/source-bound" >&2
      echo "       confirmation for the follow-up mutation run." >&2
      exit 1
    fi
    exec gosu node "$ROOT/scripts/db-applier.sh" restore
    ;;
  schedule)
    run_schedule
    ;;
  *)
    exec gosu node "$ROOT/scripts/db-applier.sh" "$MODE"
    ;;
esac
