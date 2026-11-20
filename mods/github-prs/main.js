// GitHub PRs: what needs your attention, in the status bar; a hover card with every PR involving
// you. Click a PR to open it in a browser, a terminal or a coding agent, in the folder where its
// branch is checked out (a worktree is made when there's none). Worktrees of finished PRs are
// offered for cleanup. Data comes from helpers/prs.sh (your own `gh` login); no token is read here.
//
// The same mod is also the click menu: opened as a popup, `props().pr` is set and it draws that.
import { View, div, svg, image } from "gpui-kit";
import { Avatar, AvatarFallback, AvatarImage, Popover, Input, InputState, ScrollHandle, h_flex, v_flex } from "gpui-base";
import { exec, theme, appHome, props, shared, setShared, openOverlay, closeOverlay, knownAgents, pickFolder, nextCommand } from "herdr";
import { isNewer, parseList, summarize } from "./lib/model.js";
import { KEY_ACTIVE, KEY_PREFS, currentLogin, finishedWorktrees, gh, openPr, prefs, removeWorktree, rootsOf, setRoots } from "./lib/actions.js";

const MOD = "github-prs";
const VERSION = "0.1.0";       // bump with each release tag; the card offers newer GitHub releases
const REPO = "geiratli/herdr-github-prs";
const avatarPath = (login) => `data/${MOD}/avatars/${login}.png`;
const KEY_REQ = `${MOD}.request`;  // the click menu asks the bar (which lives on) to do the work
const KEY_BEAT = `${MOD}.menu-beat`;
const KNOWN_AGENTS = "new-menu.agents"; // what Herdr's own new-tab menu last found, per machine ("" = this one)
const EVERY_CHOICES = [1, 3, 5, 10, 30]; // minutes between fetches, as offered in settings
const COOLDOWN = 15 * 1000;    // ms, manual refresh
const PANEL_W = 600;
const MENU_W = 260;
const CARD_MARGIN = 54, CARD_TOP = 36; // estimates for opening the menu from the keyboard: the card's gap to the window's right edge, and its top
const LIST_TOP = 56;            // card top → list top: border 1 + padding 10 + header 24 + gaps/rule 21
const MENU_SHIFT = 24;          // measured, not derived: below a top bar the popup landed ~24px right of where cardLeft says
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
    this.keepOpenUntil = 0; // the click that opens the account panel also toggles the popover: ignore that close
    // Enter never arrives as a plain key press (something earlier takes it), so it is bound as an action in the card's own context.
    cx.bind_keys([{ keystroke: "enter", action: "gp-enter", context: "GithubPrsCard" }]);
    this.handle = cx.focus_handle(); // keyboard: the card takes it when opened with the key (keys.json → github-prs.toggle)
    this.scroll = ScrollHandle.new();
    this.partOf = new Map(); // PR url → index of its section in the list, to scroll the selection into view
    this.kbd = false;      // opened with the key: stays until Escape, a pick, or a click outside
    this.selUrl = null;    // keyboard selection (by url, so it survives a refresh)
    this.menuPr = null;    // keyboard: the PR whose action menu is drawn left of the card (top bar)
    this.at = 0;           // highlighted row in that menu
    this.sizes = new Map(); // PR url → measured row height
    this.rowY = new Map();  // PR url → row top, from the top of the list (walked while the card is built)
    this.cursor = 0; this.seen = 0; this.cardH = 0;
    this.agents = shared(KNOWN_AGENTS)?.[""] ?? [];
    this.pinMenu = false;  // the click menu is open: the card stays until something is picked
    this.latest = null;    // newest release tag on GitHub, when it's newer than VERSION
    this.updating = false;
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
    this.checkUpdate(cx);
    cx.timer.every(6 * 60 * 60 * 1000, (cx) => this.checkUpdate(cx));
    cx.timer.every(60 * 1000, (cx) => { if (Date.now() - this.fetchedAt >= prefs().everyMin * 60 * 1000) this.fetch(cx); });
    cx.timer.every(400, () => { if (this.kbd && this.panel === "list" && !this.menuUp() && !this.handle.is_focused()) this.handle.focus(); }); // back from the menu
    cx.spawn(async (cx) => { for (;;) { if (await nextCommand() === "toggle") this.toggleKeyboard(cx); } });
  }

  // ---------- keyboard ----------

  flat() { const d = this.data; return d ? [...d.review, ...d.mine, ...d.other] : []; } // the order the card shows

  toggleKeyboard(cx) {
    if (this.open && this.kbd) return this.closeKeyboard(cx);
    this.kbd = true; this.open = true; this.panel = "list";
    this.selUrl = this.flat()[0]?.url ?? null;
    this.grab(cx);
    cx.notify();
  }

  // Take the keyboard once the card (or its next panel) has been drawn; retry, as the popover may settle after us.
  grab(cx) {
    for (const ms of [80, 300, 700]) cx.timer.after(ms, () => { if (this.kbd && !this.handle.is_focused()) this.handle.focus(); });
  }

  closeKeyboard(cx) { this.kbd = false; this.open = false; this.panel = "list"; this.menuPr = null; cx.notify(); }

  onKey(e, cx) {
    if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
    if (this.menuPr) return this.menuKey(e, cx);
    const list = this.flat();
    const i = list.findIndex((p) => p.url === this.selUrl);
    if (e.key === "down" || e.key === "up") {
      if (!list.length) return;
      const n = i < 0 ? 0 : (i + (e.key === "down" ? 1 : list.length - 1)) % list.length;
      this.selUrl = list[n].url;
      this.scroll.scroll_to_item(this.partOf.get(this.selUrl) ?? 0);
    } else if ((e.key === "enter" || e.key === (this.top ? "left" : "right")) && i >= 0) this.menuFor(list[i], cx); // the arrow toward the side the menu opens on, or Enter
    else if (e.key === "escape") return this.closeKeyboard(cx);
    cx.notify();
  }

  // Top bar: the menu is drawn inside the card's popover, left of the card, so it needs no screen coordinates.
  // Bottom bar: a popup right of the card, as with a click.
  menuFor(pr, cx) {
    if (!this.top) return this.openMenu(pr, this.cardLeft ?? (this.vw || 1200) - PANEL_W - CARD_MARGIN, (this.vh || 800) - 60, 28);
    this.menuPr = pr; this.at = 0;
    // the cached list shows at once; Herdr's fresh one replaces it
    knownAgents().then((a) => { this.agents = a; cx.notify(); }).catch(() => {});
    cx.notify();
  }

  menuRun(extra) { setShared(KEY_REQ, { at: Date.now(), pr: this.menuPr, ...extra }); } // render() sees the request and closes the card

  menuRows(pr, agents, t, open, browser) {
    return [
      { id: "gp-browser", icon: svg(`mods/${MOD}/icons/github.svg`).size(14), name: "Open in browser", hint: "b", run: browser },
      { id: "gp-terminal", icon: svg("icons/shell.svg").size(14), name: "Terminal in checkout", hint: "t", run: () => open(null) },
      ...agents.map((a, i) => ({ id: `gp-${a.key}`, icon: a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), name: a.name, hint: i < 9 ? String(i + 1) : "", run: () => open(a) })),
    ];
  }

  // The menu's rows: title, browser, terminal, agents. `rows` as from menuRows.
  menuChildren(pr, rows, t) {
    const row = (r, i) => this.menuRow(r.id, r.icon, r.name, r.hint, r.run, t).when(i === this.at, (e) => e.bg(t.selected));
    return [
      div().px(9).pt(6).pb(4).text_size(11).text_color(t.dim).truncate().child(`${pr.repo.split("/").pop()}#${pr.number} · ${pr.title}`),
      row(rows[0], 0), row(rows[1], 1),
      div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent in the checkout"),
      v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(rows.slice(2).map((r, i) => row(r, i + 2))),
    ];
  }

  inlineMenuRows(t) {
    const pr = this.menuPr;
    const open = (a) => this.menuRun({ agent: a ? { name: a.name, run: a.run, key: a.key } : null });
    return this.menuRows(pr, this.agents.filter((a) => a.installed), t, open, () => this.menuRun({ browser: true }));
  }

  menuKey(e, cx) {
    const rows = this.inlineMenuRows(theme());
    if (e.key === "down" || e.key === "up") this.at = (this.at + (e.key === "down" ? 1 : rows.length - 1)) % rows.length;
    else if (e.key === "enter") return rows[this.at]?.run();
    else if (e.key === "right" || e.key === "escape") this.menuPr = null; // → goes back to the card
    else { const r = rows.find((x) => x.hint === e.key); if (r) return r.run(); }
    cx.notify();
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
        if (this.menuUp() || this.kbd || this.panel !== "list") return cx.timer.after(600, tryClose); // look again later
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

  showAccounts(cx) {
    this.keepOpenUntil = Date.now() + 400;
    this.panel = "accounts"; this.open = true; cx.notify();
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

  // ---------- updates ----------

  checkUpdate(cx) {
    cx.spawn(async (cx) => {
      const r = await gh(["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]).catch(() => null);
      const tag = r?.code === 0 ? r.stdout.trim() : null;
      if (tag && isNewer(tag, VERSION)) { this.latest = tag; cx.notify(); } // a failed check keeps what we knew
    });
  }

  // Overwrites this mod's folder with the release; Herdr reloads it once main.js lands, so nothing runs after.
  update(cx) {
    if (this.updating || !this.latest) return;
    this.updating = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", [`${appHome()}/mods/${MOD}/helpers/update.sh`, this.latest, `${appHome()}/mods/${MOD}`], { timeout: 120000 }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) this.error = `Update failed: ${(r.stderr || "unknown error").trim().split("\n").pop()}`;
      this.updating = false;
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
        .on_click((_e, cx) => { cx.stop_propagation(); this.showAccounts(cx); })
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
        .on_open_change((open, cx) => { if (!open && (this.menuUp() || Date.now() < this.keepOpenUntil)) return; // a press in the click menu is "outside" to the card
          this.open = open; if (!open) { this.panel = "list"; this.kbd = false; this.menuPr = null; } cx.notify(); })
        .trigger(div().id("gp-trigger").on_hover((on, cx) => this.hover("trigger", on, cx)).child(content))
        .content((this.panel === "settings" ? this.settings(t) : this.panel === "accounts" ? this.accountsPanel(t) : this.menuPr && this.top ? this.withMenu(t) : this.card(t)).on_hover((on, cx) => this.hover("card", on, cx))));
  }

  // ---------- hover card ----------

  // The card with its action menu on the left: the popover is anchored at its right edge, so the card stays put.
  withMenu(t) {
    const rows = this.inlineMenuRows(t);
    const width = Math.max(200, Math.min(MENU_W, Math.round((this.vw || 1200) - PANEL_W - CARD_MARGIN - 16)));
    const card = this.card(t); // first: it walks the rows and records where each one sits
    const h = menuHeight(rows.length - 2);
    const y = LIST_TOP + (this.rowY.get(this.menuPr.url) ?? 0); // level with the row, kept inside the card's height
    const mt = Math.max(0, this.cardH ? Math.min(y, this.cardH - h) : y);
    return h_flex().gap(8).items_start()
      .child(v_flex().id("gp-inline-menu").mt(mt).w(width).h(h).p(5).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
        .text_size(12.8).text_color(t.foreground).children(this.menuChildren(this.menuPr, rows, t)))
      .child(card);
  }

  // Press: the menu (browser / terminal / agents), beside the card, never over it: the card is drawn
  // above popups, and the default "pointer" spot isn't tracked inside a hover card.
  // Bottom bar: right of the card, its bottom on the clicked row's, growing upward (no room below).
  // Top bar: the block is at the window's right edge, so left of the card, its top on the row's, growing down.
  pick(e, p, cx) {
    if (this.top) { this.kbd = true; return this.menuFor(p, cx); } // top bar: the menu is drawn in the card, no screen coordinates
    const rowX = e.position.x - (e.local_position?.x ?? 0);
    const rowY = e.position.y - (e.local_position?.y ?? 0);
    const rowH = e.bounds?.height ?? 28;
    const cardLeft = rowX - CARD_INSET; // rows start CARD_INSET inside the card's left edge
    this.cardLeft = cardLeft;
    this.openMenu(p, cardLeft, rowY, rowH);
  }

  openMenu(p, cardLeft, rowY, rowH) {
    const cached = shared(KNOWN_AGENTS)?.[""] ?? [];
    const height = menuHeight(cached.filter((a) => a.installed).length);
    // Top bar: the menu goes left of the card; on a narrow window it shrinks to the room there is (min 200) instead of sliding under the card.
    const width = this.top ? Math.max(200, Math.min(MENU_W, Math.round(cardLeft - 16 - MENU_SHIFT))) : MENU_W;
    const at = this.top
      ? { x: Math.max(8, Math.round(cardLeft - width - 8 - MENU_SHIFT)), y: Math.round(rowY) }
      : { x: Math.round(cardLeft + PANEL_W + 8), y: Math.max(8, Math.round(rowY + rowH - height)) };
    // A click inside the card doesn't dismiss an open popup, so a second click would stack another.
    if (this.menuId) try { closeOverlay(this.menuId); } catch { /* already closed */ }
    this.pinMenu = true;
    setShared(KEY_BEAT, Date.now());
    this.menuId = openOverlay({ mod: MOD, kind: "popup", width, height, at, props: { pr: p, top: this.top } });
  }

  prRow(p, i, key, tags, t) {
    this.rowY.set(p.url, this.cursor);
    this.cursor += (this.sizes.get(p.url) ?? ROW_H) + 2; // + the gap below
    const arrow = (g) => div().flex_none().px(2).text_size(14).text_color(t.muted).tooltip(`Press ${g} for actions`).child(g); // points to where the menu opens
    return h_flex().id(`gp-${key}-${i}`).gap(8).items_center().px(6).py(4).rounded(5).cursor_pointer()
      .when(this.kbd && this.top, (e) => e.child(p.url === this.selUrl ? arrow("←") : div().flex_none().w(18))) // a gap on the other rows, so the text doesn't jump
      .hover((s) => s.bg(t.hover))
      .when(this.kbd && p.url === this.selUrl, (e) => e.bg(t.selected))
      .tooltip(`${p.title}\n${p.repo}#${p.number}`)
      .on_size_change((sz) => this.sizes.set(p.url, sz.height))
      .on_mouse_down("left", (e, cx) => this.pick(e, p, cx))
      .child(div().size(7).flex_none().rounded_full().bg(ciColor(p.ci, t)).tooltip(p.ci ? `CI: ${p.ci.toLowerCase()}` : "No CI"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(t.foreground).child(p.title))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${p.repo.split("/").pop()}#${p.number}`))
          .children(tags.map((g) => pill(g, t.ansi1 ?? t.blocked, t)))
          .when(p.draft, (e) => e.child(pill("draft", t.dim, t)))))
      .when(this.kbd && !this.top, (e) => e.child(p.url === this.selUrl ? arrow("→") : div().flex_none().w(18)));
  }

  // Grouped by repo: a shaded repo header above each group's first row.
  groupRows(list, key, tagsOf, t) {
    const rows = [];
    list.forEach((p, i) => {
      if (i === 0 || list[i - 1].repo !== p.repo) {
        this.cursor += (i ? 8 : 0) + 22 + 2; // margin, fixed height, gap
        rows.push(div().mt(i ? 8 : 0).h(22).px(6).flex().items_center().rounded(4).bg(t.raised).text_size(11).font_semibold().text_color(t.foreground).truncate().child(p.repo));
      }
      rows.push(this.prRow(p, i, key, tagsOf(p), t));
    });
    return rows;
  }

  section(title, list, key, tagsOf, t, extra = null) {
    this.cursor += (this.seen++ ? SECTION_GAP : 0) + 20 + 2; // gap to the section above, heading, gap
    if (!list.length) this.cursor += 17 + 2;
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
    this.cursor += (this.seen++ ? SECTION_GAP : 0) + 20 + 2 + this.finished.length * (28 + 2);
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
    const body = v_flex().id("gp-body").on_size_change((sz) => { this.cardH = sz.height; }).w(PANEL_W).p(10).gap(10).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground)
      .track_focus(this.handle).key_context("GithubPrsCard").on_key_down((e, cx) => this.onKey(e, cx))
      .on_action("gp-enter", (_e, cx) => this.onKey({ key: "enter", modifiers: {} }, cx))
      .on_mouse_down("left", (_e, cx) => { // a click in the card also hands it the arrow keys (and keeps it open until Esc or a click outside)
        if (!this.kbd) { this.kbd = true; this.selUrl ??= this.flat()[0]?.url ?? null; }
        this.handle.focus(); cx.notify();
      });
    this.partOf.clear(); this.rowY.clear(); this.cursor = 0; this.seen = 0;
    const head = h_flex().gap(8).items_center().px(2)
      .when(!!this.latest, (e) => e.child(div().id("gp-update").px(8).h(24).flex().items_center().rounded(5).border(1).border_color(t.accent).text_color(t.accent)
        .tooltip(`Replaces the files in mods/${MOD} with release ${this.latest} from GitHub`)
        .when(!this.updating, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.update(cx)))
        .child(this.updating ? "Updating…" : `Update to ${this.latest}`)))
      .child(div().flex_1())
      .child(h_flex().id("gp-profile").gap(8).items_center().h(24).px(4).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Switch account")
        .on_click((_e, cx) => this.showAccounts(cx))
        .child(this.avatar(this.login(), 20, t))
        .child(div().truncate().text_size(12).text_color(t.foreground).child(this.login())))
      .child(iconButton("gp-settings", "gear", "Settings", (cx) => { this.panel = "settings"; cx.notify(); }, t));
    const foot = h_flex().gap(8).items_center().px(2)
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(this.error ? (t.ansi1 ?? t.blocked) : t.dim)
        .child(this.error ?? (d ? `Updated ${new Date(this.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · click a PR to open it` : "Loading…")))
      .child(iconButton("gp-refresh", "refresh", cooling ? "Refreshing…" : "Refresh now", (cx) => { this.fetch(cx); cx.notify(); }, t, !cooling));
    body.child(head).child(rule(t));
    if (d) {
      const parts = [];
      const heights = [];
      const rowsOf = (l) => l.length + (prefs().sort === "repo" ? new Set(l.map((p) => p.repo)).size * 0.7 : 0); // group headings
      const add = (node, n, list = []) => { if (parts.length) parts.push(rule(t)); list.forEach((p) => this.partOf.set(p.url, parts.length)); parts.push(node); heights.push(HEAD_H + Math.max(1, n) * ROW_H); };
      if (this.finished.length) add(this.cleanSection(t), this.finished.length);
      add(this.section("Review requested", d.review, "r", () => [], t), rowsOf(d.review), d.review);
      add(this.section("My PRs", d.mine, "m", (p) => p.reasons, t, d.fix ? `${d.fix} to fix` : null), rowsOf(d.mine), d.mine);
      add(this.section("Also involving me", d.other, "o", () => [], t), rowsOf(d.other), d.other);
      if (!d.review.length && !d.mine.length && !d.other.length) parts.unshift(div().px(6).text_color(t.dim).child(`No open PRs for ${this.login()}.`));
      const h = heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * SECTION_GAP;
      body.child(v_flex().id("gp-list").track_scroll(this.scroll).w_full().gap(10).h(Math.min(MAX_LIST_H, h)).overflow_y_scrollbar().children(parts));
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

  pickWorktreeDir(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Use" });
      if (folder) setShared(KEY_PREFS, { ...prefs(), worktreeDir: folder });
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
      .child(label("Worktree folder"))
      .child(hint("Where new PR checkouts go, as <folder>/<repo>/<branch>. Existing worktrees stay where they are."))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().px(8).h(28).flex().items_center().rounded(6).bg(t.raised).child(prefs().worktreeDir || "~/.herdr/worktrees (default)"))
        .child(div().id("gp-wt-pick").px(8).h(28).flex().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).text_color(t.accent)
          .on_click((_e, cx) => this.pickWorktreeDir(cx)).child("Choose…"))
        .when(!!prefs().worktreeDir, (e) => e.child(div().id("gp-wt-reset").px(8).h(28).flex().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).text_color(t.dim)
          .on_click((_e, cx) => { setShared(KEY_PREFS, { ...prefs(), worktreeDir: "" }); cx.notify(); }).child("Reset"))))
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
    this.at = 0; // highlighted row, for the arrow keys
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
    const rows = this.menuRows(pr, agents, t, open, browser);
    const back = props().top ? "right" : "left"; // the arrow toward the card
    return v_flex().min_h(0).w_full().h(menuHeight(agents.length)).bg(t.popover).p(5).text_size(12.8)
      .id("gp-menu").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "down" || e.key === "up") { this.at = (this.at + (e.key === "down" ? 1 : rows.length - 1)) % rows.length; return cx.notify(); }
        if (e.key === "enter") return rows[this.at]?.run();
        if (e.key === back) return close();
        rows.find((r) => r.hint === e.key)?.run();
      })
      .children(this.menuChildren(pr, rows, t));
  }

  render(cx) {
    if (this.menu) return this.renderMenu();
    const req = shared(KEY_REQ);
    if (req && req.at !== this.seenReq) {
      this.seenReq = req.at;
      this.pinMenu = false;
      if (this.kbd) { this.kbd = false; this.open = false; this.panel = "list"; this.menuPr = null; }
      this.touch(cx);
      if (req.browser) exec("open", [req.pr.url]).catch(() => {});
      else openPr(req.pr, req.agent);
    }
    try { const v = window.viewport_size(); this.vw = v.width; this.vh = v.height; } catch { /* keep the last size */ }
    return this.renderBar();
  }
}
