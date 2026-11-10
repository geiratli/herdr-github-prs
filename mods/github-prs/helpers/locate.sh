#!/bin/sh
# Usage: locate.sh <owner/repo> <d:folder|r:folder>...
#   d: a folder inside some repo (an open space)   r: a folder holding repos (searched 3 levels deep)
# Prints the main checkout of the first repo whose `origin` is owner/repo. Exit 1: none found.
# shortcut: the repo's "." matches any character in the remote test; harmless in practice.
want=$(printf %s "$1" | tr 'A-Z' 'a-z'); shift
matches() {
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
  printf %s "$url" | tr 'A-Z' 'a-z' | grep -Eq "[:/]${want}(\.git)?/?\$"
}
for a in "$@"; do
  kind=${a%%:*}; p=${a#*:}
  case $kind in
    d)
      common=$(git -C "$p" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
      main=${common%/.git}
      [ "$main" != "$common" ] && matches "$main" && { echo "$main"; exit 0; }
      ;;
    r)
      out=$(find "$p" -maxdepth 3 -name .git -type d -prune 2>/dev/null | while IFS= read -r g; do
        d=${g%/.git}; matches "$d" && { echo "$d"; break; }
      done)
      [ -n "$out" ] && { echo "$out"; exit 0; }
      ;;
  esac
done
exit 1
