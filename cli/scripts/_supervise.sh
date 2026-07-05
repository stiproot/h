#!/usr/bin/env bash
# Restart-on-exit supervisor for unattended (h-builds-h cron) operation.
#
# Unlike _pane.sh (which drops to an interactive shell after one run for dev convenience),
# this wrapper loops forever with capped exponential backoff. Ctrl+C kills the child
# service but not the supervisor — intentional for appliance panes where you want the
# service to come back on its own but can still interrupt a single run to inspect state.
set -u

script="${1:?usage: _supervise.sh <run-script>}"
backoff=2
max_backoff=30

trap '' INT

while true; do
  echo "[supervise] starting $script"
  ( trap - INT; exec "$script" )
  status=$?
  echo "[supervise] $script exited (status $status); restarting in ${backoff}s"
  sleep "$backoff"
  backoff=$(( backoff * 2 > max_backoff ? max_backoff : backoff * 2 ))
done
