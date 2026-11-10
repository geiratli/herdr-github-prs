# Recipe: add github-prs to Herdr

## With an agent

Tell your coding agent:

> Read ~/.config/herdr-app/AGENTS.md, then add the mod at https://github.com/geiratli/herdr-github-prs

It should copy `mods/github-prs/` into `~/.config/herdr-app/mods/`, run `herdr-app check`, and add the layout
block below.

## By hand

```sh
git clone https://github.com/geiratli/herdr-github-prs
cp -R herdr-github-prs/mods/github-prs ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/github-prs
```

Add this block to a layout in `~/.config/herdr-app/layouts/`, in a top row next to the tabs:

```json
{ "content": { "mod": "github-prs", "props": { "anchor": "top" } }, "size": { "px": 340 } }
```

Leave out `"anchor": "top"` for a bottom status row (the card then opens upward).

## First run

1. Hover the chip, then open ⚙ and choose the GitHub account (default: gh's active one).
2. Add the folders that hold your repositories, so a PR's repo can be found locally.
3. Click a PR to open it in a browser, a terminal or an agent.

## Requirements

Herdr desktop app (tested with 0.1.14), `gh` logged in (2.40+ for the account picker) and `git`. macOS only is tested.
See the README for what the mod runs and writes.
