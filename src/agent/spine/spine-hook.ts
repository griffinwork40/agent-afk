/**
 * SessionEnd hook: agent-maintained SPINE.md.
 *
 * After each top-level session, if the session produced a non-empty git diff,
 * this hook:
 *   1. Runs the diff through the spine classifier (single LLM call).
 *   2. Auto-writes `new-addition`, `strengthens`, and `weakens` items.
 *   3. Logs `contradicts` items to spine-pending.jsonl and emits a Telegram push for human review.
 *
 * Cost controls:
 *   - Skips subagent sessions (`parentSessionId` guard).
 *   - Fast-exits on empty git diff.
 *   - Disabled via `AFK_DISABLE_SPINE_UPDATE=1`.
 *   - Falls through silently on any error (best-effort, never blocks teardown).
 *
 * Daemon / non-interactive path:
 *   - No elicitation handler installed → `contradicts` items are logged to
 *     `~/.afk/state/spine-pending.jsonl` and a Telegram push is emitted.
 *   - `weakens` items are always auto-written.
 *
 * @module agent/spine/spine-hook
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookHandler } from '../hooks.js';
import { env } from '../../config/env.js';
import { pushIfConfigured } from '../../telegram/push.js';
import { getAfkStateDir } from '../../paths.js';
import { resolveRepoRootSync } from '../../utils/git.js';
import {
  readSpine,
  writeSpine,
  addEntry,
  findEntry,
} from './spine-store.js';
import { classifyDiff, MAX_DESCRIPTION_LEN } from './spine-classifier.js';
import type {
  SpineClassifierItem,
  SpineRelationItem,
} from './spine-classifier.js';
import { errorMessage } from '../../utils/errors.js';
import { isSubagentContext } from '../hooks/hook-utils.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SpineHookOptions {
  /**
   * Absolute path to the repo root (git working tree). Resolved from the
   * session's cwd at hook registration time via `git rev-parse --show-toplevel`.
   * Falls back to `process.cwd()` when git is unavailable.
   */
  repoRoot?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the SessionEnd hook that maintains SPINE.md.
 *
 * `options.repoRoot` is the session's cwd at registration time. When absent,
 * the hook resolves it from `process.cwd()` at fire time.
 */
