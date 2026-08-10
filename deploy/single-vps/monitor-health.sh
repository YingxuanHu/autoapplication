#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/autoapplication}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/single-vps/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-deploy/single-vps/.env.production}"
LOG_FILE="${MONITOR_LOG_FILE:-/var/log/autoapplication/health-alerts.log}"

DISK_WARN_PERCENT="${MONITOR_DISK_USAGE_WARN_PERCENT:-85}"
MEM_AVAILABLE_WARN_MB="${MONITOR_MEMORY_AVAILABLE_WARN_MB:-768}"
SWAP_WARN_PERCENT="${MONITOR_SWAP_USAGE_WARN_PERCENT:-80}"
LOAD_WARN_PER_CORE="${MONITOR_LOAD_WARN_PER_CORE:-2.0}"
FIVE_XX_WARN_COUNT="${MONITOR_5XX_WARN_COUNT:-20}"
TABLESPACE_POLICY_SCRIPT="${POSTGRES_TABLESPACE_POLICY_SCRIPT:-$APP_DIR/deploy/single-vps/postgres-tablespace-policy.sh}"

mkdir -p "$(dirname "$LOG_FILE")"

# Docker Compose env files are not shell programs; some valid Compose values
# cannot be sourced by Bash. Read only the optional alert webhook literally.
read_compose_env_value() {
  local key="$1"
  local line value
  [[ -f "$APP_DIR/$ENV_FILE" ]] || return 0
  line="$(awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$APP_DIR/$ENV_FILE")"
  value="$line"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

if [[ -z "${MONITOR_ALERT_WEBHOOK_URL:-}" ]]; then
  MONITOR_ALERT_WEBHOOK_URL="$(read_compose_env_value MONITOR_ALERT_WEBHOOK_URL)"
fi

alerts=()

add_alert() {
  alerts+=("$1")
}

root_disk_pct="$(df -P / | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [[ "$root_disk_pct" =~ ^[0-9]+$ ]] && (( root_disk_pct >= DISK_WARN_PERCENT )); then
  add_alert "root disk is ${root_disk_pct}% full"
fi

if mountpoint -q /mnt/HC_Volume_105915443; then
  volume_disk_pct="$(df -P /mnt/HC_Volume_105915443 | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
  if [[ "$volume_disk_pct" =~ ^[0-9]+$ ]] && (( volume_disk_pct >= DISK_WARN_PERCENT )); then
    add_alert "backup volume is ${volume_disk_pct}% full"
  fi
fi

if [[ -x "$TABLESPACE_POLICY_SCRIPT" ]]; then
  if ! tablespace_report="$(
    APP_DIR="$APP_DIR" \
      COMPOSE_FILE="$COMPOSE_FILE" \
      ENV_FILE="$ENV_FILE" \
      "$TABLESPACE_POLICY_SCRIPT" --check 2>&1
  )"; then
    tablespace_report="${tablespace_report//$'\n'/; }"
    add_alert "PostgreSQL tablespace policy: ${tablespace_report:0:700}"
  fi
fi

mem_available_mb="$(free -m | awk '/^Mem:/ { print $7 }')"
if [[ "$mem_available_mb" =~ ^[0-9]+$ ]] && (( mem_available_mb < MEM_AVAILABLE_WARN_MB )); then
  add_alert "available memory is ${mem_available_mb}MB"
fi

swap_pct="$(free -m | awk '/^Swap:/ { if ($2 > 0) printf "%.0f", ($3 / $2) * 100; else print 0 }')"
if [[ "$swap_pct" =~ ^[0-9]+$ ]] && (( swap_pct >= SWAP_WARN_PERCENT )); then
  add_alert "swap usage is ${swap_pct}%"
fi

load_1m="$(awk '{ print $1 }' /proc/loadavg)"
cpu_count="$(nproc 2>/dev/null || echo 1)"
load_too_high="$(awk -v current_load="$load_1m" -v cpus="$cpu_count" -v warn="$LOAD_WARN_PER_CORE" 'BEGIN { print (current_load > cpus * warn) ? 1 : 0 }')"
if [[ "$load_too_high" == "1" ]]; then
  add_alert "1m load is ${load_1m} on ${cpu_count} CPUs"
fi

if command -v docker >/dev/null 2>&1 && [[ -d "$APP_DIR" ]]; then
  compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  unhealthy="$(
    cd "$APP_DIR" &&
      "${compose[@]}" ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null |
      awk '$2 != "running" || ($3 != "" && $3 != "healthy") { print }'
  )"
  if [[ -n "$unhealthy" ]]; then
    add_alert "container health issue: ${unhealthy//$'\n'/; }"
  fi

  five_xx_count="$(
    cd "$APP_DIR" &&
      "${compose[@]}" logs --since 5m caddy 2>/dev/null |
      grep -E '"status":[[:space:]]*5[0-9][0-9]' |
      wc -l |
      tr -d ' '
  )"
  if [[ "$five_xx_count" =~ ^[0-9]+$ ]] && (( five_xx_count >= FIVE_XX_WARN_COUNT )); then
    add_alert "Caddy logged ${five_xx_count} 5xx responses in the last 5 minutes"
  fi
fi

if (( ${#alerts[@]} == 0 )); then
  exit 0
fi

message="ApplyOverflow health alert on $(hostname): ${alerts[*]}"
printf '%s %s\n' "$(date -Is)" "$message" >> "$LOG_FILE"

if [[ -n "${MONITOR_ALERT_WEBHOOK_URL:-}" ]]; then
  json_text="$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  curl -fsS -m 8 \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$json_text\"}" \
    "$MONITOR_ALERT_WEBHOOK_URL" >/dev/null || true
fi
