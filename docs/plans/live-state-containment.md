# Containment: what can reach live state, and what can read a credential

Status: Active — all engineering work landed + live-verified 2026-07-29; ONE item open: the PAT
rotation (1.1), an operator action
Established: 2026-07-29

## Why this plan exists

An unattended overnight batch surfaced two defects that share one shape: **something that
should have been inert reached real state.** Neither was malicious, neither involved a
third-party repo, and neither was caught by any gate — lint, build, 24 JS test groups and
357 Python tests were all green throughout.

They are collected here because the fixes are related and because, before this plan, the
more serious of the two lived only in a session task list that dies with the session.

---

## 1. A GitHub PAT is readable by every agent — URGENT

`../h-workspace/repo/.git/config` carries the origin remote as
`https://x-access-token:<github_pat_…>@github.com/stiproot/h.git`, mode `-rw-rw-r--`, group
`agent`. Every worktree under `h-workspace/worktrees/*` inherits it through its gitdir link.

**Every agent run can read the maintainer's GitHub token with one `cat`** — including the
dropped `SUB_AGENT_UID` (10002), the identity that exists *specifically* because it executes
untrusted, spec-driven work.

This does not break the letter of the CLAUDE.md invariant — *"git-core injects `GH_TOKEN`
into https URLs IN-PROCESS … so the token never appears in the workflow definition, task
entry, or logs."* Definitions and logs are genuinely clean. But the **pre-clone's persisted
remote URL** is a surface nobody claimed to protect, and it defeats the intent: the token's
blast radius was meant to be per-operation, not at-rest-and-shared.

### Work

1. **Rotate the PAT.** It has been readable by every agent process for an unknown period.
   This is an operator action and comes first.
2. **Drop the token from the remote URL** — agents inject per-operation, so a tokenless URL
   should suffice:
   `git -C ../h-workspace/repo remote set-url origin https://github.com/stiproot/h.git`
   **Do this while no chains are running**, and VERIFY a worktree cut + fetch + push still
   work before relying on it. Do NOT simply `chmod 600`: agents run as a different uid and
   would lose access mid-run.
3. **Audit the clone path** (`cli/scripts/clone.sh`, the agent-server `/clone` route,
   `git-core`) so a credential can never be persisted into a remote URL again — the injection
   must stay per-operation.
4. **Guard it.** A check that no git config in the repo or the shared workspace contains a
   credential pattern (`github_pat_`, `ghp_`, `x-access-token:`). Cheap, and this class
   silently recurs otherwise.

### Acceptance

A fresh pre-clone has a tokenless remote URL; agent clone/fetch/worktree/push all still work;
the guard fails on a deliberately reintroduced token.

---

## 2. The test suite fires real chains against a live stack

