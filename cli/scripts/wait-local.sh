#!/usr/bin/env bash
# Host-mode readiness probe — poll each MODE service's app port until all accept a TCP connection
# or a timeout elapses. Gives a headless agent a deterministic "stack UP" gate (compose healthchecks
# don't apply to host `dapr run`). TCP-accept on the app port is a uniform signal that survives the
# per-service quirks (obs-mcp has no sidecar; dapr-mcp has dual listeners).
#
# Usage:  wait-local.sh [mode] [timeout_seconds]     mode = dev (default) | h-builds-h, timeout = 180
# Exit 0 when every service is listening; nonzero on timeout (prints which are still down).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_services.sh"

MODE="${1:-dev}"
TIMEOUT="${2:-180}"

_port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- 3<&- && return 0 || return 1; }

mapfile -t SERVICES < <(services_for_mode "${MODE}")

# Build parallel name/port arrays (skip any service whose port we can't resolve — reported, not silent).
names=(); ports=()
for svc in "${SERVICES[@]}"; do
  name="${svc#run-}"; name="${name%.sh}"
  port="$(service_health_port "${SCRIPT_DIR}/${svc}")"
  if [ -z "${port}" ]; then
    echo "wait-local: WARN cannot resolve app port for ${name} — not gated" >&2
    continue
  fi
  names+=("${name}"); ports+=("${port}")
done

echo "wait-local: waiting up to ${TIMEOUT}s for ${#names[@]} service(s) in mode '${MODE}'"
deadline=$(( SECONDS + TIMEOUT ))
while true; do
  down=()
  for i in "${!names[@]}"; do
    _port_open "${ports[$i]}" || down+=("${names[$i]}:${ports[$i]}")
  done
  if [ "${#down[@]}" -eq 0 ]; then
    echo "wait-local: UP — all ${#names[@]} service(s) listening"
    exit 0
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "wait-local: TIMEOUT after ${TIMEOUT}s — still down: ${down[*]}" >&2
    echo "wait-local: inspect logs under \${H_LOCAL_LOG_DIR:-.local-logs}/ (e.g. tail -n 50 .local-logs/${down[0]%%:*}.log)" >&2
    exit 1
  fi
  sleep 2
done
