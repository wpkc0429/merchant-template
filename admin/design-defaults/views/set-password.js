// #/set-password/{token}: the token stays in the core; this screen only shows the account and takes the new password.
import { authPage, invalidLink, isDeadLink, passwordPair } from "../parts/auth-parts.js";

export default async function setPassword(root, ctx) {
  const { h, clear, button, busy, toast, loading, setFieldError } = ctx.ui;
  const { t, errorMessage } = ctx;
  const body = h("div", {}, loading());
  root.append(authPage(ctx, h("h1", { class: "auth__title" }, t("pw.setTitle")), body));
  let info;
  try {
    info = await ctx.auth.passwordSetup.inspect();
  } catch (e) {
    clear(body).append(isDeadLink(e) ? invalidLink(ctx) : h("p", { class: "form-error" }, e.status === 429 ? t("auth.rateLimited") : errorMessage(e)));
    return;
  }
  const pair = passwordPair(ctx);
  const submit = button(t("pw.setSubmit"), { kind: "primary", type: "submit", "data-testid": "pw-submit" });
  clear(body).append(
    h("p", { class: "lede" }, info.kind === "reset" ? t("pw.ledeReset") : t("pw.ledeSet"), h("strong", { "data-testid": "pw-email" }, info.email)),
    h("form", { class: "form", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      setFieldError(pair.f1, ""); setFieldError(pair.f2, "");
      await busy(submit, async () => {
        try {
          await ctx.auth.passwordSetup.submit(pair.value(), pair.confirm());
        } catch (ex) {
          if (ex.fields) { ctx.ui.applyFieldErrors(body, ex.fields); return; }
          if (isDeadLink(ex)) { clear(body).append(invalidLink(ctx)); return; }
          if (ex.status === 422) { setFieldError(pair.f1, ctx.fieldErrors(ex)["/password"] || t("auth.pw.short", { min: ctx.auth.minPassword })); return; }
          toast(ex.status === 429 ? t("auth.rateLimited") : errorMessage(ex), "error");
        }
      });
    } }, ...pair.nodes, submit));
}
