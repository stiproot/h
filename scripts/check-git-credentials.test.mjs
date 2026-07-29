import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectConfigFiles, lineHasCredential, scanFile } from "./check-git-credentials.mjs";

test("flags every known credential form in a config line", () => {
  const tokened = [
    "\turl = https://x-access-token:github_pat_11ABC_deF@github.com/o/r.git",
    "\turl = https://x-access-token:ghp_abc123@github.com/o/r.git",
    "\turl = https://oauth2:ghs_abc123@github.com/o/r.git",
    "\turl = https://user:plainpassword@gitlab.example.com/o/r.git", // general class, not GitHub-specific
  ];
  for (const line of tokened) assert.equal(lineHasCredential(line), true, line);
});

test("accepts clean remote URLs in every sanctioned form", () => {
  const clean = [
    "\turl = https://github.com/stiproot/h.git",
    "\turl = git@github.com:stiproot/h.git", // scp-style ssh — userinfo without a password
    "\turl = ssh://git@github.com/stiproot/h.git",
    "\turl = /local/path/repo",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  ];
  for (const line of clean) assert.equal(lineHasCredential(line), false, line);
});

test("scans a workspace's clones at depth 1 and 2 plus linked-worktree configs", () => {
  const ws = mkdtempSync(join(tmpdir(), "check-creds-test-"));
  try {
    // depth-1 clone with a tokened origin + a linked worktree config
    mkdirSync(join(ws, "repo", ".git", "worktrees", "wt-1"), { recursive: true });
    writeFileSync(
      join(ws, "repo", ".git", "config"),
      '[remote "origin"]\n\turl = https://x-access-token:ghp_secret@github.com/o/r.git\n',
    );
    writeFileSync(join(ws, "repo", ".git", "worktrees", "wt-1", "config.worktree"), "[core]\n");
    // depth-2 clone (a per-run workspace dir), clean
    mkdirSync(join(ws, "run-1", "checkout", ".git"), { recursive: true });
    writeFileSync(
      join(ws, "run-1", "checkout", ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    );

    const files = collectConfigFiles(ws, undefined);
    assert.equal(files.length, 3);
    const flagged = files.filter((f) => scanFile(f).length > 0);
    assert.deepEqual(flagged, [join(ws, "repo", ".git", "config")]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("an absent workspace root scans nothing and flags nothing", () => {
  assert.deepEqual(collectConfigFiles("/nonexistent/nowhere", undefined), []);
});
