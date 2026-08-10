#!/usr/bin/env bash
set -euo pipefail

# Keep designated high-churn PostgreSQL indexes on the attached volume. This is
# intentionally index-only: moving a table body needs an explicit maintenance
# window and must never be performed by an unattended capacity job.

APP_DIR="${APP_DIR:-/opt/autoapplication}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/single-vps/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-deploy/single-vps/.env.production}"

MODE="check"
if [[ "${1:-}" == "--apply" ]]; then
  MODE="apply"
elif [[ -n "${1:-}" && "${1:-}" != "--check" ]]; then
  echo "Usage: $0 [--check|--apply]" >&2
  exit 2
fi

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-single-vps-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-autoapplication}"
POSTGRES_DB="${POSTGRES_DB:-autoapplication}"
TABLESPACE_NAME="${POSTGRES_TABLESPACE_NAME:-applyoverflow_volume}"
TABLESPACE_MOUNT="${POSTGRES_TABLESPACE_HOST_DIR:-/mnt/HC_Volume_105915443/autoapplication/postgres-tablespace}"
VOLUME_MOUNT="${POSTGRES_TABLESPACE_VOLUME_MOUNT:-/mnt/HC_Volume_105915443}"

# The 69 GB attached disk also receives daily logical backup dumps. Keep at
# least 18 GB free, and do not let active tablespace data exceed 70% of the
# device. The effective budget is the stricter of the two values.
MIN_FREE_GB="${POSTGRES_TABLESPACE_MIN_FREE_GB:-18}"
MAX_USED_PERCENT="${POSTGRES_TABLESPACE_MAX_USED_PERCENT:-70}"
LOCK_TIMEOUT="${POSTGRES_TABLESPACE_LOCK_TIMEOUT:-5s}"
STATEMENT_TIMEOUT="${POSTGRES_TABLESPACE_STATEMENT_TIMEOUT:-90min}"

cd "$APP_DIR"

bytes_from_gb() {
  awk -v gigabytes="$1" 'BEGIN { printf "%.0f", gigabytes * 1024 * 1024 * 1024 }'
}

sql_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

sql_identifier() {
  printf "%s" "$1" | sed 's/"/""/g'
}

db_sql() {
  docker exec "$POSTGRES_CONTAINER" psql \
    -X -qAt -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"
}

if ! mountpoint -q "$VOLUME_MOUNT"; then
  echo "tablespace volume mount is unavailable: $VOLUME_MOUNT" >&2
  exit 1
fi

if ! df -Pk "$VOLUME_MOUNT" >/dev/null; then
  echo "cannot inspect attached-volume capacity" >&2
  exit 1
fi

if ! db_sql "SELECT 1 FROM pg_tablespace WHERE spcname = '$(sql_literal "$TABLESPACE_NAME")'" | grep -qx '1'; then
  echo "PostgreSQL tablespace $TABLESPACE_NAME does not exist" >&2
  exit 1
fi

read -r volume_total_kb volume_used_kb volume_available_kb volume_used_percent < <(
  df -Pk "$VOLUME_MOUNT" | awk 'NR == 2 { gsub("%", "", $5); print $2, $3, $4, $5 }'
)
root_used_percent="$(df -Pk / | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
tablespace_bytes="$(db_sql "SELECT pg_tablespace_size('$(sql_literal "$TABLESPACE_NAME")')")"
min_free_bytes="$(bytes_from_gb "$MIN_FREE_GB")"
volume_total_bytes="$((volume_total_kb * 1024))"
max_by_percent_bytes="$((volume_total_bytes * MAX_USED_PERCENT / 100))"
max_by_reserve_bytes="$((volume_total_bytes - min_free_bytes))"
if (( max_by_reserve_bytes < max_by_percent_bytes )); then
  active_budget_bytes="$max_by_reserve_bytes"
else
  active_budget_bytes="$max_by_percent_bytes"
fi

if (( active_budget_bytes <= 0 )); then
  echo "invalid tablespace budget: reserve exceeds attached-volume capacity" >&2
  exit 1
