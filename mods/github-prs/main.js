// GitHub PRs: what needs your attention, in the status bar; a hover card with every PR involving
// you. Click a PR to open it in a browser, a terminal or a coding agent, in the folder where its
// branch is checked out (a worktree is made when there's none). Worktrees of finished PRs are
// offered for cleanup. Data comes from helpers/prs.sh (your own `gh` login); no token is read here.
//
// The same mod is also the click menu: opened as a popup, `props().pr` is set and it draws that.
import { View, div, svg, image } from "gpui-kit";
import { Avatar, AvatarFallback, AvatarImage, Popover, Input, InputState, h_flex, v_flex } from "gpui-base";
import { exec, theme, appHome, props, shared, setShared, openOverlay, closeOverlay, knownAgents, pickFolder } from "herdr";
import { parseList, summarize } from "./lib/model.js";
import { KEY_ACTIVE, KEY_PREFS, currentLogin, finishedWorktrees, gh, openPr, prefs, removeWorktree, rootsOf, setRoots } from "./lib/actions.js";

const MOD = "github-prs";
const avatarPath = (login) => `data/${MOD}/avatars/${login}.png`;
const KEY_REQ = `${MOD}.request`;  // the click menu asks the bar (which lives on) to do the work
const KEY_BEAT = `${MOD}.menu-beat`;
const KNOWN_AGENTS = "new-menu.agents"; // what Herdr's own new-tab menu last found, per machine ("" = this one)
const EVERY_CHOICES = [1, 3, 5, 10, 30]; // minutes between fetches, as offered in settings
const COOLDOWN = 15 * 1000;    // ms, manual refresh
const PANEL_W = 600;
const MENU_W = 260;
const CARD_INSET = 12;          // card padding (10) + border (1) + row margin (1): row left edge → card left edge
const menuHeight = (agents) => Math.min(491, 90 + (2 + agents) * 31); // browser + terminal rows, then the agents
const MAX_LIST_H = 640;        // px; the list scrolls past this (a mod can't read the window height)
const HEAD_H = 24, ROW_H = 46, SECTION_GAP = 21; // estimates that size the list to its rows
const OPEN_DELAY = 350;        // ms, so passing over the bar doesn't flash the card
const CLOSE_DELAY = 300;       // ms, lets the pointer cross from the bar to the card

const pill = (text, color, t) => div().flex_none().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_size(10).text_color(color).child(text);
const ciColor = (ci, t) => ({ SUCCESS: t.ansi2 ?? t.done, FAILURE: t.ansi1 ?? t.blocked, ERROR: t.ansi1 ?? t.blocked, PENDING: t.ansi3 ?? t.done, EXPECTED: t.ansi3 ?? t.done })[ci] ?? t.border;
const rule = (t) => div().h(1).bg(t.border).flex_none();
const iconButton = (id, icon, label, onClick, t, enabled = true) =>
  div().id(id).size(24).rounded(5).flex().items_center().justify_center().tooltip(label)
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
    .child(svg(`mods/${MOD}/icons/${icon}.svg`).size(14).text_color(enabled ? t.muted : t.dim));

export default class GithubPrs extends View {
  init(_props, cx) {
    if (props()?.pr) return this.initMenu(cx);
    this.top = props()?.anchor === "top"; // layout prop: the block sits in the top bar, so everything opens downward
    this.reply = null;     // last raw GraphQL reply, so filter edits re-apply without a fetch
    this.avatars = new Set(); // logins whose avatar file exists
    this.accounts = [];    // gh logins on github.com, active first
    this.data = null;      // { review, mine, other, fix } once a fetch worked
    this.finished = [];    // worktrees we made whose PR is merged or closed
    this.error = null;     // last failure, shown dim; the old data stays
    this.busy = false;
    this.fetchedAt = 0;
    this.panel = "list";   // or "settings"
    this.open = false;     // is the card showing (we drive a Popover by hand: a HoverCard can't be held open)
    this.over = { trigger: false, card: false };
    this.seq = 0;          // bumps on every hover change, so stale timers do nothing
    this.pinMenu = false;  // the click menu is open: the card stays until something is picked
    // Comma-separated "org" or "org/repo" lists; saved as you type.
    const list = (key) => {
      const st = InputState.new({ placeholder: "acme, acme/widgets", value: prefs()[key].join(", ") });
      st.on("change", () => { setShared(KEY_PREFS, { ...prefs(), [key]: parseList(st.value()) }); this.apply(); cx.notify(); });
      return st;
    };
    this.includeInput = list("include");
    this.excludeInput = list("exclude");
    this.seenReq = shared(KEY_REQ)?.at ?? 0;
    this.fetch(cx);
    cx.timer.every(60 * 1000, (cx) => { if (Date.now() - this.fetchedAt >= prefs().everyMin * 60 * 1000) this.fetch(cx); });
  }

