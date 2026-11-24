// Authentication functions handed to the design layer (ctx.auth). Tokens (the session's access token, and
// the one-time set-password / invitation link token) stay inside the core: the design layer never sees,
// stores or sends them. Password rules are enforced here. `hooks` are the shell's transitions.
import { login as sessionLogin, passwordSetup, invitations } from "../lib/session.js";
import { refreshTokens } from "../lib/api.js";
import { t } from "../lib/design.js";
import { errorMessage } from "../ui/kit.js";
import { ActionError, invalid } from "./errors.js";

export const MIN_PASSWORD = 12;

function passwordFields(password, confirm) {
  if (String(password ?? "").length < MIN_PASSWORD) throw invalid({ "/password": t("auth.pw.short", { min: MIN_PASSWORD }) });
  if (password !== confirm) throw invalid({ "/password2": t("auth.pw.mismatch") });
}

export function loginMessage(err) {
  if (err && err.status === 401) return t("auth.err.401");
  if (err && err.status === 429) {
    const mins = err.retryAfter ? Math.max(1, Math.ceil(err.retryAfter / 60)) : 0;
    return mins ? t("auth.err.429Wait", { minutes: mins }) : t("auth.err.429");
  }
  if (err && err.status === 403) return t("auth.err.403");
  return errorMessage(err);
}

/** linkToken: the set-password / accept-invite token from the URL (already scrubbed from the address bar). */
export function makeAuth({ linkToken = null, hooks }) {
  let token = linkToken;
  let info = null;
  const need = () => { if (!token) throw new ActionError("state", t("auth.link.invalid"), { reason: "link", status: 404 }); return token; };
  return {
    minPassword: MIN_PASSWORD,
    loginMessage,
    /** Logs in and enters the app. Throws (ApiError / ActionError) so the screen can show loginMessage(err). */
    async login(email, password) {
      const e = String(email ?? "").trim();
      if (!e || !password) throw invalid({}, t("auth.err.missing"));
      await sessionLogin(e, password);
      await hooks.onLoggedIn();
    },
    logout: () => hooks.onLogout(),
    passwordSetup: {
      async inspect() { info = await passwordSetup.inspect(need()); return { email: info.email, kind: info.kind }; },
      async submit(password, confirm) {
        passwordFields(password, confirm);
        await passwordSetup.submit(need(), password);
        token = null;
        hooks.goLogin(info?.email || "", t("auth.pw.done"));
      },
    },
    invitation: {
      async inspect() {
        info = await invitations.inspect(need());
        return { email: info.email, roleName: info.role_name, shopName: info.shop_name, requiresLogin: Boolean(info.requires_login) };
      },
      /** New account: sets the password, then sends the person to the login screen. */
      async acceptNew(password, confirm) {
        passwordFields(password, confirm);
        await invitations.acceptNew(need(), password);
        token = null;
        hooks.goLogin(info?.email || "", t("auth.pw.done"));
      },
      /** Existing account: logs in AS that account, accepts while authenticated, then enters the app. */
      async loginAndJoin(email, password) {
        const e = String(email ?? "").trim();
        if (!e || !password) throw invalid({}, t("auth.err.missing"));
        await sessionLogin(e, password);
        try {
          await invitations.acceptLoggedIn(need());
        } catch (ex) {
          if (ex.status === 403) throw new ActionError("state", t("auth.invite.mismatch"), { reason: "invite" });
          if (ex.status === 404) throw ex;
          if (ex.status !== 409) throw new ActionError("state", errorMessage(ex), { reason: "invite" });
          // 409: already a member of this shop; just continue.
        }
        token = null;
        await refreshTokens(); // re-issue so `sids` includes the new shop
        await hooks.afterJoin();
      },
    },
  };
}
