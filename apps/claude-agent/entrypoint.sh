#!/bin/sh
set -e

# The bind-mounted /workspace is owned by the host user (UID 1000).
# The claude user (UID 1001) needs write access to specific subdirs.
# Create them if missing and chown so the runtime user can write.
for dir in \
  /workspace/claude-agent \
  /workspace/.runs \
  /workspace/worktrees; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
  fi
  chown 1001:1001 "$dir"
done

# Drop privileges and exec the CMD
exec su-exec 1001:1001 "$@"
