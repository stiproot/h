#!/usr/bin/env bash
# Pane supervisor for the zellij dev layout (.zellij/dev.kdl).
#
# Runs a service run-script once, then drops to an interactive shell in the SAME pane
# so you can re-run it (↑ Enter) or run anything else. Ctrl+C stops the service without
# killing the pane: SIGINT is ignored here (the supervisor) and reset for the child, so
# Ctrl+C reaches the service, then control returns to a normal prompt. Typing `exit` in
# that shell closes the pane — we close it explicitly rather than returning, so zellij
# doesn't re-run the pane's launch command (which would restart the service).
set -u

script="${1:?usage: _pane.sh <run-script>}"

# Supervisor ignores SIGINT; the child subshell resets it to default so Ctrl+C stops
# the service rather than this wrapper.
trap '' INT
( trap - INT; exec "$script" )
status=$?

# Restore default handling so the interactive shell treats Ctrl+C normally.
trap - INT
echo
echo "── [$script] exited (status $status)."
echo "──  Normal shell now — re-run with:  $script   (type 'exit' to close this pane)"
"${SHELL:-/bin/zsh}" -i

# The interactive shell exited: close the pane ourselves. Without this, _pane.sh returns,
# zellij sees the pane command exit, and re-runs it — restarting the service.
zellij action close-pane 2>/dev/null || true
