# syntax=docker/dockerfile:1
# Static hosting for the merchant admin (no build step). Build context is the admin/ directory:
#
#   docker build -f deploy/Dockerfile -t merchant-admin .        (run from admin/)
#   docker run --rm -p 127.0.0.1:3001:80 \
#     -e ADMIN_IMG_ORIGIN=https://img.example.com \
#     -e ADMIN_UPLOAD_ORIGIN=https://<account-id>.r2.cloudflarestorage.com merchant-admin
#
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
# The CSP needs both origins: fail at start-up instead of shipping a policy that blocks image upload.
RUN printf '%s\n' '#!/bin/sh' \
  ': "${ADMIN_IMG_ORIGIN:?set ADMIN_IMG_ORIGIN (image public origin)}"' \
  ': "${ADMIN_UPLOAD_ORIGIN:?set ADMIN_UPLOAD_ORIGIN (R2/S3 direct-upload origin)}"' \
  > /docker-entrypoint.d/05-require-origins.sh && chmod +x /docker-entrypoint.d/05-require-origins.sh
EXPOSE 80
