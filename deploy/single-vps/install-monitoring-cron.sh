#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/autoapplication}"
CRON_FILE="/etc/cron.d/applyoverflow-health"

cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

*/5 * * * * root APP_DIR=$APP_DIR bash $APP_DIR/deploy/single-vps/monitor-health.sh
# Repair the fixed index-tier manifest during the off-peak window. The policy
# refuses table moves and stops before the backup reserve is consumed.
35 4 * * * root APP_DIR=$APP_DIR bash $APP_DIR/deploy/single-vps/postgres-tablespace-policy.sh --apply >> /var/log/autoapplication/postgres-tablespace-policy.log 2>&1
EOF

chmod 0644 "$CRON_FILE"
echo "Installed $CRON_FILE"
