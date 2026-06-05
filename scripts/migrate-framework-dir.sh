#!/usr/bin/env bash
# Migrate telemetry/briefs/pattern-cards from ~/.claude/agent-framework
# to ~/.afk/agent-framework. Merges JSONL files (dedup by timestamp),
# copies directories that don't exist in the target, skips plugin-only
# files (UNLOCKED sentinel).
set -euo pipefail

SRC="${HOME}/.claude/agent-framework"
DST="${HOME}/.afk/agent-framework"

if [ ! -d "$SRC" ]; then
  echo "Nothing to migrate — $SRC does not exist."
  exit 0
fi

mkdir -p "$DST"

PLUGIN_ONLY=(
  "UNLOCKED"
  ".DS_Store"
  "sessions"
  "routing-decisions-review.err"
  "routing-decisions-review.log"
  "routing-decisions-review.state"
  "routing-decisions-weekly-report.md"
  "shadow-verify-nudge.log"
  "skill-invocations.jsonl"
)

is_plugin_only() {
  local name="$1"
  for skip in "${PLUGIN_ONLY[@]}"; do
    [ "$name" = "$skip" ] && return 0
  done
  return 1
}

merge_jsonl() {
  local src_file="$1" dst_file="$2"
  if [ ! -f "$dst_file" ]; then
    cp "$src_file" "$dst_file"
    echo "  copied $src_file → $dst_file"
  else
    # Concatenate, sort by line content to dedup, keep unique lines
    local tmp
    tmp=$(mktemp)
    sort -u "$src_file" "$dst_file" > "$tmp"
    mv "$tmp" "$dst_file"
    echo "  merged $src_file → $dst_file"
  fi
}

copy_dir_recursive() {
  local src_dir="$1" dst_dir="$2"
  mkdir -p "$dst_dir"
  for item in "$src_dir"/*; do
    [ -e "$item" ] || continue
    local base
    base=$(basename "$item")
    if [ -d "$item" ]; then
      copy_dir_recursive "$item" "$dst_dir/$base"
    elif [[ "$base" == *.jsonl ]]; then
      merge_jsonl "$item" "$dst_dir/$base"
    elif [ ! -f "$dst_dir/$base" ]; then
      cp "$item" "$dst_dir/$base"
      echo "  copied $item → $dst_dir/$base"
    else
      echo "  skipped $base (already exists in $dst_dir)"
    fi
  done
}

echo "Migrating $SRC → $DST"
echo ""

for item in "$SRC"/*; do
  [ -e "$item" ] || continue
  base=$(basename "$item")

  if is_plugin_only "$base"; then
    echo "skip (plugin-only): $base"
    continue
  fi

  if [ -d "$item" ]; then
    echo "dir: $base/"
    copy_dir_recursive "$item" "$DST/$base"
  elif [[ "$base" == *.jsonl ]]; then
    echo "jsonl: $base"
    merge_jsonl "$item" "$DST/$base"
  elif [[ "$base" == *.jsonl.bak ]]; then
    echo "jsonl.bak: $base"
    if [ ! -f "$DST/$base" ]; then
      cp "$item" "$DST/$base"
      echo "  copied"
    else
      echo "  skipped (already exists)"
    fi
  elif [ ! -f "$DST/$base" ]; then
    echo "file: $base"
    cp "$item" "$DST/$base"
    echo "  copied"
  else
    echo "skip (exists): $base"
  fi
done

echo ""
echo "Done. Review ~/.afk/agent-framework/ then optionally remove ~/.claude/agent-framework/."
