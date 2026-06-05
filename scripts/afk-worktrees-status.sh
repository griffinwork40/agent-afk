#!/usr/bin/env bash
# afk-worktrees-status.sh — read-only inspector for AFK worktrees and residue.
#
# Reports git worktrees AFK is likely responsible for (paths under
# .afk-worktrees/, .afk-work/, .claude/worktrees/, or any branch matching
# afk/*) and flags dirty state, dead owner PIDs, missing paths, and orphan
# plan directories.
#
# This script never modifies anything. It does not prune worktrees, delete
# files, or run cleanup. It is a lantern, not a lawbook — it helps you see
# residue. It does not prove correctness.
#
# Usage:
#   scripts/afk-worktrees-status.sh
#
# Exit code: always 0 (diagnostic output only).

set -u
# Intentionally NOT set -e: we degrade gracefully on missing data.

# --- locate repo root ---------------------------------------------------------
if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "afk-worktrees-status: not inside a git repository" >&2
  exit 0
fi
cd "$REPO_ROOT" || exit 0

# --- helpers ------------------------------------------------------------------

# Is this path one AFK is plausibly responsible for?
is_afk_path() {
  case "$1" in
    "$REPO_ROOT"/.afk-worktrees/*|\
    "$REPO_ROOT"/.afk-work/*|\
    "$REPO_ROOT"/.claude/worktrees/*) return 0 ;;
    *) return 1 ;;
  esac
}

short_hash() {
  if [ -z "$1" ]; then printf 'unknown'; else printf '%.7s' "$1"; fi
}

pid_status() {
  local pid="$1"
  if [ -z "$pid" ]; then echo "unknown"; return; fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "pid $pid alive"
  else
    echo "pid $pid dead"
  fi
}

# --- collect worktree records -------------------------------------------------
# Source of truth: `git worktree list --porcelain`. Records are separated by
# blank lines; fields are space-prefixed key/value pairs.

active_buf=""
review_buf=""
seen_paths=""

emit_record() {
  local path="$1" head="$2" branch="$3" locked_reason="$4" lock_pid="$5"

  # Filter to AFK-relevant only. Skip the main worktree and any unrelated ones,
  # but include stray afk/* branches even if their path is unusual.
  if ! is_afk_path "$path"; then
    case "$branch" in
      refs/heads/afk/*) ;;
      *) return ;;
    esac
  fi

  local relpath="${path#$REPO_ROOT/}"
  [ "$relpath" = "$path" ] && relpath="$path"

  local branch_label="${branch#refs/heads/}"
  [ -z "$branch_label" ] && branch_label="(detached)"

  local owner="unknown"
  if [ -n "$lock_pid" ]; then
    owner="$(pid_status "$lock_pid")"
  elif [ -n "$locked_reason" ]; then
    owner="locked ($locked_reason)"
  fi

  local path_exists="yes"
  [ -d "$path" ] || path_exists="no"

  local dirty="unknown"
  local changed_count="0"
  if [ "$path_exists" = "yes" ]; then
    local porcelain
    if porcelain="$(git -C "$path" status --porcelain 2>/dev/null)"; then
      if [ -z "$porcelain" ]; then
        dirty="no"
      else
        dirty="yes"
        changed_count="$(printf '%s\n' "$porcelain" | grep -c .)"
      fi
    fi
  fi

  local needs_review="no"
  case "$owner" in *dead*) needs_review="yes" ;; esac
  [ "$dirty" = "yes" ] && needs_review="yes"
  [ "$path_exists" = "no" ] && needs_review="yes"

  local rec=""
  rec+="  path: $relpath"$'\n'
  rec+="  branch: $branch_label"$'\n'
  rec+="  head: $(short_hash "$head")"$'\n'
  rec+="  owner: $owner"$'\n'
  rec+="  path exists: $path_exists"$'\n'
  rec+="  dirty: $dirty"$'\n'
  if [ "$changed_count" != "0" ]; then
    rec+="  changed files: $changed_count"$'\n'
  fi
  rec+=$'\n'

  seen_paths+="$path"$'\n'
  if [ "$needs_review" = "yes" ]; then
    review_buf+="$rec"
  else
    active_buf+="$rec"
  fi
}

# Stream-parse the porcelain output.
cur_path=""
cur_head=""
cur_branch=""
cur_locked_reason=""
cur_lock_pid=""

flush() {
  if [ -n "$cur_path" ]; then
    emit_record "$cur_path" "$cur_head" "$cur_branch" \
                "$cur_locked_reason" "$cur_lock_pid"
  fi
  cur_path=""; cur_head=""; cur_branch=""
  cur_locked_reason=""; cur_lock_pid=""
}

while IFS= read -r line || [ -n "$line" ]; do
  if [ -z "$line" ]; then
    flush
    continue
  fi
  case "$line" in
    "worktree "*) cur_path="${line#worktree }" ;;
    "HEAD "*)     cur_head="${line#HEAD }" ;;
    "branch "*)   cur_branch="${line#branch }" ;;
    "detached")   cur_branch="" ;;
    "locked"*)
      cur_locked_reason="${line#locked}"
      cur_locked_reason="${cur_locked_reason# }"
      if [[ "$cur_locked_reason" =~ \(pid\ ([0-9]+)\) ]]; then
        cur_lock_pid="${BASH_REMATCH[1]}"
      fi
      ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null)
flush

# --- residue scan -------------------------------------------------------------
# Look for directories under .afk-work/, .afk-work/*/, and .afk-worktrees/
# that are NOT registered as git worktrees. These are residue candidates,
# not errors — abandoned plan dirs, half-cleaned worktrees, etc.

residue_buf=""

scan_residue_dir() {
  local base="$1"
  [ -d "$base" ] || return 0
  local entry
  shopt -s nullglob
  for entry in "$base"/*; do
    [ -d "$entry" ] || continue
    case $'\n'"$seen_paths" in
      *$'\n'"$entry"$'\n'*) continue ;;
    esac

    local relpath="${entry#$REPO_ROOT/}"
    local reason="unregistered (not a git worktree)"
    if [ -z "$(ls -A "$entry" 2>/dev/null)" ]; then
      reason="empty directory"
    fi

    residue_buf+="  path: $relpath"$'\n'
    residue_buf+="  reason: $reason"$'\n'
    residue_buf+=$'\n'
  done
  shopt -u nullglob
}

scan_residue_dir "$REPO_ROOT/.afk-work"
if [ -d "$REPO_ROOT/.afk-work" ]; then
  shopt -s nullglob
  for sub in "$REPO_ROOT"/.afk-work/*/; do
    [ -d "$sub" ] || continue
    scan_residue_dir "${sub%/}"
  done
  shopt -u nullglob
fi
scan_residue_dir "$REPO_ROOT/.afk-worktrees"

# --- output -------------------------------------------------------------------

echo "AFK worktree status"
echo "  repo: $REPO_ROOT"
echo

if [ -n "$active_buf" ]; then
  echo "Active:"
  printf '%s' "$active_buf"
else
  echo "Active: (none)"
  echo
fi

if [ -n "$review_buf" ]; then
  echo "Orphaned / needs review:"
  printf '%s' "$review_buf"
else
  echo "Orphaned / needs review: (none)"
  echo
fi

if [ -n "$residue_buf" ]; then
  echo "Empty / unregistered residue:"
  printf '%s' "$residue_buf"
else
  echo "Empty / unregistered residue: (none)"
  echo
fi

echo "Notes:"
echo "  - read-only; this script never modifies anything."
echo "  - 'owner' reflects git worktree lock metadata; absent = unknown, not safe."
echo "  - 'dirty' counts untracked files too (git status --porcelain)."
echo "  - residue scan covers .afk-work/, .afk-work/*/, and .afk-worktrees/ only."
echo "  - this does NOT prove correctness or verify anything was tested."
