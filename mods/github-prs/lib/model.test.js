// Run: node lib/model.test.js
import assert from "node:assert";
import { allowed, parseList, summarize } from "./model.js";

const pr = (o) => ({ number: 1, title: "t", url: "u" + (o.number ?? 1), isDraft: false, headRefName: "b", isCrossRepository: false, reviewDecision: null, repository: { nameWithOwner: "o/r" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...o });
const out = summarize({ data: {
  review: { nodes: [pr({ number: 1 }), pr({ number: 2, isDraft: true }), {}] },
  mine: { nodes: [
    pr({ number: 3 }),
    pr({ number: 4, reviewDecision: "CHANGES_REQUESTED" }),
    pr({ number: 5, commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }),
    pr({ number: 6, reviewDecision: "CHANGES_REQUESTED", commits: { nodes: [] } }),
  ] },
  involved: { nodes: [pr({ number: 7 }), pr({ number: 8 })] },
  reviewed: { nodes: [pr({ number: 8 }), pr({ number: 9 })] },
} });
assert.deepEqual(out.review.map((p) => p.number), [1]);               // draft and empty node dropped
assert.deepEqual(out.mine.map((p) => p.number), [4, 5, 6, 3]);        // all mine, needing action first
assert.deepEqual(out.mine[1].reasons, ["CI failing"]);
assert.equal(out.fix, 3);
assert.deepEqual(out.other.map((p) => p.number), [7, 8, 9]);          // #8 matched twice, listed once
assert.deepEqual(summarize(null), { review: [], mine: [], other: [], fix: 0 }); // gh failed: no crash
const f = { include: ["Acme"], exclude: ["acme/secret"] };
assert.ok(allowed("acme/widgets", f) && !allowed("acme/secret", f) && !allowed("other/x", f));
assert.ok(allowed("acme-labs/x", { exclude: ["acme"] }) && !allowed("acme/x", { exclude: ["acme"] })); // org match is not a prefix match
assert.ok(allowed("o/r") && allowed("o/r", { include: [] }));
assert.deepEqual(parseList(" a/b, c  d,,"), ["a/b", "c", "d"]);
assert.deepEqual(summarize({ data: { review: { nodes: [pr({ number: 1 })] } } }, { exclude: ["o"] }).review, []);
const t = (n, repo, updated, extra = {}) => pr({ number: n, repository: { nameWithOwner: repo }, updatedAt: updated, ...extra });
const reply = { data: { mine: { nodes: [t(1, "b/x", "2026-01-03"), t(2, "a/y", "2026-01-01"), t(3, "b/x", "2026-01-02", { reviewDecision: "CHANGES_REQUESTED" })] } } };
assert.deepEqual(summarize(reply).mine.map((p) => p.number), [3, 1, 2]);              // attention: needing action first, then recent
assert.deepEqual(summarize(reply, undefined, "recent").mine.map((p) => p.number), [1, 3, 2]); // pure recency
assert.deepEqual(summarize(reply, undefined, "repo").mine.map((p) => p.number), [2, 1, 3]);   // a/y, then b/x newest first
console.log("ok");
