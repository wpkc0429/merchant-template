#!/usr/bin/env bash
# Brings up a THROWAWAY platform stack for the template's browser tests. Template-only. Run from anywhere.
#
#   tests/e2e/stack-up.sh        ->  DB merchant_template_dev (migrated + `seed -demo`), an API on 127.0.0.1:8180
#                                    (REDIS_DB=1, mock payment provider, MinIO bucket ecommerce-media-e2e, relaxed rate limits),
#                                    state in $E2E_RUN_DIR (default: <tmp>/merchant-template-e2e)
#   tests/e2e/stack-down.sh      ->  stops what this started, DROPs merchant_template_dev, FLUSHDBs Redis DB 1 only,
#                                    empties only the MinIO bucket ecommerce-media-e2e
#
# It NEVER touches the main `ecommerce` database, the user's tunnel or Cloudflare, and never runs `docker compose down -v`.
# Credentials are read from the platform checkout's .env at run time and are never printed or written anywhere else.
# Needs: Docker containers of the platform's docker-compose (postgres, redis, minio) running, Go, curl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ECOM="${PLATFORM_DIR:-$(cd "$HERE/../../.." && pwd)/ecommerce}"
RUN="${E2E_RUN_DIR:-${TMPDIR:-/tmp}/merchant-template-e2e}"
DB=merchant_template_dev
PORT=8180
mkdir -p "$RUN"

set -a
# shellcheck disable=SC1091
. "$ECOM/.env"
set +a

# --- guard: the database we are about to create / migrate / seed must be the throwaway one ---
THROWAWAY_URL="$(printf '%s' "$DATABASE_URL" | sed "s#/[A-Za-z0-9_]*?#/$DB?#")"
case "$THROWAWAY_URL" in */"$DB"\?*) ;; *) echo "refusing: cannot derive the throwaway DATABASE_URL" >&2; exit 1 ;; esac
export DATABASE_URL="$THROWAWAY_URL"

PG="${E2E_PG_CONTAINER:-ecommerce-postgres-1}"
if docker exec "$PG" psql -U "$POSTGRES_USER" -d postgres -Atc "select 1 from pg_database where datname='$DB'" | grep -q 1; then
  echo "database $DB already exists (a previous run was not torn down): run tests/e2e/stack-down.sh first" >&2
  exit 1
fi
docker exec "$PG" psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $DB" >/dev/null
echo "created database $DB"

export APP_ENV=development
cd "$ECOM/api"
go run ./cmd/migrate -direction up >"$RUN/migrate.log" 2>&1 && echo "migrated"
go run ./cmd/seed -demo >"$RUN/seed.log" 2>&1 && echo "seeded (demo shop)"

# --- throwaway API ---
export API_ADDR="127.0.0.1:$PORT" REDIS_DB=1 PAYMENT_DEFAULT_PROVIDER=mock
export R2_BUCKET="${MINIO_BUCKET_E2E:-ecommerce-media-e2e}"
export IMAGE_PUBLIC_BASE_URL="http://127.0.0.1:9000/$R2_BUCKET"
export PAYMENT_MOCK_WEBHOOK_SECRET="${E2E_MOCK_WEBHOOK_SECRET:-e2e-mock-webhook-secret-for-throwaway-stack-only-0001}"
for k in RATE_LIMIT_LOGIN_BROAD_LIMIT RATE_LIMIT_LOGIN_TIGHT_LIMIT RATE_LIMIT_GUEST_CHECKOUT_BROAD_LIMIT RATE_LIMIT_GUEST_CHECKOUT_TIGHT_LIMIT RATE_LIMIT_REFRESH_LIMIT; do export "$k=100000"; done
go build -o "$RUN/api-e2e.exe" ./cmd/server
"$RUN/api-e2e.exe" >"$RUN/api.log" 2>&1 &
echo $! >"$RUN/api.pid"
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/shop/categories"; then echo "API up on 127.0.0.1:$PORT"; exit 0; fi
  sleep 1
done
echo "API did not come up, see $RUN/api.log" >&2
exit 1
