#!/usr/bin/env node
/**
 * Effect idioms that a type-checker cannot catch.
 *
 * WHY THIS EXISTS. `Effect.promise(...)` assumes the promise never rejects: a rejection becomes a
 * DEFECT (`Cause.Die`), and `Effect.ignore` — which reads exactly like "swallow this" — does NOT
 * catch defects. So `Effect.promise(() => c.stop()).pipe(Effect.ignore)` states one intent and
 * does the opposite: the finalizer dies instead of being ignored. Proven empirically on
 * 2026-09-05 (effect 3.21): `Effect.promise(reject).pipe(Effect.ignore)` exits `Die`, while
 * `Effect.tryPromise({...}).pipe(Effect.ignore)` exits `Success`.
 *
 * The audit that found it: 9 instances repo-wide — 8 Dapr client `stop()` release finalizers in
 * workflow-svc plus one cleanup in agent-cli — every one written with `Effect.ignore`, i.e. every
 * author intended the failure to be swallowed. A latent crash on shutdown that no test would show.
 *
 * The rule: if a promise CAN reject, lift it with `Effect.tryPromise` so the failure lands in the
 * typed error channel where `ignore`/`orElse`/`catchAll` can actually reach it. `Effect.promise`
 * stays legal for promises that genuinely cannot reject — this guard only rejects the pairing with
 * `ignore`, which is the shape that provably lies about what it does.
 *
 * Steering: CLAUDE.md's "Effect code follows the effect-claude-primitives plugin" section, and the
 * plugin's own effect-error-handling / effect-core-concepts skills.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  "git ls-files 'packages/js/**/*.ts' 'apps/**/*.ts' | grep -v '\\.test\\.ts$'",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

// Match `Effect.promise( ... )` by BALANCING PARENS, then require the very next non-whitespace
// text to be `.pipe(Effect.ignore)`. A looser regex with a bounded gap over-matches: it happily
// paired an `Effect.promise(() => pendingAppends)` with the `.pipe(Effect.ignore)` of a LATER,
// unrelated statement in run-ledger.ts. A guard that cries wolf is one people route around, so
// the scan is exact rather than approximate.
const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  let from = 0;
  for (;;) {
    const at = text.indexOf("Effect.promise(", from);
    if (at === -1) break;
    from = at + "Effect.promise(".length;
    let depth = 0;
    let end = -1;
    for (let i = at + "Effect.promise".length; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    const rest = text.slice(end).replace(/^\s*/, "");
    if (rest.startsWith(".pipe(Effect.ignore)")) {
      findings.push({ file, line: text.slice(0, at).split("\n").length });
    }
  }
}

if (findings.length > 0) {
  console.error("✗ check-effect-idioms: Effect.promise piped into Effect.ignore\n");
  for (const f of findings) console.error(`  ${f.file}:${f.line}`);
  console.error(
    "\n  A rejected Effect.promise is a DEFECT, and Effect.ignore does not catch defects —" +
      "\n  so this says 'swallow the failure' and dies instead. Use Effect.tryPromise:" +
      "\n\n    Effect.tryPromise({ try: () => p(), catch: (cause) => cause }).pipe(Effect.ignore)\n",
  );
  process.exit(1);
}

console.log(`✓ check-effect-idioms: no Effect.promise/ignore defect pairs (${files.length} files scanned)`);
