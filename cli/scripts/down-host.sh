#!/usr/bin/env bash
# Tear down a host-mode stack started by up-host.sh. Kills each service's supervisor process
# GROUP first (so it stops restarting the child), then runs the service's own stop_stale spec to free
# the dapr app-id + pinned ports — belt and suspenders against orphaned sidecars.
#
# Usage:  down-host.sh [mode]     mode = dev (default) | h-builds-h
# Leaves infra (redis/placement/scheduler) up — that's `make infra-down`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_services.sh"
# stop_stale + umask/group self-heal live in _lib.sh (sourced by every run script anyway).
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_lib.sh"

MODE="${1:-dev}"
LOG_DIR="${H_HOST_LOG_DIR:-${PROJECT_DIR}/.host-logs}"
PID_DIR="${LOG_DIR}/pids"

mapfile -t SERVICES < <(services_for_mode "${MODE}")
echo "down-host: stopping ${#SERVICES[@]} service(s) for mode '${MODE}'"

for svc in "${SERVICES[@]}"; do
  name="${svc#run-}"; name="${name%.sh}"
  pid_file="${PID_DIR}/${name}.pid"

  # 1) Kill the supervisor's whole process group so it stops restarting the child + takes the
  #    dapr run + sidecar with it.
  if [ -f "${pid_file}" ]; then
    sup_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [ -n "${sup_pid}" ] && kill -0 "${sup_pid}" 2>/dev/null; then
      kill -TERM "-${sup_pid}" 2>/dev/null || kill -TERM "${sup_pid}" 2>/dev/null || true
      sleep 0.5
      kill -KILL "-${sup_pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  fi

  # 2) Free the dapr app-id + ports exactly as the run script declares them.
  spec="$(service_stopspec "${SCRIPT_DIR}/${svc}")"
  if [ -n "${spec}" ]; then
    # shellcheck disable=SC2086
    stop_stale ${spec}
  fi
  echo "  stopped ${name}"
done

echo "down-host: done (infra left running — 'make infra-down' to stop it)."
