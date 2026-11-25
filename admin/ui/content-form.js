// The schema-driven CONTENT FORM BUILDER (core-owned). Given a platform content schema node (JSON Schema with the
// x-editor hints) and a value it builds the controls, reads the value back and validates it.
//
//   contentForm(schemaNode, value, opts)  -> {el, read(), validate(), setErrors(fields), focusFirstError()}
//   contentField(schemaNode, pointer, value, opts) -> {el, read(), validate(), setErrors(fields), pointer}
//
// The design layer controls LAYOUT only (opts.layout: groups of pointers, titles from copy, field order). It cannot
// change what a field accepts: validation is lib/content-schema.js, the same code core/content-actions.js runs again
// before every save. A required field the layout leaves out is APPENDED automatically (group "cf.group.required"),
// exactly like the product form's required title. `read()` never drops values the form does not render (it starts from
// the loaded value), so a layout that omits an optional field cannot erase it.
//
// Everything is built with ui/kit.js h() (no innerHTML); labels, help and descriptions are plain text. Network access
// is injected: opts.upload(file, {onStage, onProgress}) -> Promise<{url}> (core/context.js binds the core upload action).
import { t } from "../lib/design.js";
import { h, button, field, setFieldError, input as inputEl, textarea as textareaEl, select as selectEl, toggle } from "./kit.js";
import * as S from "../lib/content-schema.js";

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function setAt(obj, pointer, value) {
  const segs = S.splitPointer(pointer);
  if (!segs.length) return value;
  let cur = obj;
  segs.slice(0, -1).forEach((seg, i) => {
    if (cur[seg] === null || typeof cur[seg] !== "object") cur[seg] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[seg];
  });
  cur[segs[segs.length - 1]] = value;
  return obj;
}

const lastSeg = (ptr) => S.splitPointer(ptr).slice(-1)[0] ?? "";

/** Builds one control. Returns {el, ptr, read(), setPtr(p), setError(msg), walk(cb)} (walk visits this and nested controls). */
function build(node, ptr, value, env, extra = {}) {
  const n = S.deref(node, env.root) || {};
  const kind = S.kindOf(n, env.root);
  const label = n.title || extra.label || lastSeg(ptr);
  const required = Boolean(extra.required);
  const help = n["x-help"] || n.description || "";
  const testid = () => `cf:${ctl.ptr}`;
  const ctl = { ptr, node: n, kind, children: [] };
  ctl.walk = (cb) => { cb(ctl); for (const c of ctl.children) c.walk(cb); };

  // ── leaves that wrap one native control ──
  const leaf = (control, { read, set, hint } = {}) => {
    const wrap = field(label, control, { hint: hint ?? (help || undefined), pointer: ptr });
    if (required) wrap.classList.add("field--required");
    control.dataset.testid = testid();
    ctl.el = wrap;
    ctl.read = read || (() => control.value);
    ctl.setError = (msg) => setFieldError(wrap, msg);
    ctl.setPtr = (p) => { ctl.ptr = p; wrap.dataset.pointer = p; control.dataset.testid = testid(); set?.(p); };
    return ctl;
  };

  switch (kind) {
    case "text": return leaf(inputEl({ value: value ?? "", autocomplete: "off", disabled: env.readOnly }));
    case "textarea": return leaf(textareaEl({ value: value ?? "", rows: 4, disabled: env.readOnly }));
    case "select": {
      const vals = Array.isArray(n.enum) ? n.enum.map(String) : [];
      const cur = String(value ?? "");
      const opts = (vals.includes(cur) || cur === "" ? vals : [cur, ...vals]).map((v) => ({ value: v, label: v }));
      return leaf(selectEl(opts, cur, { disabled: env.readOnly }));
    }
    case "link": return leaf(inputEl({ value: value ?? "", type: "text", inputmode: "url", autocomplete: "off", placeholder: "https://…", disabled: env.readOnly }));
    case "color": {
      const txt = inputEl({ value: value ?? "", autocomplete: "off", placeholder: "#RRGGBB", disabled: env.readOnly });
      const pick = h("input", { type: "color", "aria-label": t("cf.color.pick"), value: S.colorOK(value) && value ? value : "#000000", disabled: env.readOnly });
      pick.addEventListener("input", () => { txt.value = pick.value; });
      txt.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(txt.value)) pick.value = txt.value; });
      const c = leaf(txt, { read: () => txt.value });
      txt.after(pick); // field() put the text input in the label; the picker sits beside it
      return c;
    }
    case "integer": case "number": {
      const inp = inputEl({ type: "number", value: value ?? "", step: kind === "integer" ? "1" : "any", inputmode: "decimal", disabled: env.readOnly });
      if (n.minimum !== undefined) inp.min = String(n.minimum);
      if (n.maximum !== undefined) inp.max = String(n.maximum);
      return leaf(inp, { read: () => (inp.value === "" ? null : Number(inp.value)) });
    }
    case "boolean": {
      const sw = toggle(label, Boolean(value), { hint: help || undefined });
      sw.input.dataset.testid = testid();
      ctl.el = h("div", { class: "field", "data-pointer": ptr }, sw.el, h("span", { class: "field__error", role: "alert" }));
      ctl.read = () => sw.input.checked;
      ctl.setError = (msg) => setFieldError(ctl.el, msg);
      ctl.setPtr = (p) => { ctl.ptr = p; ctl.el.dataset.pointer = p; sw.input.dataset.testid = testid(); };
      return ctl;
    }
    case "richtext": return richtext(ctl, { label, help, ptr, value, required, env, testid });
    case "image": return image(ctl, { label, help, ptr, value, required, env, testid });
    case "object": return objectControl(ctl, { label, ptr, value, env, group: !extra.bare, skip: extra.skip || [], fixed: extra.fixed });
    case "list": case "sections": return listControl(ctl, { label, help, ptr, value, env, kind, required });
    default: return leaf(inputEl({ value: String(value ?? "") }));
  }
}

