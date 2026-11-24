// Login screen. Signing in is ctx.auth.login (tokens and the session never reach this file).
import { authPage, loginForm } from "../parts/auth-parts.js";

export default function login(root, ctx) {
  const { h } = ctx.ui;
  const { email = "", notice = "" } = ctx.route.state;
  const f = loginForm(ctx, { email });
  root.append(authPage(ctx,
    h("h1", { class: "auth__title" }, ctx.t("login.title")),
    notice ? h("p", { class: "notice", "data-testid": "login-notice" }, notice) : "",
    f.form));
  setTimeout(f.focus, 0);
}
