#!/bin/sh
# Cheap gate in front of the Node hook: the plugin is typically enabled for every
# project, so unconfigured projects must pay almost nothing. Always exits 0.
event=$1
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
command -v node >/dev/null 2>&1 || exit 0

if [ "$event" != "session-start" ]; then
  common=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -n "$common" ]; then
    # state.json can exist for declined offers; only a "mode" means configured.
    grep -q '"mode"' "$common/backlog-md/state.json" 2>/dev/null || exit 0
  else
    [ -d "${XDG_STATE_HOME:-$HOME/.local/state}/backlog-md/projects" ] || exit 0
  fi
fi
exec node "$hook_dir/../lib/hook.mjs" "$event"
