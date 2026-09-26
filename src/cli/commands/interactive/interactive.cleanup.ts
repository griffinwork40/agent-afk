/**
 * Session teardown helpers for `interactive.ts`.
 *
 * Contains:
 *   - `installSignalHandlers` — SIGINT/SIGTERM/SIGHUP setup, returns a
 *     disposer that removes all three listeners.
 *   - `printExitSummary` — session-close summary (turns/cost/edits/resume hint).
 *   - `snapshotGitStateForCancelAll` — pre-cancelAll git snapshot (issue #1514).
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
import { runCleanupFunctions } from '../../../utils/cleanupRegistry.js';
import { palette } from '../../palette.js';
import { saveSession } from '../../session-store.js';
import { formatResumeCommand } from '../../resume-command.js';
import { launchInterruptPicker } from './interrupt-picker.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop.js';
import type { WorktreeHandle } from './worktree.js';

// ---------------------------------------------------------------------------
// Signal-handler parameter types
// ---------------------------------------------------------------------------

export interface SignalHandlerDeps {
  ctx: InteractiveCtx;
  turnState: TurnState;
  pickerAbort: AbortController;
}

export interface SignalHandlerDisposers {
  removeListeners: () => void;
}

// ---------------------------------------------------------------------------
// SIGINT
// ---------------------------------------------------------------------------

/**
 * Build the SIGINT handler. Handles three cases:
 *   1. Foreground `!cmd` shell in flight → abort the shell.
 *   2. Turn in flight → soft-stop or show the interrupt picker.
 *   3. Idle → double-Ctrl+C within SIGINT_EXIT_WINDOW_MS exits.
 */
function makeSigintHandler(deps: SignalHandlerDeps): () => void {
  const { ctx, turnState } = deps;
  const SIGINT_EXIT_WINDOW_MS = 1500;
  return () => {
    const now = Date.now();
    // Priority 1 — foreground `!cmd` shell. Set by the REPL while a
    // FG shell is in flight; the closure kills the shell's process
    // group and clears its FG slot, returning true. We swallow the
    // signal so the exit-cycle below doesn't also fire.
    if (turnState.tryAbortShellForeground && turnState.tryAbortShellForeground()) {
      turnState.lastSigintAt = now;
      return;
    }
    if (turnState.turnInFlight) {
      turnState.lastSigintAt = now;
      const c = turnState.activeCompositor;

      // Second Ctrl+C while the picker is open: abort the picker and hard-
      // cancel immediately (safety hatch — the user must never be stuck).
      if (turnState.interruptPickerAbort) {
        turnState.interruptPickerAbort.abort();
        turnState.interruptPickerAbort = null;
        ctx.session.current?.abort('sigint');
        ctx.rl.close();
        return;
      }

      // First Ctrl+C + armed compositor → show the interrupt picker
      // so the user can choose Stop (soft) vs Cancel (hard).
      if (c && c.isArmed()) {
        const doStop = () => {
          if (turnState.requestSoftStop) { turnState.requestSoftStop(); }
          else { ctx.session.current.interrupt().catch(() => { /* teardown */ }); }
          turnState.notifyInterrupting?.(true);
        };
        launchInterruptPicker({
          compositor: c,
          turnState,
          onStop: doStop,
          onCancel: () => { ctx.session.current?.abort('sigint'); ctx.rl.close(); },
        });
        return;
      }

      // Fallback (non-TTY / compositor not armed): first Ctrl+C = soft-stop,
      // same as ESC. Prints exit affordance so 2nd Ctrl+C is discoverable.
      if (turnState.requestSoftStop) { turnState.requestSoftStop(); }
      else { ctx.session.current.interrupt().catch(() => { /* swallow during teardown */ }); }
      turnState.notifyInterrupting?.(true);
      const msg = '\n' + palette.info('ℹ ') + 'Press Ctrl+C again to exit.';
      if (c && c.isArmed()) { try { c.commitAbove(msg); } catch { console.log(msg); } }
      else { console.log(msg); }
      return;
    }
    if (now - turnState.lastSigintAt < SIGINT_EXIT_WINDOW_MS) {
      // Pre-abort before rl.close() so deriveClosureReason sees 'sigint'
      // (a non-'closed' reason) and returns 'abort' instead of 'model_end_turn'.
      ctx.session.current?.abort('sigint');
      ctx.rl.close();
      return;
    }
    turnState.lastSigintAt = now;
    console.log('\n' + palette.info('ℹ ') + 'Press Ctrl+C again (or /exit) to quit.');
  };
}

// ---------------------------------------------------------------------------
// SIGTERM / SIGHUP shared teardown
// ---------------------------------------------------------------------------

function makeTermHupHandler(
  deps: SignalHandlerDeps,
  signal: 'sigterm' | 'sighup',
): () => void {
  const { ctx, pickerAbort } = deps;
  let inFlight = false;
  const GRACE_MS = 2000;
  return (): void => {
    if (inFlight) return;
    inFlight = true;
    // Pre-abort before rl.close() so deriveClosureReason sees the signal
    // name (a non-'closed' reason) and returns 'abort' rather than 'model_end_turn'.
    ctx.session.current?.abort(signal);
    // Ordering constraint: cancel the quit-time picker BEFORE closing
    // readline, so it releases raw stdin and settles its promise while the
    // terminal is still intact. Reversing this strands the awaited
    // disposition in the cleanup closure.
    pickerAbort.abort();
    try { ctx.rl.close(); } catch { /* best-effort */ }
    // Belt-and-suspenders: if rl.on('close') doesn't reach the exit
    // path within a short window (e.g. when the REPL loop is awaiting
    // a long-running turn), run cleanups directly and exit.
    setTimeout(() => {
      runCleanupFunctions().finally(() => process.exit(0));
    }, GRACE_MS).unref();
  };
}

// ---------------------------------------------------------------------------
// Public: installSignalHandlers
// ---------------------------------------------------------------------------

/**
 * Register SIGINT, SIGTERM, and SIGHUP handlers.
 *
 * Returns the SIGINT handler (so the caller can pass it to `runReplLoop`) and
 * a `removeListeners` disposer (to register with `registerCleanup`).
 */
export function installSignalHandlers(deps: SignalHandlerDeps): {
  handleSigint: () => void;
  removeListeners: () => void;
} {
  const handleSigint = makeSigintHandler(deps);
  const handleSigterm = makeTermHupHandler(deps, 'sigterm');
  const handleSighup = makeTermHupHandler(deps, 'sighup');

  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('SIGHUP', handleSighup);

  const removeListeners = (): void => {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
    process.removeListener('SIGHUP', handleSighup);
  };

  return { handleSigint, removeListeners };
}

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

// ---------------------------------------------------------------------------
// saveCurrentSession factory
// ---------------------------------------------------------------------------

/**
 * Build the `saveCurrentSession` helper and its `sessionSavedOnExit` interlock.
 *
 * Returns:
 *   - `saveCurrentSession()` — saves the session sidecar; guards on totalTurns > 0.
 *   - `registerCleanupGuard(fn)` — register a cleanup that skips when already saved.
 */
export function makeSessionSaver(ctx: InteractiveCtx): {
  saveCurrentSession: () => string | undefined;
  isSaved: () => boolean;
} {
  let sessionSavedOnExit = false;
  const saveCurrentSession = (): string | undefined => {
    if (ctx.stats.totalTurns === 0) return undefined;
    const savedPath = saveSession(ctx.stats);
    sessionSavedOnExit = true;
    return savedPath;
  };
  const isSaved = (): boolean => sessionSavedOnExit;
  return { saveCurrentSession, isSaved };
}
