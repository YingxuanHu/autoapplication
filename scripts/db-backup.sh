#!/usr/bin/env bash
# Daily pg_dump snapshot + 14-day retention. Runs from launchd on macOS.
#
#   Install once:
#     scripts/db-backup.sh install
#   Run manually:
#     scripts/db-backup.sh
#   Uninstall:
#     scripts/db-backup.sh uninstall

set -euo pipefail

cd "$(dirname "$0")/.."

PLIST_LABEL="dev.autoapplication.db-backup"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

if [[ "${1:-}" == "install" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd $(pwd) && scripts/db-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$HOME/.pgbackups/backup.log</string>
  <key>StandardErrorPath</key><string>$HOME/.pgbackups/backup.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "✓ Installed. Will run daily at 03:00. Logs: ~/.pgbackups/backup.log"
  exit 0
fi

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "✓ Uninstalled."
  exit 0
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DB_URL="${DATABASE_URL:?DATABASE_URL not set}"
DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"
DIR="$HOME/.pgbackups/$DB_NAME"
mkdir -p "$DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DIR/auto-$STAMP.dump"

echo "[$(date)] dumping $DB_NAME → $FILE"
pg_dump "$DB_URL" -Fc -f "$FILE"
echo "[$(date)] done ($(du -h "$FILE" | cut -f1))"

# Retain 14 days of auto- snapshots; never delete manual ones (post-*, pre-reset-*).
find "$DIR" -name 'auto-*.dump' -mtime +14 -print -delete