// ── rich text: a plain textarea (HTML source) plus a small toolbar. The server rewrites the markup to its allowlist. ──
function richtext(ctl, { label, help, ptr, value, required, env, testid }) {
  const ta = textareaEl({ value: value ?? "", rows: 8, spellcheck: "false", disabled: env.readOnly });
  const wrapSel = (open, close) => {
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    ta.value = v.slice(0, a) + open + v.slice(a, b) + close + v.slice(b);
    ta.focus();
    ta.setSelectionRange(a + open.length, b + open.length);
  };
  const tools = [
    ["cf.rich.bold", "<strong>", "</strong>"], ["cf.rich.italic", "<em>", "</em>"], ["cf.rich.h2", "<h2>", "</h2>"], ["cf.rich.h3", "<h3>", "</h3>"],
    ["cf.rich.list", "<ul>\n<li>", "</li>\n</ul>"], ["cf.rich.link", '<a href="https://">', "</a>"],
  ];
  const bar = h("div", { class: "cf-rich__bar" }, tools.map(([k, o, c]) => button(t(k), { small: true, disabled: env.readOnly, onClick: () => wrapSel(o, c) })));
  const rich = h("div", { class: "cf-rich" }, bar, ta);
  const wrap = field(label, rich, { hint: help || t("cf.rich.hint"), pointer: ptr });
  if (required) wrap.classList.add("field--required");
  ta.dataset.testid = testid();
  ctl.el = wrap;
  ctl.read = () => ta.value;
  ctl.setError = (msg) => setFieldError(wrap, msg);
  ctl.setPtr = (p) => { ctl.ptr = p; wrap.dataset.pointer = p; ta.dataset.testid = `cf:${p}`; };
  return ctl;
}

