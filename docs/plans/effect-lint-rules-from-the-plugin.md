# Generate Effect lint rules from the effect-claude-primitives plugin

Status: Planning — a stub with the feasibility question already answered YES; what remains is the
generation/refresh design and the rule corpus. **Revisit when:** the Effect audit's findings
recur (a fourth Effect idiom defect), or when the plugin publishes a version whose guidance the
repo has not reviewed.
Established: 2026-09-05

## Why this exists

The 2026-09-05 Effect audit found three classes of problem and fixed all three by hand:

1. a raw `try/catch` inside `Effect.gen` that REPLACED an idiomatic `Effect.try` (#142);
2. **nine** `Effect.promise(...).pipe(Effect.ignore)` pairs — a rejection is a defect and
   `ignore` cannot catch defects, so every one said "swallow this" and would die instead (#143);
3. eight plain `extends Error` classes where the repo's other 39 error sites use
   `Data.TaggedError` (#144).

Only (2) is guarded today, by a bespoke `scripts/check-effect-idioms.mjs`. The general problem is
that **the standards live in a plugin that evolves upstream**, while the enforcement lives in
hand-written guards that do not. The rules and the guards drift apart silently, which is the
same failure mode `vizzle doc --check` exists to prevent for diagrams.

## Feasibility — already established, do not re-litigate

- **`oxlint` cannot host these rules.** v1.66 exposes a FIXED plugin set (unicorn, oxc,
  typescript, import, react, jsdoc, jest, vitest, jsx-a11y, nextjs, react-perf) with no
  user-defined rule flag. The repo does not use ESLint, and adding it for this would be a large
  new dependency surface.
- **`ast-grep` can, and needs no install** — `bunx @ast-grep/cli` (0.45.3 verified), the same
  zero-lockfile model as `uvx vizzle`. Both audit findings were expressed as short YAML rules and
  verified against a fixture on 2026-09-05:
  - `pattern: Effect.promise($$$ARGS).pipe(Effect.ignore)` — flagged the defect shape, left
    `Effect.tryPromise(...).pipe(Effect.ignore)` and a bare `Effect.promise(...)` alone. Six
    lines of YAML replace the 60-line paren-balancing guard, with better precision.
  - `kind: try_statement` + `inside: { pattern: Effect.gen($$$), stopBy: end }` — flagged the
    raw try/catch inside a generator and ignored both an `Effect.try` and a plain function's
    `try/catch`.

So the question is NOT "can we lint this" (yes) but "how do the rules stay in step with a plugin
that evolves".

## The open questions — what the research chain must answer

1. **How much can be GENERATED rather than hand-written?** The plugin's skills carry paired
   good/bad code fences. Can a generator extract a usable rule from a fence pair, or is the
   realistic output a rule STUB plus a manifest linking it to its source skill? State this with
   evidence from the actual corpus, not in principle.
2. **What does refresh look like?** Proposal to test: a `scripts/gen-effect-rules.mjs` that reads
   the installed plugin's `skills/**/SKILL.md` + `references/*.md`, writes/refreshes rule files
   under `rules/effect/`, and records each rule's SOURCE (skill name + content hash). A drift
   check then fails the build when a source skill's hash moves and its rule has not been
   reviewed — the `vizzle doc --check` pattern.
3. **Where does the plugin come from at generation time?** It is installed per project scope
   under `~/.claude/plugins/cache/…`, versioned (h was pinned to 1.0.0 while worktrees ran
   1.1.0). A generator must resolve a KNOWN version, not "whatever is installed", or CI and a
   developer box disagree.
4. **Which rules are worth having?** Rank by evidence: an idiom that has actually cost this repo
   a defect outranks one that is merely in the guide. Start from the three audit findings.
5. **Does it replace or complement `check-effect-idioms.mjs`?** If ast-grep covers the rule with
   fewer lines and fewer false positives, the bespoke guard should go — carrying its header
   comment's incident record into the rule's `message`/`note` so the reasoning is not lost.
6. **CI cost.** `bunx @ast-grep/cli` fetches on demand; measure it in the guard chain and decide
   whether to pin a version the way lint pins `vizzle@0.2.0`.

## Non-goals

- Replacing the plugin's skills with lint rules. The skills teach; the rules catch. A rule cannot
  convey the mental model, and a skill cannot fail a build.
- Auto-fixing. Every finding so far needed a judgement about intent (`ignore` vs a typed error).

## Constraints inherited from this repo

- A new guard goes in `scripts/`, into `package.json`'s `lint` chain, and into CLAUDE.md's guards
  table in the SAME change, with its motivating incident in the header comment.
- A guard that cries wolf gets routed around: the first version of `check-effect-idioms.mjs`
  false-positived by regex-matching a bounded gap, and had to be rewritten to balance parens.
  Any generated rule needs a fixture proving it fires on the bad shape and stays silent on the
  good one.
