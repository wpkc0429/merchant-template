// The stylesheet of the CORE dialogs (confirmations and the design review). It is adopted by a CLOSED shadow root (ui/kit.js showCoreDialog),
// so no selector, universal rule, ::before / ::after, filter, font or position rule of the design layer's CSS can reach what it draws, and it
// reads the design tokens ONLY through the --k-* variables below: ui/kit.js (coreTheme) reads a fixed list of the design's tokens, VALIDATES them (opaque
// colours with enough contrast, small px radii, a generic font keyword) and writes the accepted values onto the dialog as --k-*; anything else falls back to
// the defaults in the dialog rule. So a branded design gets branded dialogs, but cannot make the text unreadable. Text is never generated with `content`.
// Changing it is a core change (hash manifest). The class names match what ui/kit.js and ui/design-review.js build.
export const CORE_DIALOG_CSS = `
*, *::before, *::after { box-sizing: border-box; }
dialog { --k-ink: #1c1c1e; --k-card: #ffffff; --k-err: #b3261e; --k-acc: #2f5d8a; --k-prim: #1c1c1e; --k-prim-text: #fafafa; --k-err-text: #ffffff; --k-rsm: 8px; --k-rlg: 16px;
  --k-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --k-soft: color-mix(in srgb, var(--k-ink) 85%, var(--k-card)); --k-muted: color-mix(in srgb, var(--k-ink) 70%, var(--k-card)); --k-band: color-mix(in srgb, var(--k-ink) 8%, var(--k-card));
  --k-line: color-mix(in srgb, var(--k-ink) 22%, var(--k-card)); --k-edge: color-mix(in srgb, var(--k-ink) 48%, var(--k-card)); --k-warnbg: color-mix(in srgb, var(--k-err) 9%, var(--k-card));
  --k-errline: color-mix(in srgb, var(--k-err) 45%, var(--k-card));
  border: 0; padding: 0; margin: auto; border-radius: var(--k-rlg); background: var(--k-card); color: var(--k-ink); width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px);
  box-shadow: 0 24px 60px rgba(28, 28, 30, .3); font-size: 15px; line-height: 1.6; font-family: var(--k-font); letter-spacing: normal; text-transform: none; text-indent: 0; word-spacing: normal; overflow: hidden; }
dialog::backdrop { background: rgba(28, 28, 30, .45); }
.dlg--wide { width: min(640px, calc(100vw - 32px)); }
.dlg--review { width: min(980px, calc(100vw - 32px)); height: min(900px, calc(100dvh - 32px)); }
[hidden] { display: none !important; }
.zprobe { position: absolute; left: 0; top: 0; width: 100px; height: 1px; visibility: hidden; pointer-events: none; }
p, h2, h3, dl, dd, ul, figure, pre { margin: 0; }
.dlg__body { padding: 22px; display: grid; gap: 14px; overflow-y: auto; max-height: calc(100dvh - 120px); }
.dlg--review .dlg__body { height: 100%; max-height: none; overflow: hidden; display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 14px; }
.dlg__title { font-weight: 600; font-size: 19px; line-height: 1.35; }
.dlg__msg { color: var(--k-soft); }
.dlg__foot { display: flex; gap: 10px; justify-content: flex-end; padding: 12px 22px 18px; }
.dlg__warning { color: var(--k-ink); font-weight: 600; }
.dlg-rv .dlg__warning { display: block; font-weight: 400; padding: 10px 12px; border: 1px solid var(--k-err); border-radius: var(--k-rsm); background: var(--k-warnbg); color: var(--k-ink); font-size: 14px; line-height: 1.55; margin-top: 8px; }
.dlg__msg:empty { display: none; }
.dlg__detail { margin-top: 10px; padding: 10px 12px; max-height: 40vh; overflow: auto; background: var(--k-band); border-radius: var(--k-rsm); font: 13px/1.5 monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 22px; border-radius: 100px; border: 1px solid var(--k-edge); background: transparent;
  color: var(--k-ink); font: inherit; font-size: 14px; white-space: nowrap; cursor: pointer; text-decoration: none; }
.btn:hover { border-color: var(--k-ink); }
.btn--primary { background: var(--k-prim); border-color: var(--k-prim); color: var(--k-prim-text); }
.btn--danger { background: var(--k-err); border-color: var(--k-err); color: var(--k-err-text); }
.btn--danger-ghost { color: var(--k-err); border-color: var(--k-errline); }
.btn--sm { min-height: 36px; padding: 0 14px; font-size: 13px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.is-busy { opacity: .6; cursor: progress; }
:focus-visible { outline: 2px solid var(--k-acc); outline-offset: 2px; }
.muted { color: var(--k-muted); }
.mono { font-family: monospace; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 100px; font-size: 12px; background: var(--k-band); color: var(--k-soft); white-space: nowrap; }
.field { display: grid; gap: 6px; min-width: 0; }
.field__label { font-size: 12.5px; color: var(--k-muted); }
.input { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid var(--k-edge); border-radius: var(--k-rsm); background: var(--k-card); color: var(--k-ink); font: inherit; font-size: 15px; }
.input--area { resize: vertical; min-height: 90px; line-height: 1.6; }
.notice { background: var(--k-band); border-radius: var(--k-rsm); padding: 10px 14px; font-size: 14px; color: var(--k-soft); }
.check { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
.check input { width: 22px; height: 22px; accent-color: var(--k-prim); flex: none; }
.dlg-rv { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 10px; overflow-y: auto; }
.dlg-rv__main { flex: 1 1 auto; min-height: 260px; overflow-y: auto; display: grid; gap: 14px; align-content: start; padding-right: 4px; }
.dlg-rv__main h3 { font-size: 14px; font-weight: 600; margin-top: 4px; }
.dlg-rv__alert { background: var(--k-warnbg); border: 1px solid var(--k-err); border-radius: var(--k-rsm); padding: 10px 14px; }
.dlg-rv__prompt { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--k-band); border-radius: var(--k-rsm); padding: 10px 12px; max-height: 9em; overflow: auto; }
.dlg-rv__files ul { margin: 6px 0 0; padding-left: 18px; overflow-wrap: anywhere; font-size: 13px; }
.dlg-rv__files summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; }
.dlg-rv__rec { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; font-size: 14px; }
.dlg-rv__rec dt { color: var(--k-muted); } .dlg-rv__rec dd { overflow-wrap: anywhere; }
.dlg-rv__note { background: var(--k-band); border-left: 3px solid var(--k-acc); padding: 8px 12px; font-size: 14px; }
.dlg-rv__ctl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.dlg-rv__ctl .input { width: auto; max-width: 100%; }
.dlg-rv__tog { display: inline-flex; gap: 4px; margin-bottom: 8px; }
.dlg-rv__ctl .dlg-rv__tog { margin-bottom: 0; }
.dlg-rv__stage { max-height: 60vh; min-height: 180px; overflow: auto; border: 1px solid var(--k-line); border-radius: var(--k-rsm); background: var(--k-band); }
.dlg-rv__stage--side { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; padding: 8px; }
.dlg-rv__stage figure { min-width: 0; }
.dlg-rv__stage figcaption { font-size: 12.5px; color: var(--k-muted); padding-bottom: 4px; }
.dlg-rv__img { min-height: 60px; }
.dlg-rv__pic { display: block; width: 100%; height: auto; }
.dlg-rv__msg, .dlg-rv__skel { padding: 14px; }
.dlg-rv__cmp { position: relative; }
.dlg-rv__over { position: absolute; top: 0; left: 0; width: 100%; }
.dlg-rv__range { width: 100%; min-height: 44px; margin-top: 8px; accent-color: var(--k-prim); }
.dlg-rv__panel { flex: none; display: grid; gap: 8px; border-top: 1px solid var(--k-line); padding-top: 10px; }
.dlg-rv__btns.dlg__foot { padding: 0; flex-wrap: wrap; }
@media (max-width: 640px) {
  dialog { margin: auto 0 0; width: 100vw; max-width: 100vw; border-radius: var(--k-rlg) var(--k-rlg) 0 0; max-height: 92dvh; }
  .dlg__foot .btn { flex: 1; }
  .dlg--review { width: 100vw; max-width: 100vw; height: 94dvh; max-height: 94dvh; }
  .dlg--review .dlg__body { padding: 14px 14px 10px; }
  .dlg-rv__stage--side { grid-template-columns: 1fr; }
  .dlg-rv__stage { max-height: 52vh; }
  .btn--sm { min-height: 44px; }
}
`;
