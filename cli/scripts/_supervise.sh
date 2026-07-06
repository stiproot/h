#!/usr/bin/env bash
# Restart-on-exit supervisor for unattended (h-builds-h cron) operation.
#
# Unlike _pane.sh (which drops to an interactive shell after one run for dev convenience),
# this wrapper loops forever with capped exponential backoff (2s→30s). The backoff resets
# to 2s after a healthy run (child lived ≥60s), so a transient crash after days of uptime
# does not pay the full 30s penalty. After 5 consecutive fast failures (<60s), the supervisor
# gives up rather than hammering the machine indefinitely.
#
# Ctrl+C kills the child service but not the supervisor — intentional for appliance panes
# where you want the service to come back on its own but can still interrupt a single run.
set -u

script="${1:?usage: _supervise.sh <run-script>}"
backoff=2
max_backoff=30
fast_fails=0
max_fast_fails=5

trap '' INT

while true; do
  echo "[supervise] starting $script"
  start=$SECONDS
  ( trap - INT; exec "$script" )
  status=$?
  elapsed=$(( SECONDS - start ))
  echo "[supervise] $script exited (status $status, ran ${elapsed}s)"

  if (( elapsed >= 60 )); then
    backoff=2
    fast_fails=0
  else
    fast_fails=$(( fast_fails + 1 ))
    if (( fast_fails >= max_fast_fails )); then
      echo "[supervise] $script crashed $fast_fails times quickly — giving up"
      exit 1
    fi
  fi

  echo "[supervise] restarting in ${backoff}s (fast_fails=$fast_fails)"
  sleep "$backoff"
  backoff=$(( backoff * 2 > max_backoff ? max_backoff : backoff * 2 ))
done
