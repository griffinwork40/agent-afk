/**
 * `/rewind [conversation|files|both]` (#4271).
 *
 * Pick an earlier prompt, then choose what to rewind:
 *   - conversation — truncate history to before that prompt and reload its
 *     text into the input (the original behaviour; Esc-Esc uses this mode);
 *   - files        — restore files to their state at the start of that prompt;
 *   - both         — files first, then the conversation.
 *
 * Invariant: file restores are always previewed (dry-run) and confirmed before
 * any byte changes, and in `both` mode the conversation is truncated ONLY after
 * every file restored (files the operator explicitly chose to keep do not
 * count as failures). A partial file restore never also discards the
 * conversation, so the operator can retry, or run `/rewind conversation`.
 *
 * Extracted from `core.ts` to keep it within the 350-code-line ceiling.
 *
 * @module cli/slash/commands/core.rewind
 */

import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { renderSelector } from '../../input/selectors.js';
import type { SlashCommand, SlashContext } from '../types.js';
import type { RewindTarget } from '../../../agent/provider.js';
import { forkJournal } from '../../../agent/journal/index.js';
import { forkStoredSession } from '../../session-store.js';

type RewindMode = 'conversation' | 'files' | 'both';
type Session = SlashContext['session']['current'];

const MODES: readonly RewindMode[] = ['conversation', 'files', 'both'];
const MODE_LABELS = ['Conversation only (edit and resend the prompt)', 'Files only (keep the conversation)', 'Conversation and files'];

/**
 * Ask the operator to pick one of `choices`. Surfaces with a correlated choice
 * channel (`ctx.choose`: the web picker, Telegram buttons, the REPL adapter)
 * use it; a cancel maps to ':cancel'. Otherwise fall back to the raw terminal
 * selector, which drives stdin directly, so release the persistent
 * compositor's keypress listener first and re-arm it after (the selector
 * contract, see input/selectors.ts). getCompositor is null on non-TTY.
 */
async function pick(ctx: SlashContext, choices: string[], title = 'Rewind'): Promise<number | ':cancel' | null> {
  if (ctx.choose) {
    const options = choices.map((label, index) => ({ value: String(index), label }));
    const selected = await ctx.choose({ corrId: randomUUID(), title, options, cancellable: true });
    if (selected === null) return ':cancel';
    const index = options.findIndex((option) => option.value === selected);
    return index < 0 ? ':cancel' : index;
  }
  const compositor = ctx.getCompositor?.() ?? null;
  compositor?.suspendInput();
  try {
    return await renderSelector(choices, new AbortController().signal);
  } finally {
    compositor?.resumeInput();
  }
}

async function chooseMode(ctx: SlashContext, target: RewindTarget): Promise<RewindMode | undefined> {
  // No checkpoint for this prompt: conversation is the only meaningful mode.
  if (target.checkpointTurnId === undefined) return 'conversation';
  const choice = await pick(ctx, [...MODE_LABELS], 'What should be rewound?');
  return typeof choice === 'number' ? MODES[choice] : undefined;
}

function showPreview(ctx: SlashContext, changed: string[], conflicts: Set<string>, failures: Array<{ path: string; error: string }>, uncaptured: string[]): void {
  ctx.out.line(`Files to restore (${changed.length}):`);
  for (const path of changed) {
    ctx.out.line(`  ${conflicts.has(path) ? '!' : '•'} ${path}${conflicts.has(path) ? '  (changed outside the agent since)' : ''}`);
  }
  for (const failure of failures) ctx.out.line(`  ✗ ${failure.path}: ${failure.error}`);
  for (const note of uncaptured) ctx.out.warn(`  ⚠ ${note}`);
}

/** Preview, confirm, and restore files. Returns true only when every file restored. */
async function restoreFiles(ctx: SlashContext, session: Session, checkpointTurnId: string): Promise<boolean> {
  const preview = await session.rewindFiles(checkpointTurnId, { dryRun: true });
  const changed = preview.filesChanged ?? [];
  const failures = preview.failures ?? [];
  if (!preview.canRewind && failures.length === 0) {
    ctx.out.warn(`Cannot rewind files: ${preview.error ?? 'unknown error'}`);
    return false;
  }
  const uncaptured = preview.uncaptured ?? [];
  if (changed.length === 0 && failures.length === 0) {
    ctx.out.info('No file changes to restore since that prompt.');
    for (const note of uncaptured) ctx.out.warn(`  ⚠ ${note}`);
    return true;
  }
  const conflicts = new Set(preview.conflicts ?? []);
  showPreview(ctx, changed, conflicts, failures, uncaptured);
  const choices = conflicts.size > 0
    ? ['Restore all, overwriting changes made outside the agent', 'Restore, but keep files changed outside the agent', 'Cancel']
    : ['Restore these files', 'Cancel'];
  const choice = await pick(ctx, choices, 'Restore files?');
  if (choice !== 0 && !(conflicts.size > 0 && choice === 1)) {
    ctx.out.info('Rewind cancelled; nothing changed.');
    return false;
  }
  // Only an explicit "overwrite" choice on a conflict prompt overwrites outside edits.
  const result = await session.rewindFiles(checkpointTurnId, { overwriteConflicts: conflicts.size > 0 && choice === 0 });
  const restored = result.filesChanged ?? [];
  if (restored.length > 0) {
    ctx.out.success(`Restored ${restored.length} ${restored.length === 1 ? 'file' : 'files'} (+${result.insertions ?? 0} / -${result.deletions ?? 0} lines).`);
  }
  if (result.canRewind) return true;
  // Files the operator chose to keep (conflicts, no overwrite) are a decision,
  // not a failure: report them, and let `both` still rewind the conversation.
  const kept = choice === 1 ? conflicts : new Set<string>();
  const real = (result.failures ?? []).filter((f) => !kept.has(f.path));
  const keptCount = (result.failures ?? []).length - real.length;
  if (keptCount > 0) ctx.out.info(`Kept ${keptCount} ${keptCount === 1 ? 'file' : 'files'} changed outside the agent.`);
  for (const failure of real) ctx.out.error(`Not restored: ${failure.path}: ${failure.error}`);
  if (!result.failures?.length) ctx.out.error(`File rewind failed: ${result.error ?? 'unknown error'}`);
  return result.failures !== undefined && result.failures.length > 0 && real.length === 0;
}

