// Pure: gh's GraphQL reply → what the bar and card show.
const flat = (n) => ({
  repo: n.repository.nameWithOwner,
  number: n.number,
  title: n.title,
  url: n.url,
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

export function summarize(reply, filter) {
  const nodes = (k) => (reply?.data?.[k]?.nodes ?? []).filter((n) => n && n.number).map(flat).filter((p) => allowed(p.repo, filter));
  // Drafts you're asked to review aren't ready for you yet.
  const review = nodes("review").filter((p) => !p.draft);
  // All my own PRs, the ones needing action first (sort is stable: recency kept within each).
  const mine = nodes("mine")
    .map((p) => ({
      ...p,
      reasons: [p.decision === "CHANGES_REQUESTED" && "changes requested", (p.ci === "FAILURE" || p.ci === "ERROR") && "CI failing"].filter(Boolean),
    }))
    .sort((a, b) => Number(b.reasons.length > 0) - Number(a.reasons.length > 0));
  // Assigned / mentioned / commented / reviewed: one entry per PR, however it matched.
  const seen = new Set();
  const other = [...nodes("involved"), ...nodes("reviewed")].filter((p) => !seen.has(p.url) && seen.add(p.url));
  return { review, mine, other, fix: mine.filter((p) => p.reasons.length).length };
}
