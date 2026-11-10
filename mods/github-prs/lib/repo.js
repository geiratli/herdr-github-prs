// Pure: git remotes, worktree lists and where a PR's checkout lives.

// "git@github.com:Owner/Repo.git", "https://tok@github.com/Owner/Repo" … → "owner/repo".
export const slugFromRemote = (url) => {
  const m = /[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
  return m ? m[1].toLowerCase() : null;
};

// `git worktree list --porcelain` → [{ path, branch|null }], bare and prunable ones left out.
export function parseWorktrees(text) {
  const out = [];
  for (const block of (text ?? "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch });
  }
  return out;
}

// A fork's branch name could clash with one of ours (its `main`), so forks get pr-<n>.
export const branchFor = (pr) => (pr.cross ? `pr-${pr.number}` : pr.headRef);

// Herdr's own convention (mods/worktree): <home>/.herdr/worktrees/<repo>/<branch, slashes as dashes>.
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
export const worktreePath = (home, repo, branch) => `${home}/.herdr/worktrees/${repo}/${slug(branch)}`;

const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// The open space showing a checkout: its first terminal sits in it (the deepest checkout wins,
// so the main checkout's space doesn't claim a worktree nested below it).
export function spaceFor(path, allPaths, spaceList, paneList) {
  return spaceList.find((s) => {
    if (s.machine) return false;
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    const at = (paneList.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || "").replace(/\\/g, "/");
    return at && inside(at, path) && !allPaths.some((p) => p !== path && p.length > path.length && inside(at, p));
  });
}
