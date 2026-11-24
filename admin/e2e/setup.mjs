// One-time setup on the throwaway stack: register the site's origin as purpose=admin for the demo shop.
import { req, apiLogin, superAdmin, SITE, check, failureCount } from "./lib.mjs";

const token = await apiLogin(superAdmin());
const shopID = 1;
// The API resolves a same-origin GET (no Origin header) as https://{Host}, so on a plain-http
// localhost test site the https twin must be registered too. Production is https only.
for (const origin of [SITE, SITE.replace(/^http:/, "https:")]) {
  const r = await req("POST", `/admin/shops/${shopID}/allowed-origins`, { token, body: { origin, purpose: "admin" } });
  check(`admin origin ${origin} registered`, r.status === 200 || r.status === 201 || /already registered/.test(JSON.stringify(r.json)), `(status ${r.status} ${JSON.stringify(r.json)})`);
}
const b = await fetch(`${SITE}/api/v1/admin/branding`).then(async (r) => ({ status: r.status }));
check("branding resolves for the admin origin", b.status === 200, `(status ${b.status})`);
process.exit(failureCount() ? 1 : 0);
