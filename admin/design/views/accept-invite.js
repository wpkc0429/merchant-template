// #/accept-invite/{token}: new accounts set a password; existing accounts sign in and then join.
// The token stays in the core; the password rules and the sign-in/accept sequence are ctx.auth.invitation.*.
import { authPage, invalidLink, isDeadLink, passwordPair, loginForm } from "../parts/auth-parts.js";

export default async function acceptInvite(root, ctx) {
  const { h, clear, button, busy, toast, loading, setFieldError, applyFieldErrors } = ctx.ui;
  const { t, errorMessage } = ctx;
  const body = h("div", {}, loading());
  root.append(authPage(ctx, h("h1", { class: "auth__title" }, t("invite.title")), body));
  let info;
  try {
    info = await ctx.auth.invitation.inspect();
  } catch (e) {
    clear(body).append(isDeadLink(e) ? invalidLink(ctx) : h("p", { class: "form-error" }, e.status === 429 ? t("auth.rateLimited") : errorMessage(e)));
    return;
  }
  const summary = h("p", { class: "lede" }, t("invite.summary1"), h("strong", {}, info.roleName), t("invite.summary2"), h("strong", {}, info.shopName), t("invite.summary3"), h("strong", { "data-testid": "invite-email" }, info.email));

  if (!info.requiresLogin) {
    const pair = passwordPair(ctx);
    const submit = button(t("invite.submit"), { kind: "primary", type: "submit", "data-testid": "invite-submit" });
    clear(body).append(summary, h("form", { class: "form", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      setFieldError(pair.f1, ""); setFieldError(pair.f2, "");
      await busy(submit, async () => {
        try {
          await ctx.auth.invitation.acceptNew(pair.value(), pair.confirm());
        } catch (ex) {
          if (ex.fields) { applyFieldErrors(body, ex.fields); return; }
          if (isDeadLink(ex)) { clear(body).append(invalidLink(ctx)); return; }
          if (ex.status === 409) { toast(t("invite.err409"), "error"); return; }
          if (ex.status === 422) { setFieldError(pair.f1, t("auth.pw.short", { min: ctx.auth.minPassword })); return; }
          toast(errorMessage(ex), "error");
        }
      });
    } }, ...pair.nodes, submit));
    return;
  }

  // The e-mail already has an account: log in AS that account, then accept while authenticated.
  const msg = h("p", { class: "form-error", hidden: true, role: "alert", "data-testid": "invite-error" });
  const f = loginForm(ctx, {
    email: info.email,
    submitLabel: t("invite.loginJoin"),
    submit: (email, password) => ctx.auth.invitation.loginAndJoin(email, password),
    onError: (ex) => {
      if (ex.reason === "invite") { msg.textContent = ex.message; msg.hidden = false; return true; }
      if (isDeadLink(ex)) { clear(body).append(invalidLink(ctx)); return true; }
      return false;
    },
  });
  clear(body).append(summary, h("p", { class: "notice" }, t("invite.hasAccount")), f.form, msg);
  f.focus();
}
