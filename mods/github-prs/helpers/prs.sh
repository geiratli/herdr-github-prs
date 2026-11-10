#!/bin/sh
# Prints one GraphQL JSON reply: every open PR involving me (review requested, mine,
# involved: assigned/mentioned/commented, reviewed), with review decision and CI rollup. Uses your own `gh` login; reads no tokens.
# Exit: 127 = gh not found, otherwise gh's own exit code.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v gh >/dev/null 2>&1 || exit 127
F='nodes { ... on PullRequest { number title url isDraft headRefName isCrossRepository reviewDecision repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }'
exec gh api graphql -f query="{
  review: search(query: \"is:pr is:open review-requested:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
  mine: search(query: \"is:pr is:open author:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
  involved: search(query: \"is:pr is:open involves:@me -author:@me -review-requested:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
  reviewed: search(query: \"is:pr is:open reviewed-by:@me -author:@me -review-requested:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
}"