`test_chain_roster_accepts_model` (added by PR #99, `cli/h/tests/test_chain.py`) invokes

```
chain run --slug x -w review-pr --agent claude codex --model opus
```

with **no `@respx.mock`**, so it issues a real HTTP call to whatever workflow-svc is
reachable. Observed consequences, all real:

- durable rows written to two production registries — `chain:sub:x`, and the saved workflow
  `x-w0`, which became the saved-workflow registry's ONLY entry;
- recurrence — the chain row reached **epoch 4** across the night, once per suite run;
- **a live `review-pr` panel ran including `codex`**, the executor the operator had
  explicitly excluded for the batch on exhausted quota. It completed with 3 tool calls, so it
  reached the model and spent quota.

**No agency was involved.** A developer running `pytest` on a machine with h up does this.
The driver's own verify-at-head runs were among the triggers. It was harmless only because
the dispatch happened to fail.

### Work

1. **Immediate:** the missing `@respx.mock` / `@needs_helm` on that test. Caught independently
   by #99's review panel; confirm it landed.
2. **The class:** an unmocked outbound HTTP call in the CLI suite should **fail closed**
   rather than escape to a real control plane. (respx can assert all calls are mocked; a
   session-scoped autouse fixture is the likely shape.)
3. **The policy hole:** an **engine-enforced executor allowlist at fire time**, so an
   excluded provider cannot be invoked by ANY path — test, agent, or operator typo. The
   operator's "no codex tonight" should have been unbreakable, not advisory. This is the
   piece that would have contained the damage regardless of the test bug, and it is
   independently useful for budget control.

### Acceptance

The CLI suite passes with no reachable workflow-svc AND fails loudly if a test attempts an
unmocked call; a fire naming a disallowed executor is refused by the engine, not by
convention.

### Design: the executor policy (2.3)

**Chosen seam: the `run-*` activities, gated structurally at the activity registry.** Fire-time
scanning (HTTP routes / trigger / cron) was rejected: the executor identity is only FINAL when
`generic.workflow` resolves the activity name at step time (fire-time identity means
`{{params.runActivity}}` tokens, and resolution may draw on step results), and the activity is
the one choke point every path shares — chains, crons, watcher re-fires, sched continuations,
the usage-limit fallback's agent switch, panel branches. Nothing can reach a model without
passing through a `run-*` activity in workflow-svc.

- **Registry row `exec:config`** (new `exec:` prefix, workflow-svc single-writer like every
  other registry): `{ denied: string[], updatedAt }`. Names are executor shortnames — the
  activity name minus `run-` (`codex`, `claude`, `openhands`, `pi`, `dapr-agent`, …). Row
  absent or `denied` empty ⇒ all allowed: the row is an operator instrument, not a default gate.
- **Structural gate**: `activity-registry` is restructured to a name→fn map; every entry whose
  name starts with `run-` is wrapped by a gate that reads `exec:config` (through the shared
  activity runtime) and THROWS on denial before the agent is invoked. The wrapper preserves
  `fn.name` (Dapr registers and dispatches activities by function name). A new agent activity
  added to the map is gated automatically — the guard cannot be forgotten.
- **Pure decision** in `domain/exec-policy.ts` (`executorFromActivity`, `isExecutorDenied`) —
  the decide-on-a-row shape the other engines use; unit-tested.
- **Refusal is LOUD**: the step fails, the watcher finalizes `failed`, a chain tears down as a
  unit. Deliberately NOT a silent re-route or skip — a denied executor being named is a policy
  violation the operator must see, and a panel quietly missing a branch is hidden partial
  coverage. Infra failure reading the row also fails the step (fail-closed; if the statestore
  is down nothing else works either).
- **Surface**: `GET/POST /exec/policy` on workflow-svc (the single writer);
  `h agents deny NAME…` / `h agents allow NAME…` (validated against the AGENT_IDENTITY table —
  an unknown name is a typo, refused), denied set surfaced in `h agents list`.
- **Scope cuts**: no per-repo policy, no expiry, no CLI-side registration pre-checks — the
  engine is the enforcement; conveniences can layer on later.

---

## Relationship to other plans

- [reviewer-identity-security](./reviewer-identity-security.md) — moved Deferred → Active by
  the same incident. It owns the *capability* question (what MCP surface and credentials an
  executing agent holds). This plan owns the two concrete defects; that plan owns the general
  posture. Keep them distinct: this one is finishable, that one is a standing design question.
- [local-ci-execution](./local-ci-execution.md) — owns the verification-integrity half
  (CI does not run; a panel cannot catch a build failure).

## Log

- 2026-07-29 — Created. Both findings were observed during the 2026-07-28 unattended batch;
  the credential exposure had no durable home before this (it existed only in a session task
  list). Neither was caught by any gate, because every gate was internally consistent — the
  defects are in what the system is *allowed to touch*, not in what it computes.
- 2026-07-29 — **Item 1 (credential) done except rotation.** Audit findings: git-core's
  injection was already per-operation and its errors token-scrubbed; `clone.sh` already
  normalises origin post-clone — the tokened pre-clone was LEGACY state predating that
  machinery (`.env` doesn't even carry `TARGET_REPO_URL`, so the current script couldn't have
  produced it). TWO live instances found and scrubbed: the pre-clone AND the old
  `h-workspace/h` checkout (the baked-clonePath era). Root cause of the second: `git clone
  <tokened-url>` PERSISTS that URL as origin, and git-core's `cloneEffect` never reset it —
  fixed (post-clone `remote set-url` back to the caller's clean URL when a token was injected;
  stub-git test). One template gap found by the flip audit and fixed FIRST: revise-pr step 1's
  bare `git fetch origin` (agent-side, no injection) now uses the one-shot token URL with
  explicit `+`-forced origin/* refspecs in pat mode (a URL fetch updates no tracking refs on
  its own). Flip live-verified while idle: injected fetch OK, live `/worktree` cut (incl.
  remoteBase fetch) OK, dry-run push via one-shot URL OK, credential-less fetch correctly
  refused (repo is private). Guard landed: `scripts/check-git-credentials.mjs` (+tests) in
  `bun run lint` — scans this repo's and the workspace's git configs for token prefixes AND
  the general `scheme://user:secret@` class; verified failing on a deliberately reintroduced
  token. **Remaining: rotate the PAT (operator).**
- 2026-07-29 — **Item 2 done, all three.** (2.1) the `@respx.mock`/`@needs_helm` fix from
  #99's panel confirmed on main. (2.2) the class closed with `pytest-socket`
  (`addopts = --disable-socket` in cli/h): all 281 tests pass with sockets blocked, and a
  deliberately unmocked call dies at `getaddrinfo` — verified. (2.3) executor policy built per
  the design above and LIVE-verified: `h agents deny codex` → fired a `run-codex` workflow →
  FAILED at the activity gate with the denied message before any agent invoke; unit tests
  cover the pure decision, the gate wrapper (name preservation, refuse-before-invoke), and the
  CLI merge semantics. `codex` left DENIED — the operator's standing exclusion, now enforced.
  The identity-sync guard's registry regex was updated for the map shape.
