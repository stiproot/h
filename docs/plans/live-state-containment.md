# Containment: what can reach live state, and what can read a credential

Status: Active — an exposed credential and an unmocked test that fires real chains, both observed live 2026-07-28/29; the credential half is urgent
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
