// Localhost only: loads the gitignored config.local.js override (see README). Never does anything on a real domain.
// (A separate file, not an inline script, so a strict CSP with script-src 'self' needs no exceptions.)
if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  document.write('<script src="config.local.js"><\/script>');
} else {
  // Production: the host (deploy/nginx.conf.template) serves site-config.js with the storefront origin (ADMIN_SITE_ORIGIN) for the
  // content preview tab. A host without it just gets a 404 and the preview button says it is not configured.
  document.write('<script src="site-config.js"><\/script>');
}
