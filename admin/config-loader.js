// Localhost only: loads the gitignored config.local.js override (see README). Never does anything on a real domain.
// (A separate file, not an inline script, so a strict CSP with script-src 'self' needs no exceptions.)
if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  document.write('<script src="config.local.js"><\/script>');
}
