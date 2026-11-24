/* Tracked defaults. Do NOT put local settings here.
   On localhost, create a gitignored config.local.js to point at an API:
     window.ADMIN_CONFIG.apiBase = "http://localhost:8080";
   Off localhost the API base is always location.origin (same-origin deploy). */
window.ADMIN_CONFIG = { apiBase: "" };
