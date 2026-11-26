#!/bin/sh
# Start-up step (installed as /docker-entrypoint.d/07-preview-config.sh by deploy/Dockerfile). Writes /preview-config.js, which tells the
# core whether this host is a PREVIEW host (a version preview or a change preview of the AI edit service). On a preview host the core is
# read-only and shows its own banner (lib/preview.js, ui/preview-banner.js); a normal host gets `window.ADMIN_CONFIG.preview = null`.
#   ADMIN_PREVIEW_MODE     unset/empty = normal host; "version" or "change" = preview host (anything else stops the container)
#   ADMIN_PREVIEW_TAG      the design tag being previewed, ^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$ (optional)
#   ADMIN_PREVIEW_EXPIRES  RFC 3339 UTC time like 2026-11-27T12:00:00Z when the preview is torn down (optional)
# The preview host must ALSO be served with the strict CSP (nginx.conf.template: always on, frame-ancestors 'none', X-Robots-Tag noindex).
# Every value is checked BEFORE anything is written: a newline or any other control character is refused (a per-line grep would pass
# "ok<newline>"};alert(1);//" and the file would be syntactically broken, which used to turn the preview OFF silently).
# The container refuses to start when a value is bad, when the file cannot be written or when what was written is not what was meant.
fail() { echo "admin: $1" >&2; exit 1; }
# clean VALUE: only printable ASCII (no newline, no control character, no byte above 0x7e). Counting the removed bytes avoids
# command substitution, which would drop a trailing newline.
clean() { [ "$(printf '%s' "$1" | LC_ALL=C tr -d '[:print:]' | wc -c | tr -d ' ')" = "0" ]; }
OUT=/usr/share/nginx/html/preview-config.js
# The LAST statement of a complete file is the marker lib/preview.js looks for: a host whose file is missing or cut short fails closed.
MARK='window.ADMIN_CONFIG.previewConfig = true;'
write() { printf '%s\n%s\n' "$1" "$MARK" > "$OUT" || fail "cannot write $OUT (preview config)"; grep -qF "$MARK" "$OUT" || fail "preview config was not written completely"; }
mode="${ADMIN_PREVIEW_MODE:-}"
clean "$mode" || fail "ADMIN_PREVIEW_MODE has a control character or newline"
if [ -z "$mode" ]; then
  write 'window.ADMIN_CONFIG.preview = null;'
  exit 0
fi
case "$mode" in version|change) ;; *) fail "ADMIN_PREVIEW_MODE must be empty, version or change" ;; esac
tag="${ADMIN_PREVIEW_TAG:-}"
exp="${ADMIN_PREVIEW_EXPIRES:-}"
clean "$tag" || fail "ADMIN_PREVIEW_TAG has a control character or newline"
clean "$exp" || fail "ADMIN_PREVIEW_EXPIRES has a control character or newline"
[ -z "$tag" ] || printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$' || fail "ADMIN_PREVIEW_TAG has a bad shape"
[ -z "$exp" ] || printf '%s' "$exp" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$' || fail "ADMIN_PREVIEW_EXPIRES must be an RFC 3339 UTC time like 2026-11-27T12:00:00Z"
write "$(printf 'window.ADMIN_CONFIG.preview = {"kind":"%s","tag":"%s","expiresAt":"%s"};' "$mode" "$tag" "$exp")"