// ── image: URL (validated against the image domain) + upload through the core ──
function image(ctl, { label, help, ptr, value, required, env, testid }) {
  const url = inputEl({ value: value ?? "", autocomplete: "off", placeholder: "https://…", disabled: env.readOnly });
  const preview = h("img", { class: "cf-image__preview", alt: "", hidden: true });
  const status = h("span", { class: "field__hint", "data-testid": "cf-image-status" });
  const refresh = () => {
    const v = url.value.trim();
    if (v && S.imageOK(v, env.imagePrefix)) { preview.src = v; preview.hidden = false; } else { preview.removeAttribute("src"); preview.hidden = true; }
  };
  url.addEventListener("input", refresh);
  const file = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/heic,image/heif", hidden: true, "data-testid": "cf-image-file" });
  const upBtn = button(t("cf.image.upload"), { small: true, disabled: env.readOnly || !env.upload, "data-testid": "cf-image-upload", onClick: () => file.click() });
  const clearBtn = button(t("cf.image.remove"), { small: true, disabled: env.readOnly, onClick: () => { url.value = ""; refresh(); } });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f || !env.upload) return;
    upBtn.disabled = true;
    try {
      const r = await env.upload(f, {
        onStage: (s) => { status.textContent = t(`cf.image.${s}`); },
        onProgress: (p) => { status.textContent = `${t("cf.image.uploading")} ${Math.round(p * 100)}%`; },
      });
      url.value = r.url;
      refresh();
      status.textContent = t("cf.image.done");
    } catch (e) {
      status.textContent = e && e.message ? String(e.message) : t("cf.image.failed");
    } finally { upBtn.disabled = false; }
  });
  refresh();
  const box = h("div", { class: "cf-image" }, url, preview, h("div", { class: "cf-image__bar" }, upBtn, clearBtn, file, status));
  const wrap = field(label, box, { hint: help || undefined, pointer: ptr });
  if (required) wrap.classList.add("field--required");
  url.dataset.testid = testid();
  ctl.el = wrap;
  ctl.read = () => url.value.trim();
  ctl.setError = (msg) => setFieldError(wrap, msg);
  ctl.setPtr = (p) => { ctl.ptr = p; wrap.dataset.pointer = p; url.dataset.testid = `cf:${p}`; };
  return ctl;
}

// ── objects ──
function objectControl(ctl, { label, ptr, value, env, group, skip, fixed }) {
  const n = ctl.node;
  const val = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const body = h("div", { class: "cf-object__body", style: { display: "grid", gap: "12px" } });
  const slot = h("div", { class: "field__error", role: "alert" });
  for (const [key, sub] of S.orderedProps(n, env.root)) {
    if (skip.includes(key)) continue;
    const child = build(sub, S.joinPointer(ptr, key), val[key] !== undefined ? val[key] : S.defaultValue(sub, env.root), env, { required: S.isRequired(n, key, env.root) });
    ctl.children.push(child);
    child.key = key;
    body.append(child.el);
  }
  ctl.el = group ? h("fieldset", { class: "cf-object", "data-pointer": ptr }, h("legend", {}, label), body, slot) : h("div", { class: "cf-object cf-object--bare", "data-pointer": ptr }, body, slot);
  ctl.read = () => {
    const out = { ...clone(val), ...(fixed || {}) };
    for (const c of ctl.children) out[c.key] = c.read();
    return out;
  };
  ctl.setError = (msg) => { slot.textContent = msg || ""; ctl.el.classList.toggle("has-error", Boolean(msg)); };
  ctl.setPtr = (p) => { ctl.ptr = p; ctl.el.dataset.pointer = p; for (const c of ctl.children) c.setPtr(S.joinPointer(p, c.key)); };
  return ctl;
}

