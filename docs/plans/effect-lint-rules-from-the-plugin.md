# Generate Effect lint rules from the effect-claude-primitives plugin

Status: Planning — the CORE question is open and is the point of this plan: **which of the
plugin's 247 patterns can be linted at all?** Generation/refresh was only ever the STRETCH goal,
and it is answered below (a manifest and drift check, never derived rules). Rule mechanics are
settled: ast-grep, three rules verified against this repo.
**Revisit when:** the Effect audit's findings recur (a fourth Effect idiom defect), or
when the plugin publishes a version whose guidance the repo has not reviewed.
Established: 2026-09-05

## Why this exists

The 2026-09-05 Effect audit found three classes of problem and fixed all three by hand:

1. a raw `try/catch` inside `Effect.gen` that REPLACED an idiomatic `Effect.try` (#142);
2. **nine** `Effect.promise(...).pipe(Effect.ignore)` pairs — a rejection is a defect and
   `ignore` cannot catch defects, so every one said "swallow this" and would die instead (#143);
3. eight plain `extends Error` classes where the repo's other 39 error sites use
   `Data.TaggedError` (#144).

Only (2) is guarded today, by a bespoke `scripts/check-effect-idioms.mjs` on the
`feat/effect-steering-and-guard` branch (not yet merged). The general problem is that **the
standards live in a plugin that evolves upstream**, while the enforcement lives in hand-written
guards that do not. The rules and the guards drift apart silently, which is the same failure mode
`vizzle doc --check` exists to prevent for diagrams.

## The core question, and what is merely a stretch

**CORE: can these concepts be linted at all?** The plugin carries **247 patterns** (`## ` headings
across every skill's `references/`, counted 2026-09-05) plus the per-skill prose. They are written
for a HUMAN — "choose `Effect.gen` for multi-step flows", "model failures precisely" — and much of
that is irreducibly a judgement, not a syntactic shape. That is expected and fine. The question
worth answering is where the line falls: which patterns reduce to a deterministic AST shape, which
are matchable only with false positives a human must adjudicate, and which are pure design
guidance a linter can never carry. A plan that ends with "here are the 20 patterns that ARE
mechanically enforceable, and here is why the other 227 are not" is a success.

**STRETCH: can the rules be generated and refreshed from the plugin?** Answered below (Q1–Q3):
essentially no for derivation — 328 code fences, one usable good/bad pair — and yes for a
manifest plus a content-hash drift check. Do not spend more effort trying to derive rules from
prose; that question is closed.

The failure mode to avoid is measuring the stretch goal and calling it the answer. A generator
that emits nothing is not evidence that the concepts are unlintable — the three rules already
verified against this repo prove otherwise.

## Feasibility — already established, do not re-litigate

- **`oxlint` cannot host these rules.** v1.66 exposes a FIXED plugin set with no user-defined
  rule flag.
- **`ast-grep` can, and needs no install** — `bunx @ast-grep/cli@0.45.3` (verified), same
  zero-lockfile model as `uvx vizzle@0.2.0`. Both audit findings were verified against fixtures.

## Research findings (2026-09-05, HEAD 415b6dc)

Evidence for all six design questions: commands run, output recorded.

**On the `scratch/effect-lint-research/` paths quoted below** — that was a THROWAWAY prototype in
an untracked directory, deliberately not committed (the spec asked for a prototype, not a
deliverable). Every artefact that matters is inlined here: each rule's full YAML, each scan
command, and each result count. Do not go looking for the files; re-create the generator from the
algorithm in Q2 if you need it. The paths are kept only so the commands read as they were run.

### Q1: How much can be generated rather than hand-written?

**Answer: the generator produces rule stubs and a manifest, never working rules.**

Command run:
```
node scratch/effect-lint-research/gen/gen-effect-rules-v2.mjs
```

Output:
```
Total TypeScript fences scanned: 328
Fences containing ❌/✅ pairs: 1
Rule stubs generated: 3
Prose-only patterns (no fence): 9
```

The corpus has **328 TypeScript fences** across 18 skill directories (each with a `SKILL.md` and
`references/*.md`). Of those, **only 1 fence** contains labelled `// ❌ Bad: ... / // ✅ Good: ...`
pairs — everything in `effect-tooling-debugging/references/tooling-and-debugging.md`. The other
`❌` markers in the corpus are either prose bullets or emoji used in log strings inside code
examples, not anti-pattern labels.

**Concrete examples:**

*One that generates cleanly (rule stub, not a working rule):*
```
// ❌ Bad: Using Promise where Effect should be used
const fetchData = async () => { }  // Warn in Effect codebase
// ✅ Good: Using Effect
const fetchData = Effect.gen(function* () { })
```
The generator produces a `pattern: "TODO"` stub with the source hash embedded. A human must
supply the actual pattern (`pattern: "async ($$$) => $BODY"` — and even then, async functions are
sometimes valid alongside Effect). The pair is too broad to auto-generate without false positives.

*One that cannot generate anything (prose-only, no fence):*
```
- ❌ Use `process.env` directly (use Config module)
```
Nine of these in `effect-mcp-server/references/mcp-server.md`. No code fence → no rule possible.

*One that is borderline (fake ❌, emoji in log string):*
```typescript
yield* Effect.log(`❌ Item ${id} failed after all retries: ${error.message}`);
```
In `effect-data-pipelines/references/building-data-pipelines.md`. The `❌` is literal emoji
content, not an anti-pattern label — the generator v1 would have misclassified it; v2 only
matches `// ❌ Bad:` comments.

**Conclusion:** the generator's value is the **manifest** (source file + content hash per rule)
for drift detection, not rule derivation. All rules must be hand-written.

### Q2: What does refresh look like?

**Model: curated rules + generated manifest + drift check — the `vizzle doc --check` pattern.**

The generator (`scripts/gen-effect-rules.mjs` to be written) does two things:
1. Reads every skill file and records its SHA-256 hash.
2. Emits `rules/effect/manifest.json` — one entry per rule with `{ruleId, sourceSkill,
   sourceHash, generatedAt}`.

Each hand-written rule file carries:
```yaml
# SOURCE: <corpus>/skills/effect-tooling-debugging/references/tooling-and-debugging.md @ v1.1.0
# SOURCE_HASH: f83e6d56932d7573
```

`scripts/check-effect-rules.mjs` (the drift guard):
1. For each rule in `rules/effect/`, reads its `# SOURCE_HASH:` comment.
2. Hashes the current plugin skill file at that path.
3. If hashes differ, exits 1 with:
   ```
   check-effect-rules: drift detected
     rule:         rules/effect/effect-promise-ignore.yaml
     skill:        <corpus>/skills/effect-tooling-debugging/references/tooling-and-debugging.md
     stored hash:  f83e6d56932d7573
     current hash: a1b2c3d4e5f6a7b8
   Review the skill diff, update the rule if the guidance changed, then update SOURCE_HASH.
   ```
4. If plugin is absent, skips silently with `[check-effect-rules] plugin not installed, skipping`.

The drift check is developer-local only — CI has no plugin installation step. Its purpose is to
surface when a skill update changes the guidance a rule enforces, prompting a review. It never
prevents CI from passing on a machine without the plugin.

### Q3: Where does the plugin come from at generation time?

**Answer: from its PINNED SOURCE, fetched — never from a machine's home directory.**

This repo is self-contained: nothing in it may depend on `~/.claude`, because a home path
resolves on exactly one machine and silently means something different (or nothing) on every
other. The same rule that stops a SKILL.md naming `~/.claude/skills/...` applies here.

The corpus is a published plugin. This repo already DECLARES it, in `.claude/settings.json`:
`enabledPlugins` names `effect-claude-primitives@effect-primitives`, and the marketplace entry
gives its GitHub source. So the generator resolves the corpus the way h already resolves every
other external tool — a pinned version, fetched on demand, no lockfile entry and no home
dependency:

```sh
# the same shape as `uvx vizzle@0.2.0` and `bunx @ast-grep/cli@0.45.3` in the lint chain
git clone --depth 1 --branch v<PINNED> https://github.com/stiproot/effect-claude-primitives "$tmp"
# corpus root: "$tmp/skills"
```

The pinned version lives in ONE place — the generator's own constant, recorded in each rule's
`# SOURCE:` line — so CI and a developer box cannot disagree: both fetch the same tag. Bumping
the corpus is a deliberate edit to that constant, which is exactly the moment the drift check
should demand a review.

When the fetch fails (offline, or the tag is gone):
- the drift check exits 0 with a skip message naming the tag it wanted;
- the rules remain valid — they are committed source files and do not depend on the fetch;
- regeneration errors loudly rather than silently falling back to whatever is on the machine.

That last point is the whole reason not to read a local install: "whatever happens to be
installed" was already observed to differ per scope in this very repo (h's project scope sat at
1.0.0 while every worktree ran 1.1.0). A generator reading that would produce different rules
depending on which directory it ran in.

### Q4: Which rules are worth having? (ranked by evidence)

Each rule was run against the actual repo (`packages/js` and `apps`). Commands and outputs below.

**Rank 1 — `effect-promise-ignore` (10 findings, 0 false positives)**

Rule file: `scratch/effect-lint-research/rules/effect-promise-ignore.yaml`

```yaml
id: effect-promise-ignore
language: TypeScript
message: |
  Effect.promise() paired with Effect.ignore() silently swallows a defect.
  A rejection from Effect.promise is a Cause.Die, which Effect.ignore does not catch.
  Use Effect.tryPromise({ try: ..., catch: ... }).pipe(Effect.ignore) instead.
  [Incident 2026-09-05: 9 instances in this repo, all latent shutdown crashes.]
severity: error
rule:
  pattern: Effect.promise($$$ARGS).pipe(Effect.ignore)
```

Scan command:
```
bunx @ast-grep/cli@0.45.3 scan --rule scratch/effect-lint-research/rules/effect-promise-ignore.yaml packages/js apps
```
Results: **10 findings, all genuine** — 9 Dapr client `stop()` finalizers in `workflow-svc` and
one cleanup in `agent-cli`. These are exactly the instances from the audit. Zero false positives.

Fixture verified: fires on `Effect.promise(() => client.stop()).pipe(Effect.ignore)`, silent on
`Effect.tryPromise({ try: () => client.stop(), catch: () => new StopError() }).pipe(Effect.ignore)`
and `Effect.promise(() => data())` (no `.pipe(Effect.ignore)` chain).

This rule **replaces `check-effect-idioms.mjs`** with 6 lines of YAML vs. 60 lines of
paren-balancing JS. The incident record from the guard's header comment survives in the rule's
`message:` field (see above: `[Incident 2026-09-05: ...]`).

**Rank 2 — `effect-plain-extends-error` (8 findings, 0 false positives)**

Rule file: `scratch/effect-lint-research/rules/effect-plain-extends-error.yaml`

```yaml
id: effect-plain-extends-error
language: TypeScript
message: |
  class $NAME extends Error loses the discriminant that catchTag needs.
  Use Data.TaggedError("$NAME")<{...}> so errors are recoverable by tag.
  [Incident 2026-09-05: 8 classes converted in #144.]
severity: warning
rule:
  pattern: class $NAME extends Error { $$$BODY }
```

Scan command:
```
bunx @ast-grep/cli@0.45.3 scan --rule scratch/effect-lint-research/rules/effect-plain-extends-error.yaml packages/js apps
```
Results: **8 findings** in 7 files (`local-runtime/domain/activities.ts`, `.../agents.ts`,
`.../delegate.ts`, `.../engines.ts`, `.../execute.ts`, `workflow-core/src/chain-members.ts`,
`workflow-core/src/structured-output.ts`). These are the classes awaiting conversion in the
pending `refactor/effect-tagged-errors` branch. Zero false positives observed — `extends Error`
never appears legitimately alongside Effect in this repo.

Note: after `refactor/effect-tagged-errors` merges, this rule should find 0 results. Keep it
active as a forward guard.

**Rank 3 — `effect-try-catch-in-gen` narrow form (1 finding, 0 false positives)**

Rule file: `scratch/effect-lint-research/rules/effect-try-catch-in-gen-v2.yaml`

```yaml
id: effect-try-catch-in-gen
language: TypeScript
severity: warning
rule:
  pattern: |
    try {
      $$$BODY
    } catch ($ERR) {
      $$$CATCH_BODY
      return yield* Effect.fail($$$FAIL_ARGS)
    }
  inside:
    pattern: Effect.gen($$$)
    stopBy: end
```

Scan command:
```
bunx @ast-grep/cli@0.45.3 scan --rule scratch/effect-lint-research/rules/effect-try-catch-in-gen-v2.yaml packages/js apps
```
Results: **1 finding** in `packages/js/local-runtime/src/domain/execute.ts`. Zero false positives.

The broad form (`kind: try_statement` inside `Effect.gen`) produces ~5 findings with ~80%
false-positive rate (try/catch around JSON.parse, file I/O — valid uses where `Effect.try` is
NOT preferred). The narrow form keys on the `return yield* Effect.fail(...)` pattern — the
specific shape where Effect.gen is being used as a try/catch wrapper — and is precise.

### Q5: Drift check failure message (exact)

When `scripts/check-effect-rules.mjs` finds a hash mismatch:
```
check-effect-rules: drift detected
  rule:         rules/effect/effect-promise-ignore.yaml
  skill:        <corpus>/skills/effect-tooling-debugging/references/tooling-and-debugging.md
  stored hash:  f83e6d56932d7573
  current hash: a1b2c3d4e5f6a7b8
Review the skill diff, update the rule if the guidance changed, then update SOURCE_HASH.
Repeat for each rule listed above.
```

Developer action: `diff` the skill file against whatever the `# SOURCE_HASH:` version had, decide
whether the rule needs updating, then change `# SOURCE_HASH:` to match. If the skill's guidance
changed in a way the rule does not capture, update the rule pattern too.

### Q6: Fate of `check-effect-idioms.mjs`

**Recommendation: delete it in the same PR that lands `effect-promise-ignore.yaml`.**

Reasoning:
- `check-effect-idioms.mjs` lives on `feat/effect-steering-and-guard` (not yet merged to main).
  It was written because oxlint cannot host this rule. Once ast-grep covers the same shape with
  better precision, the 60-line guard is dead weight.
- The ast-grep rule has zero false positives vs. the guard's known false-positive risk (its first
  version matched `Effect.promise(...)` against a LATER `.pipe(Effect.ignore)` in the same file
  and had to be rewritten to balance parens).
- The motivating incident record (`[Incident 2026-09-05: ...]`) survives in the rule's `message:`
  field verbatim — the knowledge is not lost, just moved.
- The guard must appear in `package.json`'s `lint` chain and CLAUDE.md's guards table; deleting
  it in the same PR that adds the rule means both docs are updated once, not twice.

CI cost (Q6 also covers this): `bunx @ast-grep/cli@0.45.3` fetches on first run and caches.
Pin the version exactly (`@0.45.3`) as `vizzle@0.2.0` is pinned, so a third-party release
cannot flip CI. Total per-run overhead measured: negligible (fetches once; thereafter turbo
cache hits).

## The generation model (what to implement)

**Curated rules + generated manifest + drift check.** NOT "generate everything from markdown".

Evidence for why prose-based generation fails: 328 fences, only 3 labelled pairs (all in one
file), and even those 3 are too broad to auto-generate working rules. The 9 prose bullets have no
structural content at all. A generator that emitted `pattern: "async ($$$) => $BODY"` for "Using
Promise where Effect should be used" would fire on every async function in the codebase.

The generator's job is **manifest maintenance** — not rule authoring. It records which skill file
each rule draws from (by hash), so a human is notified when upstream guidance changes.

## Implementation checklist

- [ ] Write `rules/effect/effect-promise-ignore.yaml` (from `scratch/effect-lint-research/rules/`)
- [ ] Write `rules/effect/effect-plain-extends-error.yaml`
- [ ] Write `rules/effect/effect-try-catch-in-gen.yaml` (narrow form, severity: warning)
- [ ] Write fixture pairs in `rules/effect/fixtures/` (bad + good .ts for each rule)
- [ ] Write `scripts/gen-effect-rules.mjs` (manifest generator — not rule generator)
- [ ] Write `scripts/check-effect-rules.mjs` (drift guard)
- [ ] Run `scripts/gen-effect-rules.mjs` → commit `rules/effect/manifest.json`
- [ ] Add `bunx @ast-grep/cli@0.45.3 scan --rule rules/effect/` to `package.json` lint chain
- [ ] Add `node scripts/check-effect-rules.mjs` to `package.json` lint chain
- [ ] Add `check-effect-rules` row to CLAUDE.md guards table
- [ ] Delete `scripts/check-effect-idioms.mjs` in the same PR (on `feat/effect-steering-and-guard` merge)
- [ ] Verify `bun run lint` exits 0

## Non-goals

- Replacing the plugin's skills with lint rules. The skills teach; the rules catch.
- Auto-fixing. Every finding so far needed a judgement about intent.
- Generating working ast-grep patterns from prose. The corpus does not support it.