  // Card visibility: open after resting on the chip, close shortly after the pointer leaves both
  // chip and card, but never while the click menu or the settings panel is up.
  touch(cx) {
    const seq = ++this.seq;
    const over = () => this.over.trigger || this.over.card;
    if (over() && !this.open) {
      cx.timer.after(OPEN_DELAY, (cx) => { if (seq === this.seq && over()) { this.open = true; cx.notify(); } });
    } else if (!over() && this.open) {
      const tryClose = (cx) => {
        if (seq !== this.seq || over()) return;
        if (this.menuUp() || this.panel !== "list") return cx.timer.after(600, tryClose); // look again later
        this.open = false; cx.notify();
      };
      cx.timer.after(CLOSE_DELAY, tryClose);
    }
  }

  // The click menu beats on a shared key while it lives; no beat for 1.5 s = it's gone (picked or dismissed).
  menuUp() { return this.pinMenu && Date.now() - (shared(KEY_BEAT) ?? 0) < 1500; }

  hover(which, on, cx) {
    this.over[which] = on;
    this.touch(cx);
  }

  apply() {
    if (!this.reply) return;
    this.data = summarize(this.reply, prefs(), prefs().sort);
    const urls = new Set([...this.data.review, ...this.data.mine, ...this.data.other].map((p) => p.url));
    return urls;
  }

  setAccount(login, cx) {
    setShared(KEY_PREFS, { ...prefs(), account: login });
    this.reply = this.data = null;
    this.finished = [];
    this.fetchedAt = 0;
    this.busy = false;
    this.fetch(cx);
    cx.notify();
  }

  // Who the card is showing: the chosen login, else gh's active one.
  login() { return prefs().account || this.accounts[0] || "the active gh account"; }

