#!/usr/bin/env bash
# Shared backup toggles for backup.sh and db-applier.sh.
# shellcheck shell=bash

_backup_env_truthy() {
  case "${1:-}" in
    true | 1 | yes | on | TRUE | YES | ON) return 0 ;;
    false | 0 | no | off | FALSE | NO | OFF | "") return 1 ;;
    *)
      echo "FATAL: invalid boolean value '$1' (use true or false)." >&2
      exit 1
      ;;
  esac
}

# BACKUP_ENABLED defaults to true. When false, scheduled and manual backups no-op
# with a warning; pre-apply backups are also skipped unless overridden below.
backup_enabled() {
  _backup_env_truthy "${BACKUP_ENABLED:-true}"
}

# BACKUP_PRE_APPLY_ENABLED defaults to true. When false, APPLY_SCHEMA runs skip
# the pg_dump before prisma db push and log a warning.
pre_apply_backup_enabled() {
  _backup_env_truthy "${BACKUP_PRE_APPLY_ENABLED:-true}"
}

backup_s3_configured() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] \
    && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] \
    && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]
}
