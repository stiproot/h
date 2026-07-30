#!/usr/bin/env node
// Credential-at-rest guard — fail LOUDLY when a git config in this repo or the shared agent
// workspace carries an embedded credential (a tokened remote URL).
//
// The invariant: credentials are injected PER-OPERATION
// (git-core's resolveUrl, clone.sh's one-shot URL) and must never rest in a persisted remote URL.
// Observed live 2026-07-28/29: the shared pre-clone's origin carried the maintainer's PAT,
// readable by every agent uid — including the dropped SUB_AGENT_UID that exists specifically to
// execute untrusted work. This class recurs silently (`git clone <tokened-url>` persists the URL),
// so it is guarded, not just fixed. See the *Harden by encoding* principle in ARCHITECTURE.md.
//
// Scope: this repo's own .git config files, plus every clone in the shared workspace root
// (H_WORKSPACE_ROOT, default ../h-workspace) at depths 1–2 and their linked-worktree configs.
// The workspace being absent (CI) is fine — the guard checks whatever exists.
//
// Wired into `bun run lint` (package.json) beside the other content guards. No skip flag by design.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A line is a violation when it embeds a credential: a GitHub token in any known prefix form,
// the x-access-token basic-auth userinfo, or — the general class — any URL whose userinfo
// carries a password (`scheme://user:secret@host`).
const CREDENTIAL_PATTERNS = [
  /github_pat_[A-Za-z0-9_]+/,
  /\bgh[porsu]_[A-Za-z0-9]+/,
  /x-access-token:/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
];

/** True when a single config line embeds a credential. Exported pure for the guard's tests. */
export function lineHasCredential(line) {
  return CREDENTIAL_PATTERNS.some((p) => p.test(line));
}

/** Scan one file; returns violation line numbers. Redaction happens at report time, not here. */
export function scanFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return []; // unreadable (other uid, race with cleanup) — not this guard's failure to report
  }
  const hits = [];
  content.split("\n").forEach((line, i) => {
    if (lineHasCredential(line)) hits.push(i + 1);
  });
  return hits;
}

const safeReaddir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// The git config files of one clone: .git/config plus each linked worktree's config/config.worktree
// (worktree gitdirs live under <clone>/.git/worktrees/<name>/).
function cloneConfigFiles(gitDir) {
  const files = [];
  const mainConfig = join(gitDir, "config");
  if (existsSync(mainConfig)) files.push(mainConfig);
  for (const entry of safeReaddir(join(gitDir, "worktrees"))) {
    if (!entry.isDirectory()) continue;
    for (const name of ["config", "config.worktree"]) {
      const candidate = join(gitDir, "worktrees", entry.name, name);
      if (existsSync(candidate)) files.push(candidate);
    }
  }
  return files;
}

// Clones live at depth 1 (repo/, legacy checkouts) and depth 2 (per-run workspace dirs) of the
// workspace root — a bounded walk, deliberately not a full recursive scan of huge checkouts.
export function collectConfigFiles(workspaceRoot, repoRoot) {
  const files = [];
  if (repoRoot) files.push(...cloneConfigFiles(join(repoRoot, ".git")));
  for (const level1 of safeReaddir(workspaceRoot)) {
    if (!level1.isDirectory()) continue;
    const dir1 = join(workspaceRoot, level1.name);
    files.push(...cloneConfigFiles(join(dir1, ".git")));
    for (const level2 of safeReaddir(dir1)) {
      if (!level2.isDirectory() || level2.name === ".git") continue;
      files.push(...cloneConfigFiles(join(dir1, level2.name, ".git")));
    }
  }
  return files;
}

export function checkGitCredentials() {
  const workspaceRoot = process.env.H_WORKSPACE_ROOT ?? resolve(root, "../h-workspace");
  const violations = [];
  for (const file of collectConfigFiles(workspaceRoot, root)) {
    for (const line of scanFile(file)) violations.push({ file, line });
  }

  if (violations.length > 0) {
    console.error("✗ check-git-credentials: a git config carries an embedded credential.\n");
    console.error("  Credentials are injected per-operation and must never rest in a remote URL.");
    console.error("  Fix: git -C <clone> remote set-url origin <clean-url> — then ROTATE the token,");
    console.error;
    // File + line only — never echo the credential itself.
    for (const v of violations) console.error(`  ${v.file}:${v.line}`);
    return 1;
  }

  console.log("✓ check-git-credentials: no credential rests in any scanned git config");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkGitCredentials());
}
