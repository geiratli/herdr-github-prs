// Impure: finding a PR's checkout, opening it, and tidying the worktrees we made.
import { exec, run, notify, openOverlay, spaces, panes, home, appHome, shared, setShared } from "herdr";
import { branchFor, parseWorktrees, spaceFor, worktreePath } from "./repo.js";

const MOD = "github-prs";
export const KEY_PREFS = `${MOD}.prefs`;
export const KEY_WORKTREES = `${MOD}.worktrees`; // path → { slug, number, url, label }: the ones this mod made
export const KEY_ACTIVE = `${MOD}.active`; // gh's active login, written by the bar, for when no account is chosen
export const currentLogin = () => prefs().account || shared(KEY_ACTIVE) || "";
// Git folders belong to a gh account. Before any per-account setting, the old single `roots` list applies to all.
export const rootsOf = (login) => prefs().folders?.[login] ?? (prefs().folders ? [] : prefs().roots);
export const setRoots = (login, roots) => { const { roots: _old, ...p } = prefs(); setShared(KEY_PREFS, { ...p, folders: { ...(p.folders ?? {}), [login]: roots } }); };
export const prefs = () => ({ roots: [], account: "", everyMin: 3, include: [], exclude: [], ...(shared(KEY_PREFS) ?? {}) });

const git = async (cwd, args, timeout) => {
  const r = await exec("git", args, { cwd, timeout });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
};
// Every gh call goes through gh.sh as the chosen account ("" = active): the token stays in that child's env.
export const gh = (args, options) => exec("sh", [`${appHome()}/mods/${MOD}/helpers/gh.sh`, prefs().account, ...args], options);
const fail = (title, body) => notify({ title, body: String(body).slice(0, 400), level: "error", timeout: 20000 });

// The main checkout of a repo: a folder an open space is in, else under a configured git folder.
async function locate(slug) {
  const open = [...spaces().filter((s) => !s.machine).map((s) => s.folder), ...panes().map((p) => p.cwd)].filter(Boolean);
  const args = [...new Set(open)].map((d) => `d:${d}`).concat(rootsOf(currentLogin()).map((r) => `r:${r}`));
  const r = await exec("sh", [`${appHome()}/mods/${MOD}/helpers/locate.sh`, slug, ...args], { timeout: 60000 });
  return r.code === 0 ? r.stdout.split("\n")[0].trim() : null;
}

const start = (agent) => (agent ? { argv: agent.run } : {});

// Open a PR where its branch lives: a new tab in the space already showing it, else a space for
// its existing worktree, else a new worktree (never a second one for the same branch).
export async function openPr(pr, agent) {
  const label = `${pr.repo.split("/").pop()}#${pr.number}`;
  try {
    const main = await locate(pr.repo);
    if (!main) return fail(`Can't open ${label}`, `No local checkout of ${pr.repo} found. Add the folder holding your repos with ⚙ in the PR card.`);
    const list = await git(main, ["worktree", "list", "--porcelain"]);
    if (!list.ok) return fail(`Can't open ${label}`, list.err);
    const wts = parseWorktrees(list.out);
    const branch = branchFor(pr);

    let at = wts.find((w) => w.branch === branch);
    if (!at) {
      const path = worktreePath(home(), main.split("/").pop(), branch);
      notify({ title: `Checking out ${label}`, body: path, level: "info", timeout: 5000 });
      // A half-made worktree from an interrupted attempt is finished, not duplicated.
      if (!wts.some((w) => w.path === path)) {
        const add = await git(main, ["worktree", "add", "--detach", path], 600_000);
        if (!add.ok) return fail(`Can't check out ${label}`, add.err);
      }
      const co = await gh(["pr", "checkout", String(pr.number), "-R", pr.repo, ...(pr.cross ? ["-b", branch] : [])], { cwd: path, timeout: 600_000 });
      if (co.code !== 0) {
        await git(main, ["worktree", "remove", "--force", path]); // ours, nothing of the person's in it
        return fail(`Can't check out ${label}`, co.stderr || co.stdout);
      }
      setShared(KEY_WORKTREES, { ...(shared(KEY_WORKTREES) ?? {}), [path]: { slug: pr.repo, number: pr.number, url: pr.url, label } });
      // Left unnamed: Herdr then names it after the checkout and nests it under its repo, tree icon and all.
      run("space.new", { folder: path, ...start(agent) });
      return;
    }
    const space = spaceFor(at.path, wts.map((w) => w.path), spaces(), panes());
    if (space) run("tab.new", { space: space.id, folder: at.path, ...(agent ? { name: agent.name } : {}), ...start(agent) });
    else run("space.new", { folder: at.path, ...start(agent) });
  } catch (e) {
    fail(`Can't open ${label}`, e?.message ?? e);
  }
}

// Worktrees this mod made whose PR is merged or closed. `openUrls`: PRs still in the lists, no need to ask.
// A worktree someone already removed is forgotten.
export async function finishedWorktrees(openUrls) {
  const tracked = shared(KEY_WORKTREES) ?? {};
  const keep = {};
  const done = [];
  for (const [path, w] of Object.entries(tracked)) {
    try {
      if ((await exec("sh", ["-c", '[ -d "$1" ]', "_", path])).code !== 0) continue;
      keep[path] = w;
      if (openUrls.has(w.url)) continue;
      const r = await gh(["pr", "view", String(w.number), "-R", w.slug, "--json", "state", "-q", ".state"]);
      const state = r.stdout.trim();
      if (r.code === 0 && (state === "MERGED" || state === "CLOSED")) done.push({ path, ...w, state });
    } catch { keep[path] = w; } // couldn't ask: try again next time
  }
  if (Object.keys(keep).length !== Object.keys(tracked).length) setShared(KEY_WORKTREES, keep);
  return done;
}

// Herdr's own remove dialog when the worktree has a space (it warns about uncommitted work and
// closes the space); else a plain `git worktree remove`, which refuses a dirty one.
export async function removeWorktree(w) {
  const space = spaceFor(w.path, [w.path], spaces(), panes());
  if (space) return openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: space.id, action: "remove" } });
  const common = await git(w.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const r = common.ok ? await git(common.out.replace(/\/\.git$/, ""), ["worktree", "remove", w.path], 600_000) : common;
  if (!r.ok) return fail(`Can't remove ${w.label}`, `${r.err}\nOpen it and use "Remove worktree" in its space menu.`);
  const { [w.path]: _gone, ...rest } = shared(KEY_WORKTREES) ?? {};
  setShared(KEY_WORKTREES, rest);
  notify({ title: `Removed worktree for ${w.label}`, level: "success", timeout: 5000 });
}
