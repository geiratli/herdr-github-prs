// Pure: gh's GraphQL reply → what the bar and card show.
const flat = (n) => ({
  repo: n.repository.nameWithOwner,
  number: n.number,
  title: n.title,
  url: n.url,
  updated: n.updatedAt ?? "",
  draft: n.isDraft,
  headRef: n.headRefName,
  cross: n.isCrossRepository,
  decision: n.reviewDecision,
  ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
});

// "org" or "org/repo", case-insensitive. No include list = every repo; exclude always wins.
const matches = (list, repo) => list.some((x) => { const r = repo.toLowerCase(), e = x.toLowerCase(); return r === e || r.startsWith(e + "/"); });
export const allowed = (repo, { include = [], exclude = [] } = {}) => (!include.length || matches(include, repo)) && !matches(exclude, repo);
export const parseList = (text) => (text ?? "").split(/[\s,]+/).filter(Boolean);

// Sort modes: "attention" (needing action first, then recent), "recent", "repo" (grouped, recent within).
export const SORTS = ["attention", "recent", "repo"];
const byRecent = (a, b) => b.updated.localeCompare(a.updated);
const byRepo = (a, b) => a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()) || byRecent(a, b);
export const arrange = (list, sort) => [...list].sort(sort === "repo" ? byRepo : byRecent);

export function summarize(reply, filter, sort = "attention") {
  const nodes = (k) => (reply?.data?.[k]?.nodes ?? []).filter((n) => n && n.number).map(flat).filter((p) => allowed(p.repo, filter));
  // Drafts you're asked to review aren't ready for you yet.
  const review = arrange(nodes("review").filter((p) => !p.draft), sort);
  // All my own PRs, the ones needing action first (sort is stable: recency kept within each).
  const mine = arrange(nodes("mine"), sort)
    .map((p) => ({
      ...p,
      reasons: [p.decision === "CHANGES_REQUESTED" && "changes requested", (p.ci === "FAILURE" || p.ci === "ERROR") && "CI failing"].filter(Boolean),
    }))
    .sort((a, b) => (sort === "attention" ? Number(b.reasons.length > 0) - Number(a.reasons.length > 0) : 0));
  // Assigned / mentioned / commented / reviewed: one entry per PR, however it matched.
  const seen = new Set();
  const other = arrange([...nodes("involved"), ...nodes("reviewed")].filter((p) => !seen.has(p.url) && seen.add(p.url)), sort);
  return { review, mine, other, fix: mine.filter((p) => p.reasons.length).length };
}
