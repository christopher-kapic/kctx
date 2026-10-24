#!/usr/bin/env bash
# Positive allowlist for commands that can mutate a Postgres database.
#
# Usage:  bash scripts/assert-local-database.sh <COMMAND_NAME>
#         bash scripts/assert-local-database.sh --self-test
#   COMMAND_NAME is db:push | db:push:dangerous | db:seed | db:studio
#
# Allowed DATABASE_URL shape (all must match):
#   host     localhost | 127.0.0.1 | ::1 | host.docker.internal
#   port     $EXPECTED_PORT (default 5432; empty in the URL → 5432)
#   database $EXPECTED_DB   (default starter)
#
# Explicitly rejected: postgres, db, database, 10.*, 172.16–31.*, 192.168.* —
# those are the hostnames and ranges a VPC / Dokploy / compose-service Postgres
# actually uses.
#
# Renamed your local database or moved it off 5432? Export EXPECTED_DB /
# EXPECTED_PORT — the host allowlist above is the part that actually keeps this
# local, so those two are safe to change and are the right fix for a renamed
# local DB. They are read from the environment below.
#
# Escape hatch — only for a database you are willing to destroy (distinct per command):
#   ALLOW_NONLOCAL_DB_PUSH=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
#   ALLOW_NONLOCAL_DB_PUSH_DANGEROUS=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
#   ALLOW_NONLOCAL_DB_SEED=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
#   ALLOW_NONLOCAL_DB_STUDIO=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
# Generic override (same magic string): ASSERT_LOCAL_DB_ESCAPE=...

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-}"
ESCAPE_VALUE="I_UNDERSTAND_THIS_CAN_DESTROY_DATA"
EXPECTED_DB="${EXPECTED_DB:-starter}"
ALLOWED_HOSTS="localhost 127.0.0.1 ::1 host.docker.internal"
EXPECTED_PORT="${EXPECTED_PORT:-5432}"

# Read DATABASE_URL out of a .env file EXACTLY the way Prisma will read it.
#
# packages/db/prisma.config.ts loads the repo-root .env with dotenv, and dotenv
# is last-wins for a duplicated key. A guard that stopped at the FIRST
# `DATABASE_URL=` line would clear itself on a .env whose first entry is the
# local URL and whose last entry is a production one — and then Prisma would
# connect to production. Parsing with dotenv itself is the only way the two
# cannot drift; it also gives us dotenv's `export ` prefix and quoting rules
# for free.
read_dotenv_database_url() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    const [root, envFile] = process.argv.slice(1);
    let dotenv;
    try {
      dotenv = createRequire(path.join(root, "package.json"))("dotenv");
    } catch {
      process.stderr.write(
        "FATAL: cannot load dotenv from the repo root. Run `pnpm install` first.\n",
      );
      process.exit(2);
    }
    const parsed = dotenv.parse(fs.readFileSync(envFile));
    process.stdout.write(parsed.DATABASE_URL ?? "");
  ' "$1" "$2"
}

# -- self-test ---------------------------------------------------------------
# Wired into `pnpm verify` through the `policy:local-db-guard` script, so a
# regression in the parsing or the allowlist fails CI. Run it directly while
# working on either:
#   bash scripts/assert-local-database.sh --self-test
if [[ "$CMD" == "--self-test" ]]; then
  echo "== assert-local-database self-test =="
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  failed=0

  # dotenv is last-wins: a production URL appended below a local one must be the
  # value this guard judges, because it is the value Prisma will connect to.
  printf '%s\n' \
    'DATABASE_URL=postgresql://localhost:5432/starter' \
    'DATABASE_URL="postgresql://db.example.com:5432/prod"' \
    >"$tmp/dup.env"
  if [[ "$(read_dotenv_database_url "$ROOT" "$tmp/dup.env")" != "postgresql://db.example.com:5432/prod" ]]; then
    echo "self-test FAILED: duplicate DATABASE_URL did not resolve last-wins" >&2
    failed=1
  fi

  # dotenv accepts an `export ` prefix; so must this.
  printf '%s\n' 'export DATABASE_URL=postgresql://db.example.com:5432/prod' >"$tmp/export.env"
  if [[ "$(read_dotenv_database_url "$ROOT" "$tmp/export.env")" != "postgresql://db.example.com:5432/prod" ]]; then
    echo "self-test FAILED: 'export DATABASE_URL=' line was not parsed" >&2
    failed=1
  fi

  self_test_guard() {
    # $1 = DATABASE_URL, $2 = expected exit status, $3 = label, rest = extra env
    local url="$1" want="$2" label="$3"
    shift 3
    local got=0
    env -u ASSERT_LOCAL_DB_ESCAPE -u ALLOW_NONLOCAL_DB_PUSH -u EXPECTED_DB -u EXPECTED_PORT \
      DATABASE_URL="$url" "$@" bash "$ROOT/scripts/assert-local-database.sh" db:push >/dev/null 2>&1 || got=$?
    if [[ "$got" != "$want" ]]; then
      echo "self-test FAILED: $label (expected exit $want, got $got)" >&2
      failed=1
    fi
  }

  self_test_guard "postgresql://localhost:5432/starter" 0 "local URL accepted"
  self_test_guard "postgresql://db.example.com:5432/starter" 1 "remote host rejected"
  self_test_guard "postgresql://localhost:5432/prod" 1 "unexpected database name rejected"
  self_test_guard "postgresql://localhost:5432/myapp" 0 "EXPECTED_DB override accepted" EXPECTED_DB=myapp
  self_test_guard "postgresql://db.example.com:5432/myapp" 1 "EXPECTED_DB does not widen the host allowlist" EXPECTED_DB=myapp

  if [[ "$failed" -ne 0 ]]; then
    echo "assert-local-database self-test FAILED." >&2
    exit 1
  fi
  echo "assert-local-database self-test passed."
  exit 0
