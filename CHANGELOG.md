# Changelog

## v0.1.0 - 2026-11-11

First public version.

- Top-bar chip with review / mine / to fix / other / to clean counts, and a hover card listing the PRs
  (600 px wide, the title on one line and the repo, number and status pills below; the tooltip has the full title).
- Click a PR to open it in a browser, a terminal or an agent, in a git worktree made for its branch;
  an agent already running in that checkout is focused instead of duplicated.
- Choose the GitHub account (token only in the helper's own process), per-account git folders,
  org/repo include and exclude filters, sorting (attention, recent, by repo) and the refresh interval.
- Account avatars, cached once under `~/.config/herdr-app/data/github-prs/avatars/`.
- Worktrees of merged or closed PRs are offered for cleanup.

Tested on macOS with Herdr 0.1.14. Fork PRs are untested.
