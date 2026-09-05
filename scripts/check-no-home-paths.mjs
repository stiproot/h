#!/usr/bin/env node
/**
 * This repo is SELF-CONTAINED: no command or path it ships may resolve through `~/.claude`.
 *
 * WHY. A home-anchored path resolves on exactly one machine. On every other it means something
 * different or nothing at all — a different plugin version, a different operator's skills, or an
 * empty directory — and it fails silently rather than loudly, because the reader assumes the file
 * is simply absent. `check-steering.mjs` has banned `~/.claude/skills/...` inside a SKILL.md since
 * 2026-08-31 for exactly this reason; this guard extends the rule to everything else the repo
 * ships, which is where it leaked back in.
 *
 * THE INCIDENT (2026-09-05). A research plan told its implementer to read the Effect plugin's
 * corpus from `~/.claude/plugins/cache/effect-primitives/.../skills/*` and quoted four commands
 * doing so. It passed every existing guard. The plugin is a PUBLISHED artifact this repo already
 * declares in `.claude/settings.json`, so the self-contained resolution was a pinned fetch — the
 * same shape as `uvx vizzle@0.2.0` and `bunx @ast-grep/cli@0.45.3` in the lint chain. Reading the
 * local install would also have been WRONG: h's project scope sat at plugin 1.0.0 while every
 * worktree ran 1.1.0, so a generator would emit different rules depending on where it ran.
 *
 * WHAT IS ALLOWED, and why the line sits where it does. Prose may discuss `~/.claude` freely —
 * describing the runtime, or stating this very rule, is not depending on it. Nor is a directory
 * tree or a quoted program output that happens to contain one. What is banned is a home path in a
 * LANGUAGE-TAGGED fence (```sh, ```yaml, ```json, ```ts …) — content meant to be RUN or PARSED.
 *
 * That distinction was found by testing, not assumed: the first version banned every fenced
 * occurrence and immediately flagged three innocent ones — README's directory tree and two rows of
 * a table in `review-context-fidelity.md`, all in bare ``` fences. A guard that cries wolf is one
 * people route around, so it checks the tagged fences where a path is actually followed.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync("git ls-files 'docs/**/*.md' 'scripts/**' '*.md' '.h/**'", {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((f) => /\.(md|mjs|js|ts|sh)$/.test(f));

const findings = [];
for (const file of files) {
  if (file === "scripts/check-no-home-paths.mjs") continue; // this file documents the pattern
  let fenceLang = null; // null = outside a fence; "" = bare fence (prose/diagram/output)
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const fence = line.trimStart().match(/^```(\S*)/);
    if (fence) {
      fenceLang = fenceLang === null ? fence[1].toLowerCase() : null;
      return;
    }
    // A markdown line counts only inside a fence that declares a language — that is content meant
    // to be run or parsed. A script line always counts unless it is a comment.
    const executable = file.endsWith(".md")
      ? Boolean(fenceLang)
      : !line.trimStart().startsWith("//");
    if (executable && /~\/\.claude\//.test(line)) {
      findings.push({ file, line: i + 1, text: line.trim().slice(0, 100) });
    }
  });
}

if (findings.length > 0) {
  console.error("✗ check-no-home-paths: a `~/.claude/…` path in runnable content\n");
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`);
  console.error(
    "\n  A home path resolves on one machine only, and fails silently everywhere else." +
      "\n  Resolve external corpora from a PINNED SOURCE the repo declares (the `uvx vizzle@0.2.0`" +
      "\n  shape), not from whatever happens to be installed in a home directory." +
      "\n  Prose may discuss `~/.claude`; a command that follows it may not.\n",
  );
  process.exit(1);
}

console.log(`✓ check-no-home-paths: no home-anchored paths in runnable content (${files.length} files)`);
