/**
 * Session teardown helpers for `interactive.ts`.
 *
 * Contains:
 *   - `installSignalHandlers` — re-exported from `interactive.signal-handlers.ts`.
 *   - `printExitSummary` — session-close summary (turns/cost/edits/resume hint).
 *   - `snapshotGitStateForCancelAll` — pre-cancelAll git snapshot (issue #1514).
 *   - `makeSessionSaver` — factory for the close-time session saver + interlock.
 *
 * Signal-handler internals (`makeSigintHandler`, `makeTermHupHandler`) were
 * extracted to `interactive.signal-handlers.ts` (issue #2900) to keep this
 * file under the 350-line ceiling. All public exports are re-exported here
 * so existing importers are unaffected.
 *
 * Everything here takes explicit parameters; nothing closes over action-local
 * state. The original `interactive.ts` wires the parameters and registers the
 * returned disposers via `registerCleanup`.
 */

import * as path from 'node:path';
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);
import { divider } from '../../render.js';
import { formatDuration } from '../../format-utils.js';
import { costTokenParts } from '../../render/session-summary.js';
import { saveSession } from '../../session-store.js';
import { formatResumeCommand } from '../../resume-command.js';
import type { InteractiveCtx } from './shared.js';
import type { WorktreeHandle } from './worktree.js';
import { palette } from '../../palette.js';

// Signal-handler code lives in its own module (issue #2900 — file-size ceiling).
// Import ExitReasonRef into this module's scope (used by makeSessionSaver) and
// re-export everything so existing importers of interactive.cleanup are unaffected.
import type { ExitReasonRef } from './interactive.signal-handlers.js';
export {
  installSignalHandlers,
  type ExitReasonRef,
  type SignalHandlerDeps,
  type SignalHandlerDisposers,
} from './interactive.signal-handlers.js';

// ---------------------------------------------------------------------------
// printExitSummary
// ---------------------------------------------------------------------------

/**
 * Expanded session-close summary (Item #8).
 *
 * Replaces the old printExitSummary + printResumeHint pair with a single
 * function that emits up to 4 lines:
 *
 *   Line 1: N turns · Xs · $Y.YY · Ztokens
 *   Line 2: model: <model> · worktree: <name or 'none'>
 *   Line 3: edits: <git diff --shortstat> or 'no files changed'
 *             (omitted if not in a git repo; 2s timeout)
 *   Line 4: Continue with: afk --resume <id> -m <model>
 *
 * All lines are indented 2 spaces and dimmed. Line 4 uses palette.brand for
 * the command itself so the operator can copy-paste it clearly.
 *
 * External constraint: git diff --shortstat runs via execFileSync with a 2s
 * timeout so a huge repo or slow NFS mount can never delay process exit. Any
 * error (non-git-repo, git not on PATH, timeout) silently skips the line.
 */
export function printExitSummary(
  ctx: InteractiveCtx,
  worktreeHandle: WorktreeHandle | undefined,
  saveCurrentSession: () => string | undefined,
): void {
  if (ctx.stats.totalTurns === 0) return;

  // Invariant (TUI rhythm contract): the last turn's footer (line ~520
  // of turn-handler.ts) already emitted its trailing blank, so the
  // divider lands one blank below the footer naturally. A leading `\n`
  // here would double-up. See docs/tui-rhythm.md.
  console.log(divider('Session Summary'));

  // Line 1: turns · duration · cost · tokens
  const parts = [
    `${ctx.stats.totalTurns} turn${ctx.stats.totalTurns === 1 ? '' : 's'}`,
    formatDuration(Date.now() - ctx.stats.sessionStartTime),
  ];
  parts.push(...costTokenParts({ costUsd: ctx.stats.totalCostUsd, tokens: ctx.stats.totalTokens }));
  console.log(palette.dim('  ' + parts.join(' · ')));

  // Line 2: model · worktree name (or 'none')
  const worktreeName = worktreeHandle ? path.basename(worktreeHandle.path) : 'none';
  console.log(palette.dim(`  model: ${ctx.stats.model} · worktree: ${worktreeName}`));

  // Line 3: git diff --shortstat (best-effort, synchronous with 2s timeout).
  // External constraint: execFileSync with a timeout kills the child process
  // if git hangs (e.g. on a slow NFS mount). Any error (non-git-repo, git
  // not on PATH, timeout, or HEAD not existing on initial worktree) silently
  // skips the line so process exit is never blocked.
  try {
    const cwd = ctx.stats.cwd ?? process.cwd();
    const stdout = execFileSync('git', ['diff', '--shortstat', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 400,
    });
    const stat = stdout.trim();
    console.log(palette.dim(`  edits: ${stat || 'no files changed'}`));
  } catch {
    // Not a git repo, git not on PATH, timed out, or HEAD doesn't exist —
    // skip the line entirely rather than showing a confusing error.
  }

  // Line 4: resume hint (absorbs former printResumeHint)
  let resumeTarget = ctx.stats.sessionId;
  try {
    const savedPath = saveCurrentSession();
    if (!resumeTarget && savedPath) {
      resumeTarget = path.basename(savedPath, '.json');
    }
  } catch {
    // The command can still be useful when the SDK/session id is known and
    // the cleanup autosave failed for an unrelated filesystem reason.
  }
  if (resumeTarget) {
    console.log(
      palette.dim('  Continue with: ') +
        palette.brand(formatResumeCommand(resumeTarget, ctx.stats.model)),
    );
  }

  console.log();
}