fi

volume_available_bytes="$((volume_available_kb * 1024))"
printf '[tablespace-policy] mode=%s root=%s%% volume=%s%% tablespace=%sB budget=%sB reserve=%sB\n' \
  "$MODE" "$root_used_percent" "$volume_used_percent" "$tablespace_bytes" "$active_budget_bytes" "$min_free_bytes"

# This manifest is the storage tier. New writes to an index moved here remain
# on the attached volume for the life of the index; the nightly pass repairs an
# accidental root-volume recreation without touching application data.
MANAGED_INDEXES=(
  'JobUrlHealthCheck_pkey'
  'JobUrlHealthCheck_canonicalJobId_checkedAt_idx'
  'JobUrlHealthCheck_result_checkedAt_idx'
  'JobUrlHealthCheck_urlType_checkedAt_idx'
  'SourceTask_pkey'
  'SourceTask_kind_status_notBeforeAt_priorityScore_createdAt_idx'
  'SourceTask_kind_status_notBeforeAt_priorityScore_idx'
  'SourceTask_canonicalJobId_kind_status_idx'
  'SourceTask_companyId_kind_status_idx'
  'SourceTask_companySourceId_kind_status_idx'
  'JobFeedIndex_searchText_trgm_idx'
  'JobFeedIndex_searchText_fts_idx'
)

needs_attention=0
for index_name in "${MANAGED_INDEXES[@]}"; do
  index_name_sql="$(sql_literal "$index_name")"
  index_info="$(db_sql "
    SELECT
      coalesce(ts.spcname, 'pg_default'),
      pg_relation_size(c.oid)
    FROM pg_class c
    LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
    WHERE c.relkind = 'i'
      AND c.relnamespace = 'public'::regnamespace
      AND c.relname = '$index_name_sql'
  ")"

  if [[ -z "$index_info" ]]; then
    echo "[tablespace-policy] missing managed index: $index_name" >&2
    needs_attention=1
    continue
  fi

  IFS='|' read -r index_tablespace index_bytes <<< "$index_info"
  if [[ "$index_tablespace" == "$TABLESPACE_NAME" ]]; then
    printf '[tablespace-policy] resident index=%s size=%sB\n' "$index_name" "$index_bytes"
    continue
  fi

  printf '[tablespace-policy] pending index=%s size=%sB location=%s\n' \
    "$index_name" "$index_bytes" "$index_tablespace"
  needs_attention=1

  if [[ "$MODE" != "apply" ]]; then
    continue
  fi

  if (( tablespace_bytes + index_bytes > active_budget_bytes )); then
    echo "[tablespace-policy] skipped $index_name: active tablespace budget would be exceeded" >&2
    continue
  fi
  if (( volume_available_bytes - index_bytes < min_free_bytes )); then
    echo "[tablespace-policy] skipped $index_name: backup reserve would be breached" >&2
    continue
  fi

  quoted_index_name="$(sql_identifier "$index_name")"
  quoted_tablespace_name="$(sql_identifier "$TABLESPACE_NAME")"
  echo "[tablespace-policy] moving $index_name to $TABLESPACE_NAME"
  if ! move_output="$(db_sql "
      SET lock_timeout = '$(sql_literal "$LOCK_TIMEOUT")';
      SET statement_timeout = '$(sql_literal "$STATEMENT_TIMEOUT")';
      ALTER INDEX public.\"$quoted_index_name\" SET TABLESPACE \"$quoted_tablespace_name\";
    " 2>&1)"; then
    echo "[tablespace-policy] deferred $index_name: ${move_output//$'\n'/; }" >&2
    continue
  fi

  tablespace_bytes="$((tablespace_bytes + index_bytes))"
  volume_available_bytes="$((volume_available_bytes - index_bytes))"
done

if [[ "$MODE" == "apply" ]]; then
  # Re-read the catalog because a successful migration changes the physical
  # location after PostgreSQL has copied and validated the index.
  exec "$0" --check
fi

if (( needs_attention != 0 )); then
  exit 1
fi
