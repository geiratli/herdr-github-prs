# Changelog

## Unreleased

First public version.

- Top-bar chip with review / mine / to fix / other / to clean counts, and a hover card listing the PRs.
- Click a PR to open it in a browser, a terminal or an agent, in a git worktree made for its branch;
  an agent already running in that checkout is focused instead of duplicated.
- Choose the GitHub account (token only in the helper's own process), per-account git folders,
  org/repo include and exclude filters, and the refresh interval.
- Worktrees of merged or closed PRs are offered for cleanup.