// ── arrays: list (any item type) and sections (block union) ──
function listControl(ctl, { label, help, ptr, value, env, kind, required }) {
  const n = ctl.node;
  const items = S.deref(n.items, env.root) || {};
  const branches = kind === "sections" ? S.sectionBranches(n, env.root) : [];
  const max = n.maxItems ?? 200;
  const list = h("div", { class: "cf-list" });
  const slot = h("div", { class: "field__error", role: "alert" });
  const rows = []; // {ctl, el, branch}
  const addBar = h("div", { class: "cf-add" });
  const typeSel = kind === "sections" && branches.length ? selectEl(branches.map((b) => ({ value: b.type, label: b.node.title || b.type })), branches[0].type, { "data-testid": `cf-add-type:${ptr}`, disabled: env.readOnly }) : null;

  const renumber = () => {
    rows.forEach((r, i) => {
      r.ctl.setPtr(S.joinPointer(ctl.ptr, i));
      r.title.textContent = r.branch ? `${r.branch.node.title || r.branch.type} · #${i + 1}` : t("cf.list.item", { n: i + 1 });
      r.up.disabled = env.readOnly || i === 0;
      r.down.disabled = env.readOnly || i === rows.length - 1;
    });
    addBtn.disabled = env.readOnly || rows.length >= max;
    addBtn.title = rows.length >= max ? t("cf.err.maxItems", { n: max }) : "";
  };
  const addRow = (itemValue, branch) => {
    const node = branch ? branch.node : items;
    const i = rows.length;
    const c = build(node, S.joinPointer(ctl.ptr, i), itemValue, env, { bare: true, skip: branch ? ["type"] : [], fixed: branch ? { type: branch.type } : null, label: t("cf.list.item", { n: i + 1 }), required: true });
    const title = h("span", { class: "cf-item__title" });
    const up = button(t("cf.list.up"), { small: true, "data-testid": "cf-item-up", onClick: () => move(row, -1) });
    const down = button(t("cf.list.down"), { small: true, "data-testid": "cf-item-down", onClick: () => move(row, 1) });
    const del = button(t("cf.list.remove"), { small: true, kind: "danger-ghost", disabled: env.readOnly, "data-testid": "cf-item-remove", onClick: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); renumber(); } });
    const el = h("div", { class: "cf-item", "data-testid": "cf-item" }, h("div", { class: "cf-item__bar" }, title, h("div", { class: "cf-item__tools" }, up, down, del)), c.el);
    const row = { ctl: c, el, title, up, down, branch };
    rows.push(row);
    list.append(el);
  };
  const move = (row, delta) => {
    const i = rows.indexOf(row), j = i + delta;
    if (j < 0 || j >= rows.length) return;
    rows.splice(i, 1);
    rows.splice(j, 0, row);
    list.replaceChildren(...rows.map((r) => r.el));
    renumber();
  };
  const addBtn = button(t(kind === "sections" ? "cf.sections.add" : "cf.list.add"), { small: true, kind: "ghost", "data-testid": `cf-add:${ptr}`, onClick: () => {
    if (rows.length >= max) return;
    if (kind === "sections") {
      const br = branches.find((b) => b.type === typeSel.value) || branches[0];
      if (br) addRow(S.defaultValue(br.node, env.root), br);
    } else addRow(S.defaultValue(items, env.root), null);
    renumber();
  } });
  (Array.isArray(value) ? value : []).forEach((v) => {
    if (kind === "sections") { const br = branches.find((b) => b.type === v?.type); if (br) addRow(v, br); } else addRow(v, null);
  });
  addBar.append(...(typeSel ? [typeSel] : []), addBtn);
  const legend = h("legend", { class: "cf-group__title" }, label);
  ctl.el = h("fieldset", { class: "cf-group", "data-pointer": ptr }, legend, help ? h("p", { class: "cf-group__desc" }, help) : "", list, addBar, slot);
  if (required) ctl.el.classList.add("field--required");
  // Children are the rows' controls, rebuilt on demand so walk() always sees the current order.
  Object.defineProperty(ctl, "children", { get: () => rows.map((r) => r.ctl) });
  ctl.read = () => rows.map((r) => r.ctl.read());
  ctl.setError = (msg) => { slot.textContent = msg || ""; ctl.el.classList.toggle("has-error", Boolean(msg)); };
  ctl.setPtr = (p) => { ctl.ptr = p; ctl.el.dataset.pointer = p; renumber(); };
  renumber();
  return ctl;
}

// ── public API ──────────────────────────────────────────────────────────
function envOf(schemaNode, opts = {}) {
  return { root: schemaNode, imagePrefix: opts.imagePrefix || "", upload: opts.upload || null, readOnly: Boolean(opts.readOnly) };
}

/** Applies {pointer: message} to the controls; a message for an unknown pointer lands on the nearest ancestor control. Returns the unplaced messages. */
function applyErrors(all, fields) {
  const byPtr = new Map(all.map((c) => [c.ptr, c]));
  for (const c of all) c.setError?.("");
  const unplaced = [];
  for (const [ptr, msg] of Object.entries(fields || {})) {
    let p = ptr;
    let target = byPtr.get(p);
    while (!target && p) { p = p.slice(0, p.lastIndexOf("/")); target = byPtr.get(p); }
    if (target && target.setError) target.setError(msg); else unplaced.push(msg);
  }
  return unplaced;
}

/**
 * opts: {layout, imagePrefix, upload, readOnly}. layout = [{title?, description?, fields: ["/hero", "/hero/title", ...]}]
 * (pointers into the content; array indexes are not addressable). Without a layout every top-level property is shown in
 * editor order. Required fields the layout omits are appended in an extra group.
 */
