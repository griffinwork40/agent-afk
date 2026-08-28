/**
 * /suggestions slash command — view and manage REPL input history.
 *
 * The history ring is the source for Tier-1 ghost-text suggestions (prefix
 * matches) and for ↑/↓ recall. This command surfaces what the ring holds
 * and lets the user remove entries they do not want persisted.
 *
 * Usage:
 *   /suggestions           — show last 20 entries
 *   /suggestions 50        — show last N entries
 *   /suggestions rm 3      — remove entry #3 (index from output)
 *   /suggestions clear     — wipe all history (memory + disk)
 *
 * Reads from the in-memory ring (not the disk file) to avoid flush races.
 */

import type { SlashCommand } from '../types.js';
import { palette } from '../../palette.js';

const DEFAULT_SHOW = 20;

export const suggestionsCmd: SlashCommand = {
  name: '/suggestions',
  usage: '/suggestions [N | rm <index> | clear]',
  summary: 'View or manage saved input history (ghost-text source)',
  hint:
    'List recent inputs that feed ghost-text suggestions. ' +
    '`/suggestions rm 3` removes entry #3. `/suggestions clear` wipes all history. ' +
    'Tip: prefix any input with a space to skip history recording.',
  async handler(ctx, args) {
    const compositor = ctx.getCompositor?.();
    const history = compositor?.history;

    if (!history || typeof history.getEntries !== 'function') {
      ctx.out.warn('History is not available on this surface.');
      return 'continue';
    }

    const trimmed = args.trim();

    // --- clear ---
    if (trimmed === 'clear') {
      if (typeof history.clear !== 'function') {
        ctx.out.warn('History clearing is not supported.');
        return 'continue';
      }
      const count = history.length ?? 0;
      if (count === 0) {
        ctx.out.info('History is already empty.');
        return 'continue';
      }
      history.clear();
      ctx.out.success(`Cleared ${count} history entries (memory + disk).`);
      return 'continue';
    }

    // --- rm <index> ---
    if (trimmed.startsWith('rm ')) {
      const idxStr = trimmed.slice(3).trim();
      const displayIdx = parseInt(idxStr, 10);
      if (Number.isNaN(displayIdx) || displayIdx < 1) {
        ctx.out.warn(`Invalid index: "${idxStr}". Use a number from the /suggestions list.`);
        return 'continue';
      }

      // getEntries() returns newest-first; convert display index (1-based,
      // newest-first) to internal index (0-based, oldest-first).
      const entries = history.getEntries();
      if (displayIdx > entries.length) {
        ctx.out.warn(`Index ${displayIdx} is out of range (${entries.length} entries).`);
        return 'continue';
      }
      // Display index 1 = newest = entries[0] = internal entries.length - 1
      const internalIdx = entries.length - displayIdx;
      const removed = entries[displayIdx - 1];
      if (typeof history.removeAt !== 'function') {
        ctx.out.warn('History removal is not supported.');
        return 'continue';
      }
      const ok = history.removeAt(internalIdx);
      if (ok) {
        const preview = removed && removed.length > 60
          ? removed.slice(0, 57) + '...'
          : removed;
        ctx.out.success(`Removed #${displayIdx}: ${palette.dim(preview ?? '(unknown)')}`);
      } else {
        ctx.out.warn(`Failed to remove entry #${displayIdx}.`);
      }
      return 'continue';
    }

    // --- show [N] ---
    const limit = trimmed ? parseInt(trimmed, 10) : DEFAULT_SHOW;
    if (Number.isNaN(limit) || limit < 1) {
      ctx.out.warn(`Usage: /suggestions [N | rm <index> | clear]`);
      return 'continue';
    }

    const entries = history.getEntries();
    if (entries.length === 0) {
      ctx.out.info('No history entries.');
      return 'continue';
    }

    const shown = entries.slice(0, limit);
    const { out } = ctx;
    out.line();
    out.line(
      palette.bold(`Input history`) +
      palette.dim(` (${entries.length} total, showing ${shown.length} newest)`),
    );
    out.line();
    shown.forEach((entry, i) => {
      const idx = palette.meta(`#${i + 1}`);
      const preview = entry.length > 80 ? entry.slice(0, 77) + '...' : entry;
      out.line(`  ${idx}  ${preview}`);
    });
    out.line();
    out.line(palette.dim('Tip: prefix input with a space to skip history recording.'));
    out.line();
    return 'continue';
  },
};