// ---------------------------------------------------------------------------
// snapshotGitStateForCancelAll
// ---------------------------------------------------------------------------

/**
 * Mitigation #3 (issue #1514): snapshot git state before `cancelAll()` so
 * the operator has a before-picture to compare against after the drain
 * timeout fires. Runs `git diff --stat` and `git status --short` with a
 * 2-second timeout each. Best-effort — any error (non-git repo, git not on
 * PATH, timeout) is silently swallowed so session teardown is never delayed.
 *
 * Output goes to stderr so it doesn't corrupt any piped stdout stream and
 * is clearly distinguished from normal session output.
 */
export async function snapshotGitStateForCancelAll(cwd: string): Promise<void> {
  try {
    const [statResult, statusResult] = await Promise.all([
      execFile('git', ['diff', '--stat', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2000 }),
      execFile('git', ['status', '--short'], { cwd, encoding: 'utf8', timeout: 2000 }),
    ]);
    const stat = statResult.stdout.trim();
    const status = statusResult.stdout.trim();
    const lines: string[] = [
      '[afk] pre-cancelAll git snapshot (compare after session to detect half-applied edits):',
    ];
    lines.push('  git diff --stat HEAD:');
    if (stat) {
      for (const line of stat.split('\n')) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push('    (no uncommitted changes)');
    }
    lines.push('  git status --short:');
    if (status) {
      for (const line of status.split('\n')) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push('    (working tree clean)');
    }
    process.stderr.write(lines.join('\n') + '\n');
  } catch {
    // Not a git repo, git not on PATH, timed out — skip silently.
  }
}

/**
 * Stop all background work this REPL session owns, at session teardown:
 * background subagents (with the #1514 pre-cancel git snapshot), Ctrl+B
 * detached tool calls (Invariant:D3), and `bash run_in_background` process
 * jobs (TERM, short grace, KILL; awaited so no group outlives the session).
 * Every step is best-effort and never throws.
 */
export async function cancelSessionBackgroundWork(ctx: InteractiveCtx): Promise<void> {
  const runningJobs = ctx.backgroundRegistry.list().filter((j) => j.status === 'running');
  if (runningJobs.length > 0) await snapshotGitStateForCancelAll(ctx.stats.cwd ?? process.cwd());
  await ctx.backgroundRegistry.cancelAll().catch(() => { /* best-effort */ });
  ctx.detachRegistry?.cancelAll();
  await ctx.processJobs?.killAll().catch(() => { /* best-effort */ });
}

// ---------------------------------------------------------------------------
// saveCurrentSession factory
// ---------------------------------------------------------------------------

/**
 * Build the `saveCurrentSession` helper and its `sessionSavedOnExit` interlock.
 *
 * `exitReasonRef` — mutable ref whose `.current` value is written by the
 * signal/exit path that calls rl.close(), so the sidecar records WHY the
 * session ended alongside `endedAt`.
 *
 * Returns:
 *   - `saveCurrentSession()` — saves the session sidecar; guards on totalTurns > 0.
 *   - `isSaved()` — true if the sidecar has already been written this exit.
 */
export function makeSessionSaver(
  ctx: InteractiveCtx,
  exitReasonRef?: ExitReasonRef,
): {
  saveCurrentSession: () => string | undefined;
  isSaved: () => boolean;
} {
  let sessionSavedOnExit = false;
  const saveCurrentSession = (): string | undefined => {
    if (ctx.stats.totalTurns === 0) return undefined;
    const savedPath = saveSession(ctx.stats, undefined, {
      closeTime: true,
      exitReason: exitReasonRef?.current,
    });
    sessionSavedOnExit = true;
    return savedPath;
  };
  const isSaved = (): boolean => sessionSavedOnExit;
  return { saveCurrentSession, isSaved };
}
