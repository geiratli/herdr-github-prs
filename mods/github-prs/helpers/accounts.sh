#!/bin/sh
# Prints the github.com logins known to gh, one per line, the active one first. Needs gh >= 2.40 (--json).
# Exit: 127 = gh not found, otherwise gh's own exit code.
command -v gh >/dev/null 2>&1 || PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v gh >/dev/null 2>&1 || exit 127
gh auth status --json hosts --jq '.hosts["github.com"] | sort_by(.active | not) | .[].login'