fi

if [[ -z "$CMD" ]]; then
  echo "FATAL: usage: $0 <COMMAND_NAME>" >&2
  echo "       COMMAND_NAME is db:push | db:push:dangerous | db:seed | db:studio" >&2
  exit 1
fi

CMD_KEY="$(printf '%s' "$CMD" | sed 's/[:.-]/_/g' | tr '[:lower:]' '[:upper:]')"
ESCAPE_VAR="ALLOW_NONLOCAL_${CMD_KEY}"

# Do not print DATABASE_URL. Load it from the repo-root .env only when unset
# so `pnpm db:push` keeps working for developers who never export it.
if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/.env" ]]; then
  DATABASE_URL="$(read_dotenv_database_url "$ROOT" "$ROOT/.env")" || exit 1
  export DATABASE_URL
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL is not set (and was not found in the repo-root .env)." >&2
  exit 1
fi

parsed="$(
  node -e '
    try {
      const url = new URL(process.env.DATABASE_URL);
      let host = url.hostname;
      if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
      const port = url.port || "5432";
      const db = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0].split("?")[0]);
      process.stdout.write([host, port, db].join("\n"));
    } catch {
      process.stderr.write("FATAL: DATABASE_URL is not a valid URL.\n");
      process.exit(2);
    }
  '
)" || {
  echo "FATAL: could not parse DATABASE_URL." >&2
  exit 1
}

HOST="$(printf '%s' "$parsed" | sed -n '1p')"
PORT="$(printf '%s' "$parsed" | sed -n '2p')"
DB="$(printf '%s' "$parsed" | sed -n '3p')"

allowed=0
for candidate in $ALLOWED_HOSTS; do
  if [[ "$HOST" == "$candidate" ]]; then
    allowed=1
    break
  fi
done

if [[ "$allowed" -eq 1 && "$PORT" == "$EXPECTED_PORT" && "$DB" == "$EXPECTED_DB" ]]; then
  exit 0
fi

eval "escape_val=\${${ESCAPE_VAR}:-}"
if [[ "$escape_val" == "$ESCAPE_VALUE" || "${ASSERT_LOCAL_DB_ESCAPE:-}" == "$ESCAPE_VALUE" ]]; then
  echo "WARNING: $CMD proceeding against host=$HOST port=$PORT db=$DB because an escape hatch is set." >&2
  exit 0
fi

cat >&2 <<EOF
FATAL: Refusing $CMD — DATABASE_URL does not look like your local database.

Parsed (credentials omitted): host=$HOST port=$PORT database=$DB
Expected: host in {localhost, 127.0.0.1, ::1, host.docker.internal}, port $EXPECTED_PORT, database $EXPECTED_DB

What to do:

  * If your local database has a different NAME (e.g. after a rebrand), export
    EXPECTED_DB=$DB and re-run. Put it in your shell profile to make it stick.
  * If your local Postgres listens on a different PORT, export EXPECTED_PORT=$PORT
    the same way.
  * If DATABASE_URL points at a shared, staging, or production database, that is
    what this guard is for. Do not change DATABASE_URL to push to it: use the
    expand-contract recipe in patterns/schema-changes-recipe.md and deploy the
    schema with APPLY_SCHEMA instead.

Last resort — only if that database is genuinely disposable and you accept
losing everything in it:

  $ESCAPE_VAR=$ESCAPE_VALUE pnpm $CMD
EOF
exit 1
