// Builds the `ctx` object every design view receives. It exposes EXACTLY what lib/public-api.json lists
// (scripts/check-design.mjs and the core-side test compare the two) and nothing else: no tokens, no
// shop id, no network, no storage, no lib/ modules. The object is deeply frozen.
import { session } from "../lib/session.js";
import { can, canAny } from "../lib/perm.js";
import { navigate as routerNavigate } from "../lib/router.js";
import { t } from "../lib/design.js";
import { taipeiDate, addDays } from "../lib/dates.js";
import * as kit from "../ui/kit.js";
import { icon } from "../ui/icons.js";
import * as fmt from "../ui/format.js";
import { data, logic, enums } from "./data.js";
import { actions } from "./actions.js";

const UI = {
  h: kit.h, svg: kit.svg, append: kit.append, clear: kit.clear, $: kit.$, $$: kit.$$,
  button: kit.button, busy: kit.busy, toast: kit.toast, showDialog: kit.showDialog, confirmDialog: kit.confirmDialog,
  field: kit.field, setFieldError: kit.setFieldError, clearFieldErrors: kit.clearFieldErrors, applyFieldErrors: kit.applyFieldErrors,
  showFormError: kit.showFormError, input: kit.input, textarea: kit.textarea, select: kit.select, toggle: kit.toggle,
  badge: kit.badge, loading: kit.loading, emptyState: kit.emptyState, errorState: kit.errorState, pageHeader: kit.pageHeader,
  card: kit.card, dataTable: kit.dataTable, pager: kit.pager, segmented: kit.segmented, copyText: kit.copyText, icon,
};

const FORMAT = {
  money: fmt.formatMoney, number: fmt.formatNumber, range: fmt.formatRange, date: fmt.formatDate, dateTime: fmt.formatDateTime,
  parseInteger: fmt.parseInteger, isValidSlug: fmt.isValidSlug, slugify: fmt.slugify, taipeiDate, addDays,
};

const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) freeze(v); return Object.freeze(o); };
const STATIC = freeze({ ui: UI, format: FORMAT, data, logic, enums, actions });

/** nav: the permission-filtered destinations [{key, icon, href}]; auth: from core/auth.js; alive: view-token check. */
/** state: small plain data the shell passes to a screen (login notice, boot error text). */
export function makeContext({ routeId, params = {}, query = {}, state = {}, alive = () => true, nav = [], auth }) {
  const ctx = {
    route: { id: routeId, params: { ...params }, query: { ...query }, state: { ...state } },
    alive,
    t,
    can, canAny,
    navigate(path, opts) {
      const p = String(path);
      if (!p.startsWith("/") || p.startsWith("//")) { console.warn(`[design] navigate refused: ${p}`); return; }
      routerNavigate(p, { replace: Boolean(opts && opts.replace) });
    },
    scrollTop: () => window.scrollTo(0, 0),
    reload: () => location.reload(),
    asset(name) {
      if (!ASSET_RE.test(String(name))) { console.warn(`[design] asset name refused: ${name}`); return ""; }
      return new URL(`../design/assets/${name}`, import.meta.url).href;
    },
    errorMessage: kit.errorMessage,
    fieldErrors: kit.fieldErrors,
    session: Object.freeze({
      get shopName() { return session.shopName || ""; },
      get userEmail() { return session.user ? session.user.email : ""; },
      get userId() { return session.user ? session.user.id : 0; },
    }),
    nav: Object.freeze({ items: Object.freeze(nav.map((n) => Object.freeze({ key: n.key, icon: n.icon, href: n.href }))) }),
    auth: auth ? freeze(auth) : undefined,
    ...STATIC,
  };
  return Object.freeze(ctx);
}
