#!/bin/sh
# No sudo, prefix repair, credentials, or changes to shell startup files.
# Usage: sh scripts/onboarding/observe-macos.sh [log-file]
set -u
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
log=${1:-onboarding-macos.log}
case "$log" in /*) ;; *) log="$PWD/$log" ;; esac
mkdir -p "$(dirname -- "$log")" || exit 1
printf 'Observation bootstrap\nCommand: node --version\n' > "$log" || exit 1
node --version >> "$log" 2>&1
code=$?
printf 'Exit code: %s\n' "$code" >> "$log"
if [ "$code" -ne 0 ]; then
  printf 'Node unavailable. Install Node as described in the checklist, then rerun.\n' >> "$log"
  printf '## Observation could not run\nNode was not available. See bootstrap log.\n' > "$log.summary.md"
  exit 1
fi
sandbox=$(mktemp -d "$(dirname -- "$log")/.onboarding-home-XXXXXX") || exit 1
# Preserve actual PATH and the installer's default npm prefix. HOME isolates
# credentials and afk state, not global installation permissions.
env -i PATH="$PATH" HOME="$sandbox" AFK_HOME="$sandbox/.afk" \
  XDG_CONFIG_HOME="$sandbox/.config" NPM_CONFIG_USERCONFIG="$sandbox/.npmrc" \
  SHELL="${SHELL:-/bin/zsh}" LANG="${LANG:-en_US.UTF-8}" NO_COLOR=1 \
  node "$script_dir/observe.mjs" "$log" /bin/sh
code=$?
[ "$code" -eq 0 ] && [ -s "$log" ] && [ -s "$log.summary.md" ]
