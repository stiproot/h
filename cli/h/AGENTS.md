# Agent process identity

The h agent fleet runs non-root under a shared process-identity model:
`AGENT_UID` (agent-server) runs the service, `SUB_AGENT_UID` is the identity
the spawned CLI subprocess drops to, and `AGENT_GID` is a single shared group
that grants access to the `/workspace` bind mount. See
[docs/plans/agent-process-identity.md](../../docs/plans/agent-process-identity.md)
for the full design.
