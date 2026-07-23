#!/usr/bin/env bash
# Headless, detached, RETURNING launcher for the h stack in host/local mode — the non-interactive
# sibling of `make dev` / `make h-builds-h` (which need a zellij TTY). Starts every service for a
# MODE under cli/scripts/_supervise.sh (restart-on-exit with capped backoff), each in its own
# session/process-group via setsid, with stdout+stderr to a log file, then returns immediately.
#
# Usage:  up-local.sh [mode]        mode = dev (default) | h-builds-h
# Assumes `make infra-up` has the control plane (redis, placement, scheduler) running — checked below.
# Stop with down-local.sh; gate readiness with wait-local.sh. Re-running is safe (stop_stale in each
# run script replaces a prior instance; a stale supervisor for the same service is killed first).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_services.sh"

MODE="${1:-dev}"
LOG_DIR="${H_LOCAL_LOG_DIR:-${PROJECT_DIR}/.local-logs}"
PID_DIR="${LOG_DIR}/pids"
mkdir -p "${PID_DIR}"

# --- infra preflight: the control plane must already be up (make infra-up) --------------------
_port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- 3<&- && return 0 || return 1; }
missing=()
for p in 6379 50006 50007; do _port_open "$p" || missing+=("$p"); done
if [ "${#missing[@]}" -ne 0 ]; then
  echo "up-local: control plane not reachable (ports ${missing[*]} not listening)." >&2
  echo "up-local: run 'make infra-up' first (starts redis :6379, placement :50006, scheduler :50007)." >&2
  exit 1
fi

mapfile -t SERVICES < <(services_for_mode "${MODE}")
echo "up-local: launching ${#SERVICES[@]} service(s) for mode '${MODE}' (logs → ${LOG_DIR})"

for svc in "${SERVICES[@]}"; do
  run_script="${SCRIPT_DIR}/${svc}"
  if [ ! -x "${run_script}" ] && [ ! -f "${run_script}" ]; then
    echo "up-local: SKIP ${svc} (no such run script)" >&2
    continue
  fi
  name="${svc#run-}"; name="${name%.sh}"
  log_file="${LOG_DIR}/${name}.log"
  pid_file="${PID_DIR}/${name}.pid"

  # Kill a prior supervisor for THIS service so it doesn't fight the new one (the run script's own
  # stop_stale then frees the ports). Best-effort — a dead/rotated pid is ignored.
  if [ -f "${pid_file}" ]; then
    old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [ -n "${old_pid}" ] && kill -0 "${old_pid}" 2>/dev/null; then
      kill -TERM "-${old_pid}" 2>/dev/null || kill -TERM "${old_pid}" 2>/dev/null || true
    fi
  fi

  # setsid → new session + process group led by the supervisor, so down-local can kill the whole
  # tree (supervisor + dapr run + sidecar) by negative PGID. Detached from any controlling TTY.
  setsid bash "${SCRIPT_DIR}/_supervise.sh" "${run_script}" >"${log_file}" 2>&1 < /dev/null &
  sup_pid=$!
  echo "${sup_pid}" > "${pid_file}"
  printf '  %-22s pid=%-7s log=%s\n' "${name}" "${sup_pid}" "${log_file}"
done

echo "up-local: all launched (detached). Gate readiness with: cli/scripts/wait-local.sh ${MODE}"
echo "up-local: stop with: cli/scripts/down-local.sh ${MODE}"
