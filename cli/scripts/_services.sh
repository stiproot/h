#!/usr/bin/env bash
# Canonical service list for host mode, keyed by MODE — the single source of truth the
# headless launcher (up-host.sh), readiness probe (wait-host.sh), and teardown (down-host.sh)
# all read. The zellij layouts (.zellij/dev.kdl, .zellij/h-builds-h.kdl) enumerate the SAME sets for
# the interactive path; keep them in step.
#
# Sourced, not executed. Ports and app-ids are NOT duplicated here — they are parsed from each
# run-*.sh on demand (service_health_port / service_stopspec), so this file only owns the membership.
# kimi-agent is opt-in via the 'kimi-agent' docker-compose profile (not in dev or h-builds-h).
set -u

# services_for_mode <mode> — echo the run-script basenames for a mode, one per line.
services_for_mode() {
  case "${1:?usage: services_for_mode <mode>}" in
    dev)
      cat <<'EOF'
run-workflow-svc.sh
run-claude-agent.sh
run-codex-agent.sh
run-workflow-agent.sh
run-workflow-mcp.sh
run-openhands-agent.sh
run-dapr-mcp.sh
run-obs-mcp.sh
EOF
      ;;
    h-builds-h)
      # Supervised loop set — no openhands-agent (claude-agent is the loop's executor).
      cat <<'EOF'
run-workflow-svc.sh
run-claude-agent.sh
run-workflow-agent.sh
run-workflow-mcp.sh
run-dapr-mcp.sh
run-obs-mcp.sh
EOF
      ;;
    *)
      echo "_services.sh: unknown mode '$1' (want: dev | h-builds-h)" >&2
      return 2
      ;;
  esac
}

# service_health_port <run-script-path> — the TCP port a client connects to (readiness signal).
# Prefers the dapr --app-port; falls back to the APP_PORT default for sidecar-less services (obs-mcp).
service_health_port() {
  local script="$1" port
  port="$(grep -oE -- '--app-port[[:space:]=]+[0-9]+' "$script" | head -1 | grep -oE '[0-9]+' || true)"
  if [ -z "$port" ]; then
    port="$(grep -oE 'APP_PORT:-[0-9]+' "$script" | head -1 | grep -oE '[0-9]+$' || true)"
  fi
  echo "$port"
}

# service_stopspec <run-script-path> — echo "<app-id> <port>..." exactly as the script's own
# stop_stale call declares it, so teardown reuses the authoritative app-id + pinned ports.
service_stopspec() {
  sed -n 's/^[[:space:]]*stop_stale[[:space:]]\+//p' "$1" | head -1
}
