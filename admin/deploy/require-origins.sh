#!/bin/sh
# Start-up check (installed as /docker-entrypoint.d/05-require-origins.sh by deploy/Dockerfile). The origins go into the CSP and
# into nginx.conf, so anything that is not a plain origin must stop the container with a clear message instead of producing a
# broken or injectable config.
fail() { echo "admin: $1" >&2; exit 1; }
: "${ADMIN_IMG_ORIGIN:?set ADMIN_IMG_ORIGIN (image public origin)}"
: "${ADMIN_UPLOAD_ORIGIN:?set ADMIN_UPLOAD_ORIGIN (R2/S3 direct-upload origin)}"
: "${ADMIN_SITE_ORIGIN:?set ADMIN_SITE_ORIGIN (storefront origin: content preview and content.schema.json)}"
# Image and upload origins: scheme://host[:port], nothing else (no path, quotes, semicolons, spaces, $ or braces).
for v in ADMIN_IMG_ORIGIN ADMIN_UPLOAD_ORIGIN; do
  eval "val=\${$v}"
  printf '%s' "$val" | grep -Eq '^https?://[A-Za-z0-9._-]+(:[0-9]+)?$' || fail "$v must look like https://host[:port] (no trailing slash, path, quotes or semicolons); got a value that does not"
done
printf '%s' "$ADMIN_SITE_ORIGIN" | grep -Eq '^https://[a-z0-9.-]+(:[0-9]+)?$' || fail "ADMIN_SITE_ORIGIN must match ^https://[a-z0-9.-]+(:[0-9]+)?\$ (lowercase host, no trailing slash, no path, no quotes or semicolons)"