/**
 * Fork the pre-rewind journal state into a sibling session before truncation
 * so the abandoned path survives as a branch (stage 3 of #4271 / #4294).
 *
 * Best-effort: a fork failure (no journal, disabled journaling, I/O error)
 * silently no-ops — the rewind still proceeds. We flush the live journal queue
 * first so the on-disk fold includes all messages up to this moment.
 */
interface ForkResult { id: string; path: string }

/**
 * Attempt to fork the pre-rewind journal state. Returns the fork metadata on
 * success so the caller can clean it up if the rewind itself fails (preventing
 * ghost branches). Returns `undefined` when the fork could not be created.
 */
async function forkBeforeRewind(ctx: SlashContext): Promise<ForkResult | undefined> {
  try {
    await ctx.session.current.messageJournal?.flush();
  } catch {
    // flush failure → proceed; fork may be slightly stale but still useful
  }
  const sourceId = ctx.stats.sessionId;
  if (!sourceId) return undefined;
  let forked: ForkResult;
  try {
    forked = forkStoredSession(ctx.stats);
  } catch {
    // best-effort: never block the rewind on a fork failure
    return undefined;
  }
  const ok = forkJournal(sourceId, forked.id);
  if (!ok) {
    try { unlinkSync(forked.path); } catch { /* ignore cleanup failure */ }
    return undefined;
  }
  return forked;
}

/** Remove a forked sidecar + journal when the rewind it was created for fails. */
function cleanupFork(forked: ForkResult): void {
  try { unlinkSync(forked.path); } catch { /* ignore cleanup failure */ }
}

async function rewindConversation(ctx: SlashContext, session: Session, target: RewindTarget, dropped: number, total: number) {
  // Fork the pre-rewind state so the abandoned path survives as a branch.
  // This runs BEFORE truncation so the fork captures the full history.
  const forked = await forkBeforeRewind(ctx);

  const result = await session.rewindConversation(target.turnIndex);
  if (!result.rewound) {
    // Rewind failed — clean up the fork to avoid ghost branches.
    if (forked) cleanupFork(forked);
    const reason = result.reason ?? 'unknown';
    if (reason === 'not-supported') {
      ctx.out.warn('Rewind is not supported for this provider — use a Claude model to enable /rewind.');
    } else if (reason === 'session-busy' || reason === 'turn-in-flight') {
      ctx.out.info('Cannot rewind while a turn is running.');
    } else {
      ctx.out.info(`Cannot rewind (${reason}).`);
    }
    return 'continue' as const;
  }
  // Report in PROMPTS, not raw API messages: `messagesBefore/After` count
  // every assistant tool_use and user tool_result message (~2 per tool round).
  const kept = total - dropped;
  ctx.out.success(
    `Rewound ${dropped} ${dropped === 1 ? 'prompt' : 'prompts'} (${kept} earlier kept). Edit the message below and press Enter to resend.`,
  );
  return { kind: 'prefill' as const, message: result.reloadText ?? '' };
}

export const rewindCmd: SlashCommand = {
  name: '/rewind',
  requires: ['sessionControl', 'choose'],
  summary: 'Rewind the conversation, files, or both to a previous message',
  hint: 'When you want to go back to an earlier prompt — pick a message, then choose conversation (its text loads into the input to edit and resend), files (restore files to how they were before it), or both. A file restore is always previewed first. `/rewind conversation|files|both` skips the mode menu. (Also: press Esc twice at an empty prompt for a conversation-only rewind.)',
  async handler(ctx, args) {
    const forced = args.trim().toLowerCase();
    if (forced !== '' && !MODES.includes(forced as RewindMode)) {
      ctx.out.warn('Usage: /rewind [conversation|files|both]');
      return 'continue';
    }
    const session = ctx.session.current;
    const targets = session.listRewindTargets();
    if (targets.length === 0) {
      ctx.out.info('Nothing to rewind to — no earlier messages in this conversation.');
      return 'continue';
    }
    const choice = await pick(ctx, targets.map((t) => t.preview), 'Rewind to a message');
    if (choice === null) {
      ctx.out.info('Rewind requires an interactive terminal.');
      return 'continue';
    }
    if (choice === ':cancel') return 'continue';
    const target = targets[choice];
    if (!target) return 'continue';

    const mode = forced !== '' ? forced as RewindMode : await chooseMode(ctx, target);
    if (mode === undefined) return 'continue';
    if (mode !== 'conversation') {
      if (target.checkpointTurnId === undefined) {
        ctx.out.warn('No file checkpoint for that prompt (checkpointing is off, or the prompt predates a resume, /model switch, or compaction). Use /rewind conversation to rewind the conversation only.');
        return 'continue';
      }
      const restored = await restoreFiles(ctx, session, target.checkpointTurnId);
      if (mode === 'files') return 'continue';
      if (!restored) {
        ctx.out.warn('Conversation not rewound because not every file was restored. Run /rewind conversation to rewind it anyway.');
        return 'continue';
      }
    }
    // Targets are newest-first, so picking index `choice` discards the chosen
    // prompt plus the `choice` newer ones.
    return rewindConversation(ctx, session, target, choice + 1, targets.length);
  },
};
