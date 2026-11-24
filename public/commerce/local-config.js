/* ============================================================
   commerce/local-config.js: LOCKED commerce layer.

   Loads the optional, gitignored public/config.local.js, and only on localhost / 127.0.0.1, so a deployed site never
   asks for a file that does not exist there. It is a separate file (not an inline <script> in index.html) so that the
   strict Content-Security-Policy in public/_headers (script-src 'self', no 'unsafe-inline') needs no exception.
   Must be included right after config.js and before commerce/api.js.
   ============================================================ */
(function () {
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    document.write('<script src="config.local.js"><\/script>');
  }
})();
