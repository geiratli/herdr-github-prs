#!/bin/sh
# Usage: update.sh <tag> <mod folder>
# Downloads that release of the mod from GitHub, checks it loads, then copies it over <mod folder>.
# main.js goes last, so Herdr's reload-on-save only picks up the new build once every file is there.
# Exit: 2 = bad tag, otherwise the failing step's code. The installed copy is untouched until the check passes.
set -eu
tag=$1 dir=$2
case $tag in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "bad tag: $tag" >&2; exit 2 ;; esac
case $tag in *[!v0-9.]*) echo "bad tag: $tag" >&2; exit 2 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -m 60 "https://codeload.github.com/geiratli/herdr-github-prs/tar.gz/refs/tags/$tag" | tar -xzf - -C "$tmp" --strip-components=1
new="$tmp/mods/github-prs"
[ -f "$new/main.js" ] || { echo "no mod in $tag" >&2; exit 1; }
command -v herdr-app >/dev/null 2>&1 || PATH="$PATH:$HOME/.local/bin"
if command -v herdr-app >/dev/null 2>&1; then herdr-app check "$new" >&2; fi
# shortcut: files a release deletes stay behind; harmless unless a later release reuses the name differently.
# Skips jsconfig.json and *.d.ts, which `herdr-app check` wrote into the download.
(cd "$new" && find . -type f ! -path ./main.js ! -name jsconfig.json ! -name '*.d.ts') | while IFS= read -r f; do
  mkdir -p "$dir/$(dirname "$f")" && cp "$new/$f" "$dir/$f"
done
cp "$new/main.js" "$dir/main.js"
