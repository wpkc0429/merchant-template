// The stylesheet of the CORE dialogs (confirmations and the design review). It is adopted by a CLOSED shadow root (ui/kit.js showCoreDialog),
// so no selector, universal rule, ::before / ::after, filter, font or position rule of the design layer's CSS can reach what it draws, and it
// uses NO var() of the design tokens (a design can redefine those): every colour and size is a literal here. Generic font families only
// (a design can ship its own @font-face for a NAMED family, never for sans-serif / monospace). Text is never generated with `content`.
// Changing it is a core change (hash manifest). The class names match what ui/kit.js and ui/design-review.js build.
export const CORE_DIALOG_CSS = `
*, *::before, *::after { box-sizing: border-box; }
dialog { --ink: #1c1c1e; --soft: #3a3a3c; --muted: #636366; --card: #ffffff; --band: #ececee; --line: #c9c9cc; --err: #b3261e; --acc: #2f5d8a; --prim: #1c1c1e;
  border: 0; padding: 0; margin: auto; border-radius: 16px; background: var(--card); color: var(--ink); width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px);
  box-shadow: 0 24px 60px rgba(28, 28, 30, .3); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: normal; text-transform: none; text-indent: 0; word-spacing: normal; overflow: hidden; }
dialog::backdrop { background: rgba(28, 28, 30, .45); }
.dlg--wide { width: min(640px, calc(100vw - 32px)); }
.dlg--review { width: min(980px, calc(100vw - 32px)); height: min(900px, calc(100dvh - 32px)); }
[hidden] { display: none !important; }
.zprobe { position: absolute; left: 0; top: 0; width: 100px; height: 1px; visibility: hidden; pointer-events: none; }
p, h2, h3, dl, dd, ul, figure, pre { margin: 0; }
.dlg__body { padding: 22px; display: grid; gap: 14px; overflow-y: auto; max-height: calc(100dvh - 120px); }
.dlg--review .dlg__body { height: 100%; max-height: none; overflow: hidden; display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 14px; }
.dlg__title { font-weight: 600; font-size: 19px; line-height: 1.35; }
.dlg__msg { color: var(--soft); }
.dlg__foot { display: flex; gap: 10px; justify-content: flex-end; padding: 12px 22px 18px; }
.dlg__warning { display: block; padding: 10px 12px; border: 1px solid var(--err); border-radius: 8px; background: #f7e9e8; color: var(--ink); font-size: 14px; line-height: 1.55; margin-top: 8px; }
.dlg__msg:empty { display: none; }
.dlg__detail { margin-top: 10px; padding: 10px 12px; max-height: 40vh; overflow: auto; background: var(--band); border-radius: 8px; font: 13px/1.5 monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 22px; border-radius: 100px; border: 1px solid #8e8e93; background: transparent;
  color: var(--ink); font: inherit; font-size: 14px; white-space: nowrap; cursor: pointer; text-decoration: none; }
.btn:hover { border-color: var(--ink); }
.btn--primary { background: var(--prim); border-color: var(--prim); color: #fafafa; }
.btn--danger { background: var(--err); border-color: var(--err); color: #ffffff; }
.btn--danger-ghost { color: var(--err); border-color: #d6a09b; }
.btn--sm { min-height: 36px; padding: 0 14px; font-size: 13px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.is-busy { opacity: .6; cursor: progress; }
:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
.muted { color: var(--muted); }
.mono { font-family: monospace; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 100px; font-size: 12px; background: #e5e5e7; color: var(--soft); white-space: nowrap; }
.field { display: grid; gap: 6px; min-width: 0; }
.field__label { font-size: 12.5px; color: var(--muted); }
.input { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid #8e8e93; border-radius: 8px; background: #fff; color: var(--ink); font: inherit; font-size: 15px; }
.input--area { resize: vertical; min-height: 90px; line-height: 1.6; }
.notice { background: var(--band); border-radius: 8px; padding: 10px 14px; font-size: 14px; color: var(--soft); }
.check { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
.check input { width: 22px; height: 22px; accent-color: var(--prim); flex: none; }
.dlg-rv { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 10px; overflow-y: auto; }
.dlg-rv__main { flex: 1 1 auto; min-height: 260px; overflow-y: auto; display: grid; gap: 14px; align-content: start; padding-right: 4px; }
.dlg-rv__main h3 { font-size: 14px; font-weight: 600; margin-top: 4px; }
.dlg-rv__alert { background: #f7e9e8; border: 1px solid var(--err); border-radius: 8px; padding: 10px 14px; }
.dlg-rv__prompt { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--band); border-radius: 8px; padding: 10px 12px; max-height: 9em; overflow: auto; }
.dlg-rv__files ul { margin: 6px 0 0; padding-left: 18px; overflow-wrap: anywhere; font-size: 13px; }
.dlg-rv__files summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; }
.dlg-rv__rec { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; font-size: 14px; }
.dlg-rv__rec dt { color: var(--muted); } .dlg-rv__rec dd { overflow-wrap: anywhere; }
.dlg-rv__note { background: var(--band); border-left: 3px solid var(--acc); padding: 8px 12px; font-size: 14px; }
.dlg-rv__ctl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.dlg-rv__ctl .input { width: auto; max-width: 100%; }
.dlg-rv__tog { display: inline-flex; gap: 4px; margin-bottom: 8px; }
.dlg-rv__ctl .dlg-rv__tog { margin-bottom: 0; }
.dlg-rv__stage { max-height: 60vh; min-height: 180px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #e5e5e7; }
.dlg-rv__stage--side { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; padding: 8px; }
.dlg-rv__stage figure { min-width: 0; }
.dlg-rv__stage figcaption { font-size: 12.5px; color: var(--muted); padding-bottom: 4px; }
.dlg-rv__img { min-height: 60px; }
.dlg-rv__pic { display: block; width: 100%; height: auto; }
.dlg-rv__msg, .dlg-rv__skel { padding: 14px; }
.dlg-rv__cmp { position: relative; }
.dlg-rv__over { position: absolute; top: 0; left: 0; width: 100%; }
.dlg-rv__range { width: 100%; min-height: 44px; margin-top: 8px; accent-color: var(--prim); }
.dlg-rv__panel { flex: none; display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
.dlg-rv__btns.dlg__foot { padding: 0; flex-wrap: wrap; }
@media (max-width: 640px) {
  dialog { margin: auto 0 0; width: 100vw; max-width: 100vw; border-radius: 16px 16px 0 0; max-height: 92dvh; }
  .dlg__foot .btn { flex: 1; }
  .dlg--review { width: 100vw; max-width: 100vw; height: 94dvh; max-height: 94dvh; }
  .dlg--review .dlg__body { padding: 14px 14px 10px; }
  .dlg-rv__stage--side { grid-template-columns: 1fr; }
  .dlg-rv__stage { max-height: 52vh; }
  .btn--sm { min-height: 44px; }
}
`;