export function createSpineSessionEndHook(options: SpineHookOptions = {}): HookHandler {
  return async (context, signal) => {
    // ── Guards ────────────────────────────────────────────────────────────
    if (context.event !== 'SessionEnd') return {};
    if (isSubagentContext(context)) return {}; // skip subagents
    if (env.AFK_DISABLE_SPINE_UPDATE === '1') return {};

    const sessionId = context.sessionId ?? 'unknown-session';

    try {
      const _rootCwd = options.repoRoot ?? process.cwd();
      // Invariant: use git-common-dir so SPINE.md always resolves to the main
      // repo root, not a linked worktree's checkout path (#worktree-spine-bug).
      const repoRoot = resolveRepoRootSync({ cwd: _rootCwd, fallback: _rootCwd, mode: 'git-common-dir' });

      // ── Git diff guard ────────────────────────────────────────────────
      const diff = getGitDiff(repoRoot);
      if (!diff.trim()) return {}; // empty diff — fast exit, zero cost

      // ── Read current SPINE.md ─────────────────────────────────────────
      const currentDoc = readSpine(repoRoot);
      const spineContent = currentDoc
        ? buildSpineText(currentDoc)
        : '';

      // ── Run classifier ────────────────────────────────────────────────
      const result = await classifyDiff(diff, spineContent, signal);
      if (!result.parsed || result.items.length === 0) return {};

      // ── Apply items ───────────────────────────────────────────────────
      // v1 limitation: reuse the pre-classify snapshot. Concurrent sessions
      // running simultaneously will independently derive the same nextId and
      // the last writer will overwrite the first — this is known last-writer-wins
      // behaviour. A second readSpine() here would not fix this (the race window
      // is between the classify call and the write, not between the reads).
      const doc = currentDoc ?? makeEmptyDoc();

      let dirty = false;
      const contradicts: SpineRelationItem[] = [];
      const weakenedItems: PendingLogEntry[] = [];

      for (const item of result.items) {
        if (item.label === 'new-addition') {
          const isoDate = new Date().toISOString().slice(0, 10);
          addEntry(doc, item.prefix, sessionId, item.description, isoDate);
          dirty = true;
          continue;
        }

        if (item.label === 'strengthens') {
          // Auto-write: no human review needed
          const existing = findEntry(doc, item.existingId);
          if (existing) {
            // Append a parenthetical note to the description to surface the
            // strengthening without creating a new entry (v1 keeps IDs stable).
            // Strip any pre-existing annotation (including truncated ones where
            // the closing paren was sliced off) before appending the new one so
            // that date-rollover and truncation do not accumulate duplicates.
            const isoDate = new Date().toISOString().slice(0, 10);
            const suffix = ` (reinforced ${isoDate})`;
            const baseDescription = existing.description
              .replace(/ \(reinforced \d{4}-\d{2}-\d{2}\)?$/, '')
              .slice(0, MAX_DESCRIPTION_LEN - suffix.length);
            const newDescription = baseDescription + suffix;
            if (newDescription !== existing.description) {
              existing.description = newDescription;
              dirty = true;
            }
          } else {
            // existingId not found — log for review so hallucinated IDs are visible
            appendSpinePending({
              type: 'strengthens-unresolved',
              sessionId,
              item,
              ts: new Date().toISOString(),
            });
          }
          continue;
        }

        if (item.label === 'weakens') {
          // Auto-write + log (no elicitation needed)
          const existing = findEntry(doc, item.existingId);
          if (existing) {
            const isoDate = new Date().toISOString().slice(0, 10);
            const suffix = ` (partially weakened ${isoDate})`;
            // Strip any pre-existing annotation (including truncated ones) before
            // appending the new one — same date-rollover / truncation guard as
            // the strengthens branch above.
            const baseDescription = existing.description
              .replace(/ \(partially weakened \d{4}-\d{2}-\d{2}\)?$/, '')
              .slice(0, MAX_DESCRIPTION_LEN - suffix.length);
            const newDescription = baseDescription + suffix;
            if (newDescription !== existing.description) {
              existing.description = newDescription;
              dirty = true;
            }
            weakenedItems.push({
              type: 'weakens',
              sessionId,
              item,
              ts: new Date().toISOString(),
            });
          } else {
            // existingId not found — log as unresolved so hallucinated IDs are visible
            weakenedItems.push({
              type: 'weakens-unresolved',
              sessionId,
              item,
              ts: new Date().toISOString(),
            });
          }
          continue;
        }

        if (item.label === 'contradicts') {
          contradicts.push(item as SpineRelationItem);
        }
      }

      // ── Write auto-items ──────────────────────────────────────────────
      if (dirty) {
        writeSpine(repoRoot, doc);
        // Stage SPINE.md so the next commit (this session, next session, or
        // manual) picks it up. Best-effort — never block teardown.
        try {
          execFileSync('git', ['add', 'SPINE.md'], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch { /* non-fatal */ }
      }

      // ── Log weakens after successful write ────────────────────────────
      for (const entry of weakenedItems) {
        appendSpinePending(entry);
      }

      // ── Handle contradictions ─────────────────────────────────────────
      for (const contradiction of contradicts) {
        handleContradiction(contradiction, sessionId);
      }
    } catch (err) {
      // Best-effort: never block teardown, but log for debugging.
      try {
        const stateDir = getAfkStateDir();
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(
          join(stateDir, 'spine-pending.jsonl'),
          JSON.stringify({
            type: 'hook-error',
            sessionId,
            error: errorMessage(err),
            ts: new Date().toISOString(),
          }) + '\n',
          'utf-8',
        );
      } catch {
        // Truly best-effort — even logging failed.
      }
    }

    return {};
  };
}

// ---------------------------------------------------------------------------
// Contradiction handling
// ---------------------------------------------------------------------------

/**
 * Handle a `contradicts` classification item.
 *
 * In v1, all `contradicts` items are logged to spine-pending.jsonl and surfaced
 * via Telegram push so the human can review them at their leisure. The SPINE.md
 * file is NOT mutated for contradictions — the entry is preserved unchanged
 * until the human explicitly resolves it via `/spine pending`. This avoids
 * auto-writing potentially wrong architectural updates and keeps the human in
 * the loop for the highest-stakes class of change.
 */
function handleContradiction(
  item: SpineRelationItem,
  sessionId: string,
): void {
  // Log for review
  appendSpinePending({
    type: 'contradicts',
    sessionId,
    item,
    ts: new Date().toISOString(),
  });

  // Best-effort Telegram notification (daemon/unattended path)
  void pushIfConfigured(
    `⚠️ SPINE conflict needs review:\n` +
      `${item.existingId.slice(0, 200)}: ${item.existingDescription.slice(0, 200)}\n` +
      `Conflict: ${item.description.slice(0, 200)}\n` +
      `Run /spine pending to review.`,
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



function getGitDiff(repoRoot: string): string {
  try {
    // Use `git diff HEAD` (no commit ref) to capture uncommitted working-tree
    // changes made during this session. If the session committed its changes,
    // this returns empty (correct fast-exit for v1: committed work is visible
    // in the next session's diff via HEAD~1 at that point). Using HEAD~1 would
    // incorrectly re-classify the previous commit on sessions that commit nothing.
    return execFileSync('git', ['diff', 'HEAD', '--unified=0'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024, // 2 MB cap
    });
  } catch {
    // No commits yet or git error — treat as empty
    return '';
  }
}

function buildSpineText(doc: import('./spine-store.js').SpineDocument | null): string {
  if (!doc) return '';
  const lines: string[] = [];
  for (const section of doc.sections) {
    lines.push(`## ${section.name}`);
    for (const entry of section.entries) {
      lines.push(`- **${entry.id}** (${entry.date}, ${entry.sessionId}): ${entry.description}`);
    }
  }
  return lines.join('\n');
}

function makeEmptyDoc(): import('./spine-store.js').SpineDocument {
  return {
    sections: [
      { name: 'Invariants', prefix: 'INV', entries: [] },
      { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
      { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
    ],
    trailer: '',
  };
}

interface PendingLogEntry {
  type: string;
  sessionId: string;
  item: SpineClassifierItem;
  ts: string;
}

function appendSpinePending(entry: PendingLogEntry): void {
  try {
    const stateDir = getAfkStateDir();
    mkdirSync(stateDir, { recursive: true });
    const pendingPath = join(stateDir, 'spine-pending.jsonl');
    appendFileSync(pendingPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Best-effort logging — never throw
  }
}
