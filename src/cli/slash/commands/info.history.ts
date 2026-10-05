/**
 * `/history [N]` — replay the conversation so far (split out of info.ts, which
 * is over the file-size ceiling; `infoCommands` there still exports it).
 *
 * Source order: the message journal (full fidelity, rendered by the same
 * StreamRenderer a live turn uses; see turn-record-renderer.replay.journal.ts),
 * then the sidecar `turns[]` replay when the journal has nothing.
 *
 * @module cli/slash/commands/info.history
 */

import { replayTurns } from '../../commands/interactive/turn-record-renderer.replay.js';
import { replayJournal } from '../../commands/interactive/turn-record-renderer.replay.journal.js';
import type { SlashCommand } from '../types.js';

export const historyCmd: SlashCommand = {
  name: '/history',
  usage: '/history [N]',
  summary: 'Show conversation history (full replay; optionally limit to last N turns)',
  hint: 'When you want to review recent conversation turns with full content. Pass a number to limit output: `/history 10` shows the last 10 turns.',
  async handler(ctx, args) {
    const { stats, out } = ctx;
    // Parse an optional numeric argument: `/history 20` shows last 20 turns.
    const parsed = parseInt((args ?? '').trim(), 10);
    const maxTurns = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    // Journal first (full fidelity, same renderer as a live turn); the
    // sidecar replay only when the journal has nothing. The live journal
    // writes through an async queue, so drain it before reading the file.
    // Contract: check the journal BEFORE testing stats.turns — a resumed
    // session may have journal content but an empty turns array (the sidecar
    // tracks only the current-session turns, not the replayed history).
    try {
      await ctx.session.current.messageJournal?.flush();
    } catch {
      // A failed flush only means a possibly-stale read; replay still proceeds.
    }
    const sink = { fn: (line: string) => out.line(line) };
    const rendered = await replayJournal(stats.sessionId, sink, {
      hints: stats.turns.map((t) => t.user),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });
    if (rendered === null) {
      if (stats.turns.length === 0) {
        out.info('No conversation history yet.');
        return 'continue';
      }
      replayTurns(stats.turns, sink.fn, { maxTurns });
    }
    return 'continue';
  },
};
