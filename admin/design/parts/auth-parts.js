// Pieces shared by the login, set-password and accept-invite screens. They never see a token: sign-in,
// the password rules and the link token all live in the core (ctx.auth).

export function authPage(ctx, ...kids) {
  const { h } = ctx.ui;
  return h("div", { class: "auth" }, h("div", { class: "auth__card" },
    h("div", { class: "auth__brand" },
      h("img", { class: "brand-logo", alt: "", hidden: true }),
      h("div", { class: "eyebrow" }, "ADMIN"),
      h("div", { class: "brand-name auth__name" }, ctx.t("app.name"))),
    ...kids));
}

export const invalidLink = (ctx) => ctx.ui.h("div", {}, ctx.ui.h("p", { class: "form-error", "data-testid": "link-invalid" }, ctx.t("auth.link.invalid")));

/** A link problem the core reports as 404 (unknown / used / expired token) or as its own "link" state. */
export const isDeadLink = (e) => e && (e.status === 404 || e.reason === "link");

/**
 * The email + password form. `submit(email, password)` defaults to ctx.auth.login (which enters the app);
 * `onError(err)` may return true when it handled the error itself.
 */
export function loginForm(ctx, { email = "", submitLabel, submit, onError }) {
  const { h, field, input, button, busy } = ctx.ui;
  const emailIn = input({ type: "email", name: "email", autocomplete: "username", value: email, required: true, inputmode: "email", "data-testid": "login-email" });
  const passIn = input({ type: "password", name: "password", autocomplete: "current-password", required: true, "data-testid": "login-password" });
  const err = h("p", { class: "form-error", role: "alert", "data-testid": "login-error", hidden: true });
  const submitBtn = button(submitLabel || ctx.t("login.submit"), { kind: "primary", type: "submit", "data-testid": "login-submit" });
  const form = h("form", { class: "form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    await busy(submitBtn, async () => {
      try {
        await (submit || ctx.auth.login)(emailIn.value, passIn.value);
        passIn.value = "";
      } catch (ex) {
        passIn.value = "";
        if (onError && onError(ex)) return;
        err.textContent = ctx.auth.loginMessage(ex);
        err.hidden = false;
      }
    });
  } }, field(ctx.t("login.email"), emailIn), field(ctx.t("login.password"), passIn), err, submitBtn);
  return { form, focus: () => (emailIn.value ? passIn : emailIn).focus() };
}

/** New-password + confirmation fields. The length / match rules are enforced by the core when you submit. */
export function passwordPair(ctx) {
  const { input, field } = ctx.ui;
  const pw = input({ type: "password", autocomplete: "new-password", "data-testid": "pw-new" });
  const pw2 = input({ type: "password", autocomplete: "new-password", "data-testid": "pw-confirm" });
  const f1 = field(ctx.t("pw.new"), pw, { hint: ctx.t("pw.hint", { min: ctx.auth.minPassword }), pointer: "/password" });
  const f2 = field(ctx.t("pw.confirm"), pw2, { pointer: "/password2" });
  return { nodes: [f1, f2], f1, f2, value: () => pw.value, confirm: () => pw2.value };
}
