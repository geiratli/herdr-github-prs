// Run: node lib/repo.test.js
import assert from "node:assert";
import { slugFromRemote, parseWorktrees, branchFor, worktreePath, spaceFor } from "./repo.js";

assert.equal(slugFromRemote("git@github.com:Acme/widgets.git"), "acme/widgets");
assert.equal(slugFromRemote("https://github.com/o/r"), "o/r");
assert.equal(slugFromRemote("https://x-access-token:abc@github.com/o/r.git\n"), "o/r");
assert.equal(slugFromRemote("ssh://git@github.com/o/r.git"), "o/r");
assert.equal(slugFromRemote(""), null);

const wts = parseWorktrees(`worktree /r/main\nHEAD a\nbranch refs/heads/main\n\nworktree /r/old\nprunable gone\n\nworktree /w/feat\nHEAD b\ndetached\n\nworktree /w/x\nHEAD c\nbranch refs/heads/feat/x\n`);
assert.deepEqual(wts, [{ path: "/r/main", branch: "main" }, { path: "/w/feat", branch: null }, { path: "/w/x", branch: "feat/x" }]);

assert.equal(branchFor({ number: 7, headRef: "feat/x", cross: false }), "feat/x");
assert.equal(branchFor({ number: 7, headRef: "main", cross: true }), "pr-7");
assert.equal(worktreePath("/h", "widgets", "ISSUE-1/fix it"), "/h/.herdr/worktrees/widgets/ISSUE-1-fix-it");
assert.equal(worktreePath("/h", "widgets", "a/b", "/data/wt/"), "/data/wt/widgets/a-b");

const spaces = [{ id: "s1", tabs: [{ id: "t1" }], folder: "/r/main" }, { id: "s2", tabs: [{ id: "t2" }], folder: "/x" }, { id: "s3", machine: "mini", tabs: [], folder: "/w/x" }];
const panes = [{ tab: "t1", cwd: "/r/main" }, { tab: "t2", cwd: "/w/x/sub" }];
const all = ["/r/main", "/w/x"];
assert.equal(spaceFor("/w/x", all, spaces, panes).id, "s2");          // pane inside the worktree
assert.equal(spaceFor("/r/main", all, spaces, panes).id, "s1");
assert.equal(spaceFor("/w/feat", all, spaces, panes), undefined);     // no space open: caller makes one
console.log("ok");
