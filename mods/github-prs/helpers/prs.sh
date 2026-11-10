#!/bin/sh
# Usage: prs.sh [login]   ("" or none = the active gh account)
# Prints one GraphQL JSON reply: every open PR involving that account (review requested, mine,
# involved: assigned/mentioned/commented, reviewed), with review decision and CI rollup.
# Goes through gh.sh, so the token stays in the child's environment. Exit codes as gh.sh.
F='nodes { ... on PullRequest { number title url updatedAt isDraft headRefName isCrossRepository reviewDecision repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }'
exec sh "$(dirname "$0")/gh.sh" "${1:-}" api graphql -f query="{
  review: search(query: \"is:pr is:open review-requested:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
  mine: search(query: \"is:pr is:open author:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
  involved: search(query: \"is:pr is:open involves:@me -author:@me -review-requested:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
  reviewed: search(query: \"is:pr is:open reviewed-by:@me -author:@me -review-requested:@me archived:false sort:updated-desc\", type: ISSUE, first: 100) { $F }
}"