export function contentForm(schemaNode, value, opts = {}) {
  const env = envOf(schemaNode, opts);
  const root = S.deref(schemaNode, schemaNode) || {};
  const base = S.hydrate(root, value, root);
  const top = []; // controls placed in the form
  const placed = (ptr) => top.some((c) => c.ptr === ptr);
  const covered = (ptr) => top.some((c) => c.ptr === ptr || ptr.startsWith(`${c.ptr}/`) || c.ptr.startsWith(`${ptr}/`));
  const make = (ptr) => {
    const node = S.nodeAt(root, ptr);
    if (!node || ptr === "" || placed(ptr) || top.some((c) => ptr.startsWith(`${c.ptr}/`))) return null;
    const parentPtr = ptr.slice(0, ptr.lastIndexOf("/"));
    const parent = S.nodeAt(root, parentPtr);
    const key = lastSeg(ptr);
    const c = build(node, ptr, S.getAt(base, ptr) ?? S.defaultValue(node, root), env, { required: Boolean(parent && S.isRequired(parent, key, root)) });
    c.key = key;
    top.push(c);
    return c;
  };
  const el = h("div", { class: "cf", "data-testid": "content-form" });
  const groups = Array.isArray(opts.layout) && opts.layout.length
    ? opts.layout
    : [{ fields: S.orderedProps(root, root).map(([k]) => S.joinPointer("", k)) }];
  const addGroup = (g, fallbackTitle) => {
    const kids = [];
    for (const ptr of g.fields || []) { const c = make(ptr); if (c) kids.push(c.el); }
    if (!kids.length) return;
    el.append(h("fieldset", { class: "cf-group" }, g.title || fallbackTitle ? h("legend", { class: "cf-group__title" }, g.title || fallbackTitle) : "", g.description ? h("p", { class: "cf-group__desc" }, g.description) : "", ...kids));
  };
  for (const g of groups) addGroup(g);
  // A required field cannot be left out of the form, whatever the layout says.
  const missing = S.requiredPointers(root).filter((p) => !covered(p));
  if (missing.length) addGroup({ fields: missing }, t("cf.group.required"));

  const all = () => { const out = []; for (const c of top) c.walk((x) => out.push(x)); return out; };
  const read = () => {
    const out = clone(base);
    for (const c of top) setAt(out, c.ptr, c.read());
    return out;
  };
  const errorBox = h("div", { class: "cf-error-summary", role: "alert", hidden: true, "data-testid": "cf-error-summary" });
  el.prepend(errorBox);
  const show = (errs) => {
    const unplaced = applyErrors(all(), errs);
    errorBox.hidden = !Object.keys(errs).length;
    errorBox.textContent = Object.keys(errs).length ? [t("cf.errorSummary"), ...unplaced].join("　") : "";
    return unplaced;
  };
  return {
    el,
    read,
    /** Runs the locked validation and shows the errors on the fields. {ok, errors}. */
    validate() {
      const errors = S.validate(root, read(), env);
      show(errors);
      return { ok: Object.keys(errors).length === 0, errors };
    },
    /** Shows {pointer: message} (a 422 mapped by the core, or errors from validate()). Returns the messages that found no field. */
    setErrors(fields) { return show(fields || {}); },
    focusFirstError() {
      const f = el.querySelector(".field.has-error input, .field.has-error textarea, .field.has-error select");
      if (f) { f.focus(); f.scrollIntoView?.({ block: "center" }); }
    },
  };
}

/** One field by pointer (for a design that lays out every field itself). `value` is the WHOLE content; the field reads its own part. */
export function contentField(schemaNode, pointer, value, opts = {}) {
  const env = envOf(schemaNode, opts);
  const root = S.deref(schemaNode, schemaNode) || {};
  const node = S.nodeAt(root, pointer);
  if (!node) return { el: h("span", {}), read: () => undefined, validate: () => ({ ok: true, errors: {} }), setErrors: () => [], pointer };
  const parent = S.nodeAt(root, pointer.slice(0, pointer.lastIndexOf("/")));
  const base = S.hydrate(root, value, root);
  const c = build(node, pointer, S.getAt(base, pointer) ?? S.defaultValue(node, root), env, { required: Boolean(parent && S.isRequired(parent, lastSeg(pointer), root)) });
  const all = () => { const out = []; c.walk((x) => out.push(x)); return out; };
  return {
    el: c.el, pointer,
    read: () => c.read(),
    validate() { const errors = S.validate(node, c.read(), env, pointer); applyErrors(all(), errors); return { ok: Object.keys(errors).length === 0, errors }; },
    setErrors: (fields) => applyErrors(all(), fields || {}),
  };
}
