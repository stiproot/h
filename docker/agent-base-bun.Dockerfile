# syntax=docker/dockerfile:1
# Shared base for the bun-stack CLI agents (claude, openhands, pi). Bakes the
# process-identity model ONCE (docs/plans/agent-process-identity.md): the non-root service user
# (AGENT_UID / agent-svc), the dropped-CLI user (SUB_AGENT_UID / agent-cli), the shared group
# (AGENT_GID), the scoped sudoers drop, and the shared entrypoint. Agents `FROM h-agent-base-bun`,
# then add their own CLI + app build. Build this before the agent images:
#   docker build -f docker/agent-base-bun.Dockerfile -t h-agent-base-bun .   (or: make agent-bases)
FROM oven/bun:1

# Common tools + the privilege-drop tooling: gosu drops the server (root -> AGENT_UID) in the
# entrypoint; sudo drops the untrusted CLI (AGENT_UID -> SUB_AGENT_UID) in the runner.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq git ca-certificates unzip gosu sudo && \
    rm -rf /var/lib/apt/lists/* && \
    git config --system --add safe.directory '*'

# COMMON UIDs across all agents — required, because the agents share .runs/worktrees/clone and each
# entrypoint chowns them, so mixed UIDs would conflict. High UIDs dodge the base image's `bun` (1000).
ARG AGENT_UID=10001
ARG SUB_AGENT_UID=10002
ARG AGENT_GID=10001
ENV AGENT_UID=$AGENT_UID AGENT_GID=$AGENT_GID SUB_AGENT_UID=$SUB_AGENT_UID HOME=/home/agent-svc
RUN groupadd -g "$AGENT_GID" agent && \
    useradd -u "$AGENT_UID" -g "$AGENT_GID" -m -d /home/agent-svc agent-svc && \
    useradd -u "$SUB_AGENT_UID" -g "$AGENT_GID" -m -d /home/agent-cli agent-cli && \
    echo 'agent-svc ALL=(agent-cli) NOPASSWD:SETENV: ALL' > /etc/sudoers.d/agent && \
    chmod 0440 /etc/sudoers.d/agent
COPY docker/agent-entrypoint.sh /agent-entrypoint.sh
RUN chmod +x /agent-entrypoint.sh
ENTRYPOINT ["/agent-entrypoint.sh"]
