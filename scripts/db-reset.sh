#!/usr/bin/env bash
# Guarded wrapper around `prisma migrate reset`.
#
# Why this exists: on 2026-04-17 at 01:21 a silent reset wiped ~225k jobs and
# the original user row. The proximate cause is unknown, but any path that
# reaches `prisma migrate reset` or `prisma db push --force-reset` must never
# be silent again.
#
# Usage:
#   scripts/db-reset.sh                 # prints what it would do, exits 1
#   CONFIRM_RESET=autoapplication scripts/db-reset.sh
#
# It also takes a timestamped pg_dump to ~/.pgbackups/<dbname>/ before
# running the reset, so even an intentional reset is recoverable.

set -euo pipefail

# Load .env so DATABASE_URL is populated the same way Prisma sees it.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: DATABASE_URL is not set (check .env)." >&2
  exit 1
fi

# Pull the database name out of the URL for the confirmation token.
DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"

if [[ "${CONFIRM_RESET:-}" != "$DB_NAME" ]]; then
  cat >&2 <<EOF
About to run: prisma migrate reset against "$DB_NAME"

This will DROP the database, re-apply all migrations, and run the seed.
All ingested data (jobs, sources, submissions, users) will be lost.

To proceed, re-run with:

  CONFIRM_RESET=$DB_NAME scripts/db-reset.sh

You will still get a pg_dump snapshot before the reset runs.
EOF
  exit 1
fi

BACKUP_DIR="$HOME/.pgbackups/$DB_NAME"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/pre-reset-$STAMP.dump"

echo "→ Snapshotting $DB_NAME to $BACKUP_FILE"
pg_dump "$DB_URL" -Fc -f "$BACKUP_FILE"
echo "→ Snapshot complete ($(du -h "$BACKUP_FILE" | cut -f1))"

echo "→ Running prisma migrate reset --force"
npx prisma migrate reset --force

echo "✓ Reset complete. Rollback with:"
echo "    pg_restore --clean --if-exists -d \"\$DATABASE_URL\" \"$BACKUP_FILE\""
