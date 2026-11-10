#!/bin/sh
# Usage: gh.sh <login|""> <gh args...>
# Runs `gh` as <login> without `gh auth switch`: the token goes only into this child's
# environment (GH_TOKEN), never to the mod, a log or the screen. "" = the active gh account.
# Exit: 127 = gh not found, 126 = no such login, otherwise gh's own exit code.
command -v gh >/dev/null 2>&1 || PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" # macOS/Homebrew fallback only
command -v gh >/dev/null 2>&1 || exit 127
login=$1; shift
if [ -n "$login" ]; then
  GH_TOKEN=$(gh auth token --user "$login" 2>/dev/null) && [ -n "$GH_TOKEN" ] || { echo "no gh login for $login" >&2; exit 126; }
  export GH_TOKEN
fi
exec gh "$@"