  fetch(cx) {
    if (this.busy) return;
    this.busy = true;
    this.fetchedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const mod = `${appHome()}/mods/${MOD}/helpers`;
        const r = await exec("sh", [`${mod}/prs.sh`, prefs().account]);
        if (r.code !== 0) throw new Error(r.code === 127 ? "gh not found" : (r.stderr || "gh failed").trim().split("\n")[0]);
        this.reply = JSON.parse(r.stdout);
        const urls = this.apply();
        this.error = null;
        const a = await exec("sh", [`${mod}/accounts.sh`]).catch(() => null);
        if (a?.code === 0) this.accounts = a.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
        this.loadAvatars(this.accounts, cx);
        if (this.accounts[0] && shared(KEY_ACTIVE) !== this.accounts[0]) setShared(KEY_ACTIVE, this.accounts[0]);
        this.finished = await finishedWorktrees(urls);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  // ---------- status bar ----------

  renderBar() {
    const t = theme();
    const d = this.data;
    const stat = (label, n, color) =>
      h_flex().gap(5).flex_none().whitespace_nowrap()
        .child(div().text_color(n ? color : t.dim).child(d ? String(n) : "—"))
        .child(div().text_size(this.top ? 11.5 : 10.5).text_color(t.dim).child(label));
    const content = h_flex().id("gp-content").gap(8).items_center().flex_none()
      .child(div().id("gp-logo").cursor_pointer().tooltip("Switch account")
        .on_click((_e, cx) => { this.panel = "accounts"; this.open = true; cx.notify(); })
        .child(svg(`mods/${MOD}/icons/github.svg`).size(this.top ? 16 : 14).text_color(t.muted)))
      .child(stat("review", d?.review.length ?? 0, t.ansi3 ?? t.done))
      .child(stat("mine", d?.mine.length ?? 0, t.foreground))
      .child(stat("to fix", d?.fix ?? 0, t.ansi1 ?? t.blocked))
      .child(stat("other", d?.other.length ?? 0, t.foreground))
      .when(this.finished.length > 0, (e) => e.child(stat("to clean", this.finished.length, t.ansi3 ?? t.done)))
      .when(this.error != null, (e) => e.child(div().text_color(t.ansi1 ?? t.blocked).child("!")));
    return h_flex().id("root").size_full().px(8).items_center().justify_end().overflow_hidden()
      .bg(t.chrome).border_color(t.border).text_size(this.top ? 12 : 11.8).text_color(t.muted)
      .when(this.top, (e) => e.border_b(1)).when(!this.top, (e) => e.border_t(1))
      .child(Popover.new("gp-panel").anchor(this.top ? "top_right" : "bottom_right")
        .open(this.open).overlay_closable(!this.menuUp())
        .on_open_change((open, cx) => { if (!open && this.menuUp()) return; // a press in the click menu is "outside" to the card
          this.open = open; if (!open) this.panel = "list"; cx.notify(); })
        .trigger(div().id("gp-trigger").on_hover((on, cx) => this.hover("trigger", on, cx)).child(content))
        .content((this.panel === "settings" ? this.settings(t) : this.panel === "accounts" ? this.accountsPanel(t) : this.card(t)).on_hover((on, cx) => this.hover("card", on, cx))));
  }

  // ---------- hover card ----------

  // Press: the menu (browser / terminal / agents), beside the card, never over it: the card is drawn
  // above popups, and the default "pointer" spot isn't tracked inside a hover card.
  // Bottom bar: right of the card, its bottom on the clicked row's, growing upward (no room below).
  // Top bar: the block is at the window's right edge, so left of the card, its top on the row's, growing down.
  pick(e, p) {
    const cached = shared(KNOWN_AGENTS)?.[""] ?? [];
    const height = menuHeight(cached.filter((a) => a.installed).length);
    const rowX = e.position.x - (e.local_position?.x ?? 0);
    const rowY = e.position.y - (e.local_position?.y ?? 0);
    const rowH = e.bounds?.height ?? 28;
    const cardLeft = rowX - CARD_INSET; // rows start CARD_INSET inside the card's left edge
    const at = this.top
      ? { x: Math.max(8, Math.round(cardLeft - MENU_W - 8)), y: Math.round(rowY) }
      : { x: Math.round(cardLeft + PANEL_W + 8), y: Math.max(8, Math.round(rowY + rowH - height)) };
    // A click inside the card doesn't dismiss an open popup, so a second click would stack another.
    if (this.menuId) try { closeOverlay(this.menuId); } catch { /* already closed */ }
    this.pinMenu = true;
    setShared(KEY_BEAT, Date.now());
    this.menuId = openOverlay({ mod: MOD, kind: "popup", width: MENU_W, height, at, props: { pr: p } });
  }

  prRow(p, i, key, tags, t) {
    return h_flex().id(`gp-${key}-${i}`).gap(8).items_center().px(6).py(4).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`${p.title}\n${p.repo}#${p.number}`)
      .on_mouse_down("left", (e) => this.pick(e, p))
      .child(div().size(7).flex_none().rounded_full().bg(ciColor(p.ci, t)).tooltip(p.ci ? `CI: ${p.ci.toLowerCase()}` : "No CI"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(t.foreground).child(p.title))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${p.repo.split("/").pop()}#${p.number}`))
          .children(tags.map((g) => pill(g, t.ansi1 ?? t.blocked, t)))
          .when(p.draft, (e) => e.child(pill("draft", t.dim, t)))));
  }

  // Grouped by repo: a shaded repo header above each group's first row.
  groupRows(list, key, tagsOf, t) {
    const rows = [];
    list.forEach((p, i) => {
      if (i === 0 || list[i - 1].repo !== p.repo) rows.push(div().mt(i ? 8 : 0).px(6).py(2).rounded(4).bg(t.raised).text_size(11).font_semibold().text_color(t.foreground).truncate().child(p.repo));
      rows.push(this.prRow(p, i, key, tagsOf(p), t));
    });
    return rows;
  }

  section(title, list, key, tagsOf, t, extra = null) {
    return v_flex().gap(2)
      .child(h_flex().gap(6).items_center().px(6).h(20)
        .child(div().font_semibold().child(title))
        .child(pill(String(list.length), t.dim, t))
        .when(extra != null, (e) => e.child(pill(extra, t.ansi1 ?? t.blocked, t))))
      .children(list.length
        ? (prefs().sort === "repo" ? this.groupRows(list, key, tagsOf, t) : list.map((p, i) => this.prRow(p, i, key, tagsOf(p), t)))
        : [div().px(6).text_size(11).text_color(t.dim).child("Nothing waiting")]);
  }

  // Worktrees this mod made, their PR now merged or closed: a click opens Herdr's own remove dialog.
  cleanSection(t) {
    return v_flex().gap(2)
      .child(h_flex().gap(6).items_center().px(6).h(20)
        .child(div().font_semibold().child("Worktrees to clean up")).child(pill(String(this.finished.length), t.dim, t)))
      .children(this.finished.map((w, i) =>
        h_flex().id(`gp-clean-${i}`).gap(8).items_center().px(6).py(4).rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip(`Remove ${w.path}`)
          .on_click(() => removeWorktree(w))
          .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim).flex_none())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(w.label))
          .child(div().flex_1())
          .child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.ansi3 ?? t.done).child(w.state.toLowerCase()))));
  }

  card(t) {
    const d = this.data;
    const cooling = Date.now() - this.fetchedAt < COOLDOWN;
    const body = v_flex().id("gp-body").w(PANEL_W).p(10).gap(10).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground);
    const head = h_flex().gap(8).items_center().px(2)
      .child(div().flex_1())
      .child(this.avatar(this.login(), 20, t))
      .child(div().truncate().text_size(12).text_color(t.foreground).child(this.login()))
      .child(iconButton("gp-refresh", "refresh", cooling ? "Refreshing…" : "Refresh now", (cx) => { this.fetch(cx); cx.notify(); }, t, !cooling))
      .child(iconButton("gp-settings", "gear", "Settings", (cx) => { this.panel = "settings"; cx.notify(); }, t));
    const foot = div().truncate().px(2).text_size(10.5).text_color(this.error ? (t.ansi1 ?? t.blocked) : t.dim)
      .child(this.error ?? (d ? `Updated ${new Date(this.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · click a PR to open it` : "Loading…"));
    body.child(head).child(rule(t));
    if (d) {
      const parts = [];
      const heights = [];
      const rowsOf = (l) => l.length + (prefs().sort === "repo" ? new Set(l.map((p) => p.repo)).size * 0.7 : 0); // group headings
      const add = (node, n) => { if (parts.length) parts.push(rule(t)); parts.push(node); heights.push(HEAD_H + Math.max(1, n) * ROW_H); };
      if (this.finished.length) add(this.cleanSection(t), this.finished.length);
      add(this.section("Review requested", d.review, "r", () => [], t), rowsOf(d.review));
      add(this.section("My PRs", d.mine, "m", (p) => p.reasons, t, d.fix ? `${d.fix} to fix` : null), rowsOf(d.mine));
      add(this.section("Also involving me", d.other, "o", () => [], t), rowsOf(d.other));
      if (!d.review.length && !d.mine.length && !d.other.length) parts.unshift(div().px(6).text_color(t.dim).child(`No open PRs for ${this.login()}.`));
      const h = heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * SECTION_GAP;
      body.child(v_flex().id("gp-list").w_full().gap(10).h(Math.min(MAX_LIST_H, h)).overflow_y_scrollbar().children(parts));
    } else {
      body.child(div().text_color(t.dim).child(this.error ?? "Loading…"));
    }
    return body.child(rule(t)).child(foot);
  }

  // ---------- settings: where your repos live ----------

  addFolder(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Add" });
      const roots = rootsOf(currentLogin());
      if (folder && !roots.includes(folder)) setRoots(currentLogin(), [...roots, folder]);
      cx.notify();
    });
  }

  // Avatars are fetched once per login into the app folder (a mod can only draw images from there).
  loadAvatars(logins, cx) {
    for (const login of logins) {
      if (this.avatars.has(login)) continue;
      exec("sh", ["-c", '[ -s "$2" ] || { mkdir -p "$(dirname "$2")" && curl -fsSL -m 10 -o "$2" "https://github.com/$1.png?size=64"; }', "_", login, `${appHome()}/${avatarPath(login)}`])
        .then((r) => { if (r.code === 0) { this.avatars.add(login); cx.notify(); } }).catch(() => {});
    }
  }

  avatar(login, size, t) {
    const initials = (login || "?").slice(0, 2).toUpperCase();
    return Avatar.new().w(size).h(size).flex_none().rounded_full().overflow_hidden().bg(t.raised)
      .when(this.avatars.has(login), (e) => e.image(AvatarImage.new(avatarPath(login)).size_full()))
      .fallback(AvatarFallback.new().size_full().flex().items_center().justify_center().text_size(size * 0.4).text_color(t.dim).child(initials));
  }

  accountsPanel(t) {
    const chosen = prefs().account;
    const acct = (id, login, sub, i) =>
      h_flex().id(`gp-acct-${i}`).gap(8).items_center().px(8).h(36).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(chosen === id, (e) => e.bg(t.selected))
        .on_click((_e, cx) => { this.setAccount(id, cx); this.panel = "list"; })
        .child(this.avatar(login, 24, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(login || "—"))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(sub)))
        .child(div().w(14).text_color(t.accent).child(chosen === id ? "✓" : ""));
    return v_flex().id("gp-body").w(PANEL_W).p(12).gap(8).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().h(24)
        .child(iconButton("gp-back", "back", "Back", (cx) => { this.panel = "list"; cx.notify(); }, t))
        .child(div().font_semibold().text_size(13).child("GitHub account")))
      .child(v_flex().gap(2)
        .child(acct("", this.accounts[0] ?? "", "Follow gh's active account", -1))
        .children(this.accounts.map((a, i) => acct(a, a, "Use this login only", i))))
      .child(div().px(2).text_size(11).text_color(t.dim).child("Nothing is switched globally. The login's token lives only inside the helper process."));
  }

  settings(t) {
    const roots = rootsOf(currentLogin());
    const label = (text) => div().px(2).pt(4).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const hint = (text) => div().px(2).text_size(11).text_color(t.dim).child(text);
    const field = (state) => div().px(8).h(28).flex().items_center().rounded(6).border(1).border_color(t.border).bg(t.raised).child(Input.new(state));
    return v_flex().id("gp-body").w(PANEL_W).p(12).gap(8).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().h(24)
        .child(iconButton("gp-back", "back", "Back", (cx) => { this.panel = "list"; cx.notify(); }, t))
        .child(div().font_semibold().text_size(13).child("Settings")))
      .child(label("Sort"))
      .child(h_flex().gap(4).children([["attention", "Needs attention first"], ["recent", "Recent activity"], ["repo", "By repo"]].map(([id, name]) =>
        div().id(`gp-sort-${id}`).flex_1().h(26).rounded(6).flex().items_center().justify_center().cursor_pointer()
          .border(1).border_color(prefs().sort === id ? t.accent : t.border).hover((s) => s.bg(t.hover))
          .when(prefs().sort === id, (e) => e.bg(t.selected).text_color(t.foreground))
          .on_click((_e, cx) => { setShared(KEY_PREFS, { ...prefs(), sort: id }); this.apply(); cx.notify(); })
          .child(name))))
      .child(label("Refresh"))
      .child(h_flex().gap(4).children(EVERY_CHOICES.map((m) =>
        div().id(`gp-every-${m}`).flex_1().h(26).rounded(6).flex().items_center().justify_center().cursor_pointer()
          .border(1).border_color(prefs().everyMin === m ? t.accent : t.border).hover((s) => s.bg(t.hover))
          .when(prefs().everyMin === m, (e) => e.bg(t.selected).text_color(t.foreground))
          .on_click((_e, cx) => { setShared(KEY_PREFS, { ...prefs(), everyMin: m }); cx.notify(); })
          .child(`${m} min`))))
      .child(rule(t))
      .child(label("Filter"))
      .child(hint("Only these orgs or repos (empty = all)"))
      .child(field(this.includeInput))
      .child(hint("Never show these"))
      .child(field(this.excludeInput))
      .child(rule(t))
      .child(label(`Git folders for ${this.login()}`))
      .child(hint("Searched three levels deep for a PR's repo. Folders of your open spaces are always searched too."))
      .child(v_flex().gap(1).children(roots.map((r, i) =>
        h_flex().id(`gp-root-${i}`).gap(6).items_center().px(8).h(28).rounded(6).bg(t.raised).hover((s) => s.bg(t.hover))
          .child(div().flex_1().min_w(0).truncate().child(r))
          .child(div().id(`gp-root-x-${i}`).size(20).rounded(4).flex().items_center().justify_center().cursor_pointer().text_color(t.dim)
            .hover((s) => s.bg(t.hover)).tooltip("Remove")
            .on_click((_e, cx) => { setRoots(currentLogin(), roots.filter((x) => x !== r)); cx.notify(); })
            .child("✕")))))
      .when(roots.length === 0, (e) => e.child(hint("None added yet.")))
      .child(div().id("gp-add").px(8).h(28).flex().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).text_color(t.accent)
        .on_click((_e, cx) => this.addFolder(cx)).child("+ Add folder…"));
  }

  // ---------- click menu (this mod opened as a popup) ----------

  initMenu(cx) {
    this.menu = true;
    this.agents = shared(KNOWN_AGENTS)?.[""] ?? []; // Herdr's last list, shown at once
    cx.timer.every(500, () => setShared(KEY_BEAT, Date.now()));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { this.agents = await knownAgents(); } catch { /* keep the cached list */ }
      cx.notify();
    });
  }

  menuRow(id, icon, name, hint, onPick, t) {
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(t.foreground).hover((s) => s.bg(t.selected)).cursor_pointer()
      .on_click(() => onPick())
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }

  renderMenu() {
    const t = theme();
    const pr = props().pr;
    const agents = this.agents.filter((a) => a.installed);
    const close = () => closeOverlay(props().overlay);
    // The bar (always running) does the work, so closing this popup can't cut a checkout short.
    const open = (agent) => {
      close();
      setShared(KEY_REQ, { at: Date.now(), pr, agent: agent ? { name: agent.name, run: agent.run, key: agent.key } : null });
    };
    const browser = () => { close(); setShared(KEY_REQ, { at: Date.now(), pr, browser: true }); };
    return v_flex().min_h(0).w_full().h(menuHeight(agents.length)).bg(t.popover).p(5).text_size(12.8)
      .id("gp-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "b") return browser();
        if (e.key === "t") return open(null);
        const agent = /^[1-9]$/.test(e.key) ? agents[Number(e.key) - 1] : null;
        if (agent) open(agent);
      })
      .child(div().px(9).pt(6).pb(4).text_size(11).text_color(t.dim).truncate().child(`${pr.repo.split("/").pop()}#${pr.number} · ${pr.title}`))
      .child(this.menuRow("gp-browser", svg(`mods/${MOD}/icons/github.svg`).size(14), "Open in browser", "b", browser, t))
      .child(this.menuRow("gp-terminal", svg("icons/shell.svg").size(14), "Terminal in checkout", "t", () => open(null), t))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent in the checkout"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(agents.map((a, i) => this.menuRow(`gp-${a.key}`, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name, i < 9 ? String(i + 1) : "", () => open(a), t))));
  }

  render(cx) {
    if (this.menu) return this.renderMenu();
    const req = shared(KEY_REQ);
    if (req && req.at !== this.seenReq) {
      this.seenReq = req.at;
      this.pinMenu = false;
      this.touch(cx);
      if (req.browser) exec("open", [req.pr.url]).catch(() => {});
      else openPr(req.pr, req.agent);
    }
    return this.renderBar();
  }
}
