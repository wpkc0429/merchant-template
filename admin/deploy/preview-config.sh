#!/bin/sh
# Start-up step (installed as /docker-entrypoint.d/07-preview-config.sh by deploy/Dockerfile). Writes /preview-config.js, which tells the
# core whether this host is a PREVIEW host (a version preview or a change preview of the AI edit service). On a preview host the core is
# read-only and shows its own banner (lib/preview.js, ui/preview-banner.js); a normal host gets `window.ADMIN_CONFIG.preview = null`.
#   ADMIN_PREVIEW_MODE     unset/empty = normal host; "version" or "change" = preview host (anything else stops the container)
#   ADMIN_PREVIEW_TAG      the design tag being previewed, ^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$ (optional)
#   ADMIN_PREVIEW_EXPIRES  RFC 3339 UTC time like 2026-11-27T12:00:00Z when the preview is torn down (optional)
# The preview host must ALSO be served with the strict CSP (nginx.conf.template: always on, frame-ancestors 'none', X-Robots-Tag noindex).
fail() { echo "admin: $1" >&2; exit 1; }
OUT=/usr/share/nginx/html/preview-config.js
mode="${ADMIN_PREVIEW_MODE:-}"
if [ -z "$mode" ]; then
  printf '%s\n' 'window.ADMIN_CONFIG.preview = null;' > "$OUT"
  exit 0
fi
case "$mode" in version|change) ;; *) fail "ADMIN_PREVIEW_MODE must be empty, version or change" ;; esac
tag="${ADMIN_PREVIEW_TAG:-}"
exp="${ADMIN_PREVIEW_EXPIRES:-}"
[ -z "$tag" ] || printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$' || fail "ADMIN_PREVIEW_TAG has a bad shape"
[ -z "$exp" ] || printf '%s' "$exp" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$' || fail "ADMIN_PREVIEW_EXPIRES must be an RFC 3339 UTC time like 2026-11-27T12:00:00Z"
printf 'window.ADMIN_CONFIG.preview = {"kind":"%s","tag":"%s","expiresAt":"%s"};\n' "$mode" "$tag" "$exp" > "$OUT"
