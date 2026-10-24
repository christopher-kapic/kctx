#!/usr/bin/env bash
# Print a short fingerprint of the Prisma schema files this image/repo would
# push. Dangerous apply combines this fingerprint with the canonical target,
# current live plan digest, and a fresh nonce; this value alone never confirms
# a destructive diff. See scripts/db-applier.sh and patterns/schema-push.md.
set -euo pipefail

# No pipeline descendants: both callers execute the same single Node reader.
exec node "${BASH_SOURCE[0]%/*}/lib/schema-fingerprint.mjs"
