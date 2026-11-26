// Version preview of one past published design (route id designVersionPreview, /design/:id/version-preview, needs design.view).
// The history screens embed the same section (parts/version-preview-section.js) next to each past design. Everything that matters
// (permission, the platform's 409/429 answers, the fixed limits text, "revert" only for design.revert) is the core's; this file draws.
import { versionPreviewSection } from "../parts/version-preview-section.js";

export default async function designVersionPreview(root, ctx) {
  const { pageHeader, card } = ctx.ui;
  const requestId = ctx.route.params.id;
  root.append(
    pageHeader(ctx.t("vp.title"), { eyebrow: ctx.t("vp.eyebrow") }),
    card(versionPreviewSection(ctx, { requestId })));
}
