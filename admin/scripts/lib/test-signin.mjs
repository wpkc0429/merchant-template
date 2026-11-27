// TEST-ONLY helper for the offline suites. lib/api.js has no `tokens` export any more (D18: the client and the token are sealed in a
// closure), so a test signs in the way the app does: through the boot-phase client (takeApi()) with a stubbed fetch that answers the login.
// The offline suites never call sealApi(), so takeApi() keeps working in them.
export async function signIn(net, access, scope = "preview_ro") {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: access, scope }), { status: 200, headers: { "Content-Type": "application/json" } });
  try { await net.login("test@example.com", "test-password"); } finally { globalThis.fetch = orig; }
}
