# Deferred: pi as a chain participant (pi needs github access for the PR flow)

Status: **stub / deferred** (2026-07-14). Surfaced while trying to run a claude + openhands + **pi**
chain — pi can't own a stage of the standard feature→pr-review→revise flow as it stands.

## The gap

pi is a pure coding executor with **no MCP at all** — deliberate ("a coding executor, not an
orchestrator"): `pi-runner` provisions no MCP, the pi-agent compose service has no MCP mount, and the
pi strategy runs `--approve` with no MCP. So pi can **clone, edit code, and `git push`** (it has
`GH_TOKEN` + git-core's transport), but it **cannot open a PR or read/reply/resolve review threads** —
all of which need the **github MCP API**. Every stage of the standard chain touches github:

- `feature`+`create-pr` → opens the PR via the github MCP
- `pr-review` → claude-coder (frozen), posts comments via the github MCP
- `revise` → reads/replies/resolves threads via the github MCP

So pi can't cleanly own any stage of it today.

## Options

- **(a) Give pi a github-only MCP** (mirroring claude-coder's minimal surface) — a `pi-runner`
  MCP-provisioning addition + a `.mcp.json` + a compose mount. Makes pi a full PR-flow participant
  (e.g. pi does `revise`). Contradicts pi's original no-MCP decision, but a github-only surface is the
  natural, secure minimal set. **Recommended** if pi is to be a real coding agent in the loop.
- **(b) Keep pi no-MCP, pure-implement role** — pi implements the feature; a github-capable agent
  (openhands) does create-pr and revise. Needs a new atom/kind (implement-only → another agent opens
  the PR); the chain has no such shape today.
- **(c) Test pi separately** — keep the chain openhands→claude-coder→openhands, and exercise pi on its
  own pure coding task (no PR), which is what its design targets.

## Notes

Ties into `docs/plans/agent-process-identity.md` increment 2 (the per-run trust profile): if the trust
boundary becomes per-run (`SUB_AGENT_UID` + stripped MCP + scoped token bound at spawn), handing pi a
scoped github MCP for an untrusted run fits the same mechanism. Related: [[agent-process-identity]].
