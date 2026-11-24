#!/usr/bin/env bash
# Tears down what tests/e2e/stack-up.sh and the e2e helpers started. Template-only.
# Stops processes on the throwaway ports, DROPs merchant_template_dev, FLUSHDBs Redis DB 1 ONLY,
# empties ONLY the MinIO bucket ecommerce-media-e2e. Never `docker compose down -v`, never the main database.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ECOM="${ECOMMERCE_DIR:-$(cd "$HERE/../../.." && pwd)/ecommerce}"
DB=merchant_template_dev

set -a
# shellcheck disable=SC1091
. "$ECOM/.env"
set +a

# 1. processes: only the ports used by the throwaway stack (API 8180, storefront 8788, admin 3001)
for port in 8180 8788 3001; do
  for pid in $(netstat -ano 2>/dev/null | tr -d '\r' | awk -v p=":$port" '$2 ~ p"$" && $4 ~ /LISTEN/ {print $5}' | sort -u); do
    [ -n "$pid" ] && [ "$pid" != "0" ] && taskkill //F //PID "$pid" >/dev/null 2>&1 && echo "stopped pid $pid (port $port)"
  done
done

# 2. database (only the throwaway name, hard-coded; terminate leftover connections first)
PG="${E2E_PG_CONTAINER:-ecommerce-postgres-1}"
docker exec "$PG" psql -U "$POSTGRES_USER" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB'" >/dev/null
docker exec "$PG" psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB" && echo "dropped database $DB"

# 3. Redis DB 1 only
RD="${E2E_REDIS_CONTAINER:-ecommerce-redis-1}"
docker exec -e REDISCLI_AUTH="${REDIS_PASSWORD:-}" "$RD" redis-cli -n 1 FLUSHDB && echo "flushed redis db 1"

# 4. MinIO: only the e2e bucket's objects (the bucket itself stays)
MN="${E2E_MINIO_CONTAINER:-ecommerce-minio-1}"
BUCKET="${MINIO_BUCKET_E2E:-ecommerce-media-e2e}"
docker exec "$MN" sh -c "mc alias set local http://127.0.0.1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1; mc rm --recursive --force local/$BUCKET >/dev/null 2>&1; mc ls local/$BUCKET | wc -l" | sed 's/^/objects left in bucket: /'
