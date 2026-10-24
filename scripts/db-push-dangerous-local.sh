#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/assert-local-database.sh" db:push:dangerous
prisma db push --accept-data-loss
