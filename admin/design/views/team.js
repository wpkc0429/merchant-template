// Team (owner only): shop members, invitations, invite / revoke, disable / enable.
// There is no e-mail delivery yet, so a new invitation shows its one-time link with a copy button;
// once the API reports delivery:"email" the link is not returned and we say the mail was sent.
// The core enforces who may be invited / disabled and asks the confirmation for every irreversible step.
const KNOWN_ROLES = ["merchant_owner", "staff", "editor"];

export default async function team(root, ctx) {
  const { h, clear, pageHeader, button, input, select, field, applyFieldErrors, setFieldError, toast, showDialog, dataTable, loading, errorState, emptyState, badge, card, copyText } = ctx.ui;
  const { t, data, logic, format, actions, errorMessage } = ctx;

  const roleLabel = (name) => (KNOWN_ROLES.includes(name) ? t(`team.role.${name}`) : name);
  const ERR_INVITE = { 409: t("team.err.invite409"), 422: t("team.err.invite422"), 403: t("team.err.invite403") };
  const ERR_TOGGLE = { 403: t("team.err.toggle403"), 409: t("team.err.toggle409"), 404: t("team.err.toggle404") };

  const membersBox = h("div", { class: "list-area" });
  const invitesBox = h("div", { class: "list-area" });
  let roles = [];
  root.append(
    pageHeader(t("team.title"), { eyebrow: "TEAM", actions: button(t("team.invite"), { kind: "primary", "data-testid": "invite-open", onClick: openInvite }) }),
    card(h("div", { class: "card__head" }, h("h2", {}, t("team.members.title"))), membersBox),
    card(h("div", { class: "card__head" }, h("h2", {}, t("team.invites.title"))), invitesBox));

  async function loadMembers() {
    clear(membersBox).append(loading());
    let list;
    try { list = await data.listTeam(); } catch (e) { if (ctx.alive()) clear(membersBox).append(errorState(e, loadMembers)); return; }
    if (!ctx.alive()) return;
    clear(membersBox).append(dataTable({
      rows: list,
      rowAttrs: (m) => ({ "data-testid": "team-row", "data-email": m.email }),
      empty: emptyState(t("team.members.empty")),
      columns: [
        { label: t("team.col.member"), primary: true, render: (m) => h("strong", {}, m.email, m.user_id === ctx.session.userId ? h("em", { class: "chip" }, t("team.you")) : "") },
        { label: t("team.col.role"), render: (m) => (m.roles || []).map((r) => roleLabel(r.name)).join("、") || "—" },
        { label: t("team.col.status"), render: (m) => (m.membership_status === 1 ? badge(t("status.enabled"), "ok") : badge(t("status.disabled"), "bad")) },
        { label: "", class: "col-actions", render: (m) => {
          const why = logic.blockedReason(m, ctx.session.userId);
          const active = m.membership_status === 1;
          return button(active ? t("team.disable") : t("team.enable"), { small: true, kind: active ? "danger-ghost" : "ghost", "data-testid": active ? "member-disable" : "member-enable", disabled: Boolean(why), title: why ? t(`memberBlocked.${why}`) : null, onClick: () => toggleMember(m, active) });
        } },
      ],
    }));
  }

  async function toggleMember(m, active) {
    try {
      const r = await actions.setMemberActive(m.user_id, !active);
      if (r.cancelled) return;
      toast(active ? t("team.toast.disabled") : t("team.toast.enabled"));
      await loadMembers();
    } catch (e) { toast(errorMessage(e, ERR_TOGGLE), "error"); }
  }

  async function loadInvites() {
    clear(invitesBox).append(loading());
    let list;
    try { list = await data.listInvitations(); } catch (e) { if (ctx.alive()) clear(invitesBox).append(errorState(e, loadInvites)); return; }
    if (!ctx.alive()) return;
    const now = Date.now();
    clear(invitesBox).append(dataTable({
      rows: list,
      rowAttrs: (i) => ({ "data-testid": "invite-row", "data-email": i.email }),
      empty: emptyState(t("team.invites.empty"), t("team.invites.emptyHint")),
      columns: [
        { label: "Email", primary: true, render: (i) => h("strong", {}, i.email) },
        { label: t("team.col.role"), render: (i) => roleLabel(i.role_name) },
        { label: t("team.col.expires"), render: (i) => (new Date(i.expires_at) < now ? badge(t("team.expired"), "warn") : t("team.validUntil", { when: format.dateTime(i.expires_at) })) },
        { label: "", class: "col-actions", render: (i) => button(t("team.revoke"), { small: true, kind: "danger-ghost", "data-testid": "invite-revoke", onClick: () => revoke(i) }) },
      ],
    }));
  }

  async function revoke(i) {
    try {
      const r = await actions.revokeInvitation(i.id);
      if (r.cancelled) return;
      toast(t("team.toast.revoked"));
      await loadInvites();
    } catch (e) { toast(errorMessage(e, { 404: t("err.inviteGone") }), "error"); await loadInvites(); }
  }

  async function openInvite() {
    if (!roles.length) {
      try { roles = await data.listRoles(); } catch (e) { toast(errorMessage(e), "error"); return; }
    }
    const assignable = roles.filter((r) => r.merchant_assignable);
    const email = input({ type: "email", placeholder: "name@example.com", autocomplete: "off", "data-testid": "invite-email" });
    const role = select(assignable.map((r) => ({ value: r.id, label: roleLabel(r.name) })), (assignable.find((r) => r.name === "staff") || assignable[0] || {}).id);
    role.dataset.testid = "invite-role";
    const wEmail = field("Email", email, { pointer: "/email" });
    const wRole = field(t("team.invite.role"), role, { pointer: "/role" });
    const content = h("div", { class: "form" }, wEmail, wRole, h("p", { class: "field__hint" }, t("team.invite.hint")));
    showDialog({
      title: t("team.invite.title"),
      content,
      actions: [{ label: t("common.cancel"), kind: "ghost" }, { label: t("team.invite.send"), kind: "primary", testid: "invite-send", onClick: async () => {
        setFieldError(wEmail, ""); setFieldError(wRole, "");
        let res;
        try { res = await actions.inviteMember({ email: email.value, roleId: role.value }); } catch (e) {
          if (e.fields) applyFieldErrors(content, e.fields); else toast(errorMessage(e, ERR_INVITE), "error");
          return false;
        }
        await loadInvites();
        setTimeout(() => showLink(email.value.trim(), res), 0);
      } }],
    });
    email.focus();
  }

  function showLink(addr, res) {
    // Look at `delivery` first (not at whether a URL happens to be present).
    if (res.delivery === "email") {
      showDialog({ title: t("team.sent.title"), content: h("p", { class: "dlg__msg", "data-testid": "invite-sent" }, t("team.sent.text", { email: addr })), actions: [{ label: t("team.done"), kind: "primary" }] });
      return;
    }
    const link = input({ value: res.invite_url || "", readonly: true, "data-testid": "invite-link", "aria-label": t("team.link.aria") });
    link.addEventListener("focus", () => link.select());
    showDialog({
      title: t("team.link.title"),
      content: h("div", { class: "form" },
        h("p", { class: "dlg__msg" }, t("team.link.text", { email: addr })),
        h("p", { class: "notice" }, t("team.link.once")),
        link),
      actions: [
        { label: t("team.link.copy"), kind: "ghost", testid: "invite-copy", close: false, onClick: async () => { toast((await copyText(link.value)) ? t("team.link.copied") : t("team.link.copyFailed"), "ok"); return false; } },
        { label: t("team.done"), kind: "primary" },
      ],
    });
  }

  await Promise.all([loadMembers(), loadInvites()]);
}
