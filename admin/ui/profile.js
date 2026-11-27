// The DOM of the personal profile page and of the one-time hint (CORE, D21). Drawn with the safe builder h(); every text is core text
// (lib/fixed-text.js, no copy key) and every value goes in as text or as an input value, never as markup. No storage, no network here
// (core/profile.js is the controller). Styled by the locked styles.css (.profile*), so design tokens and theme.css can theme it, nothing more.
import { h, button, busy, toast, pageHeader } from "./kit.js";
import { coreText } from "../lib/fixed-text.js";

const ID = { name: "pf-name", help: "pf-help", count: "pf-count", err: "pf-error", status: "pf-status" };

export function profilePage(ctl) {
  const body = h("div", { class: "profile__body" });
  const root = h("div", { class: "view profile", "data-core": "profile", "data-testid": "profile-page" }, pageHeader(coreText("pf.title")), body);

  const spinner = () => h("div", { class: "state state--loading", role: "status" }, h("span", { class: "spinner" }), "…");
  const loadFailed = (e) => h("div", { class: "state state--error", role: "alert", "data-testid": "profile-load-error" },
    h("h3", {}, coreText("pf.loadFailed")), h("p", {}, e.message), button(coreText("pf.retry"), { kind: "ghost", onClick: start, "data-testid": "profile-retry" }));

  function form(saved) {
    const ro = ctl.readOnly;
    let current = saved; // what the platform has
    const input = h("input", { class: "input", id: ID.name, name: "display_name", type: "text", autocomplete: "nickname", spellcheck: "false", autocapitalize: "off",
      "data-testid": "profile-name", "aria-describedby": `${ID.help} ${ID.count}`, readonly: ro, "aria-readonly": ro ? "true" : null, value: saved });
    const counter = h("span", { class: "profile__count", id: ID.count, "data-testid": "profile-count" });
    const error = h("p", { class: "field__error profile__error", id: ID.err, role: "alert", "data-testid": "profile-error" });
    const status = h("p", { class: "profile__status", id: ID.status, role: "status", "data-testid": "profile-status" });
    const save = button(coreText("pf.save"), { kind: "primary", type: "submit", "data-testid": "profile-save", disabled: ro });
    const clearBtn = button(coreText("pf.clear"), { kind: "ghost", "data-testid": "profile-clear", disabled: ro || saved === "", onClick: () => run("", clearBtn) });

    const setError = (msg) => {
      error.textContent = msg || "";
      if (msg) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", `${ID.help} ${ID.count} ${ID.err}`); }
      else { input.removeAttribute("aria-invalid"); input.setAttribute("aria-describedby", `${ID.help} ${ID.count}`); }
    };
    const paint = () => {
      const n = ctl.length(input.value);
      counter.textContent = coreText("pf.counter", { n, max: ctl.max });
      counter.setAttribute("aria-label", coreText("pf.counter.aria", { n, max: ctl.max }));
      counter.classList.toggle("is-over", n > ctl.max);
      clearBtn.disabled = ro || current === "";
    };
    async function run(raw, btn) {
      status.textContent = "";
      const v = ctl.validate(raw);
      if (!v.ok) { setError(v.message); input.focus(); return; }
      setError("");
      await busy(btn, async () => {
        const label = save.textContent;
        save.textContent = coreText("pf.saving");
        try {
          current = await ctl.save(v.value);
          if (!ctl.alive()) return;
          input.value = current; paint();
          const msg = current ? coreText("pf.saved", { name: current }) : coreText("pf.cleared");
          status.textContent = msg; toast(msg, "ok");
        } catch (e) {
          if (!ctl.alive()) return;
          setError(e.message); input.focus();
        } finally { save.textContent = label; }
      });
      paint(); // busy() re-enables the button it held; the state of Clear follows the saved name, not that
      if (raw === "" && ctl.alive() && !error.textContent) input.focus();
    }
    input.addEventListener("input", () => { status.textContent = ""; paint(); if (error.textContent) { const v = ctl.validate(input.value); setError(v.ok ? "" : v.message); } });
    paint();
    return h("form", { class: "profile__form", novalidate: true, "data-testid": "profile-form", onsubmit: (ev) => { ev.preventDefault(); if (!ro) run(input.value, save); } },
      h("div", { class: "field" },
        h("label", { class: "field__label", for: ID.name }, coreText("pf.label")), input,
        h("p", { class: "field__hint", id: ID.help, "data-testid": "profile-help" }, coreText("pf.help")),
        h("div", { class: "profile__meta" }, counter), error),
      h("p", { class: "field__hint" }, coreText("pf.fallback")),
      ro ? h("p", { class: "notice", "data-testid": "profile-readonly" }, coreText("pv.readOnly")) : "",
      h("div", { class: "profile__actions" }, save, clearBtn), status);
  }

  async function start() {
    body.replaceChildren(spinner());
    try {
      const name = await ctl.load();
      if (!ctl.alive()) return;
      body.replaceChildren(h("section", { class: "card" }, form(name)));
    } catch (e) {
      if (!ctl.alive()) return;
      body.replaceChildren(loadFailed(e));
    }
  }
  start();
  return root;
}

/** The one-time hint above the design history: text, a link and a dismiss button (both 44px tall through .btn). */
export function profileHint({ onDismiss }) {
  const box = h("aside", { class: "notice profile-hint", role: "region", "aria-label": coreText("pf.hint.aria"), "data-core": "profile-hint", "data-testid": "profile-hint" },
    h("p", { class: "profile-hint__text" }, coreText("pf.hint.text")),
    h("div", { class: "profile-hint__actions" },
      h("a", { class: "btn btn--primary", href: "#/profile", "data-testid": "profile-hint-go" }, coreText("pf.hint.go")),
      button(coreText("pf.hint.dismiss"), { kind: "ghost", "data-testid": "profile-hint-dismiss", onClick: () => { box.remove(); onDismiss(); } })));
  return box;
}
