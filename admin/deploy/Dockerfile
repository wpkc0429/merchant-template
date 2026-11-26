# syntax=docker/dockerfile:1
# Static hosting for the merchant admin (no build step). Build context is the admin/ directory:
#
#   docker build -f deploy/Dockerfile -t merchant-admin .        (run from admin/)
#   docker run --rm -p 127.0.0.1:3001:80 \
#     -e ADMIN_IMG_ORIGIN=https://img.example.com \
#     -e ADMIN_UPLOAD_ORIGIN=https://<account-id>.r2.cloudflarestorage.com \
#     -e ADMIN_SITE_ORIGIN=https://www.example.com merchant-admin
#
# The CSP in deploy/nginx.conf.template is ON BY DEFAULT and REQUIRED, NOT OPTIONAL (decided 2026-11-25): there is no switch to turn it
# off, and this image must not be changed to drop it (scripts/check-design.mjs checks both files). The same policy must be served by any
# AI-edit preview environment.
# 127.0.0.1:3001 is where the tunnel ingress example expects the admin (deploy/cloudflared-ingress.example.yml).
# Only the published files are copied (README "部署"): never config.local.js, scripts/, e2e/ or docs/.
FROM nginx:1.27-alpine
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html app.js styles.css config.js config-loader.js /usr/share/nginx/html/
COPY lib/ /usr/share/nginx/html/lib/
COPY core/ /usr/share/nginx/html/core/
COPY ui/ /usr/share/nginx/html/ui/
COPY design/ /usr/share/nginx/html/design/
COPY design-defaults/ /usr/share/nginx/html/design-defaults/
COPY vendor/ /usr/share/nginx/html/vendor/
# Start-up checks and the DNS resolver (deploy/require-origins.sh validates the three origins and fails with a clear message; deploy/resolver.envsh
# exports ADMIN_RESOLVER for the variable proxy_pass of /content.schema.json, so the storefront hostname is resolved per request, not at start-up).
COPY deploy/require-origins.sh /docker-entrypoint.d/05-require-origins.sh
COPY deploy/resolver.envsh /docker-entrypoint.d/06-resolver.envsh
COPY deploy/preview-config.sh /docker-entrypoint.d/07-preview-config.sh
RUN chmod +x /docker-entrypoint.d/05-require-origins.sh /docker-entrypoint.d/07-preview-config.sh
# Preview hosts (version preview / change preview): also set ADMIN_PREVIEW_MODE=version|change, ADMIN_PREVIEW_TAG, ADMIN_PREVIEW_EXPIRES (deploy/preview-config.sh);
# the core is then read-only and shows its own banner. A preview is served with the same strict CSP, X-Robots-Tag noindex and no framing as production.
EXPOSE 80
