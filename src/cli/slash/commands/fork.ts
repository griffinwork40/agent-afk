/**
 * /fork (alias /branch) — duplicate the current conversation into a new,
 * independent session and surface how to continue it in parallel.
 *
 * The original session keeps running in this tab, untouched. The fork is a
 * fresh sidecar (new id, fresh sessionId) seeded with the current turn
 * history, resumable via `afk interactive --resume <new-id>`.
 *
 * Two layers, decoupled:
 *   - Always: write the fork + print the resume command. This is the
 *     contract that can never fail silently.
 *   - Best-effort, local-interactive-REPL only: detect the terminal and open
 *     the fork in a new tab/window, or (if that doesn't happen) copy the
 *     resume command to the clipboard. Both degrade to the printed command —
 *     never a false success, and never fired for Telegram/daemon callers.
 */

import { palette } from '../../palette.js';
import { forkStoredSession } from '../../session-store.js';
import { formatResumeCommand } from '../../resume-command.js';
import { copyToClipboard } from '../../clipboard.js';
import { trySpawnTab, type SpawnOutcome, type TerminalKind } from '../../terminal-spawn/index.js';
import type { SlashCommand } from '../types.js';

const TERMINAL_LABELS: Record<TerminalKind, string> = {
  'tmux': 'tmux',
  'wezterm': 'WezTerm',
  'kitty': 'kitty',
  'iterm2': 'iTerm',
  'apple-terminal': 'Terminal',
  'ghostty': 'Ghostty',
  'windows-terminal': 'Windows Terminal',
  'gnome-terminal': 'GNOME Terminal',
  'konsole': 'Konsole',
  'vscode': 'VS Code',
  'alacritty': 'Alacritty',
  'hyper': 'Hyper',
  'unknown': 'this terminal',
};

/**
 * Build the styled output lines for a fork result. Pure (no I/O) so every
 * branch — spawned tab, spawned window, VS Code dead-end, generic fallback —
 * is unit-testable without launching a real terminal.
 */
export function forkSpawnLines(spawn: SpawnOutcome, command: string, copied: boolean): string[] {
  const lines: string[] = [];
  if (spawn.spawned) {
    const where = spawn.capability === 'window' ? 'window' : 'tab';
    lines.push(palette.info(`  ↗ Continuing in a new ${TERMINAL_LABELS[spawn.kind]} ${where}.`));
    lines.push(palette.dim('  Or run it yourself:'));
  } else {
    if (spawn.kind === 'vscode' && spawn.reason === 'no-tab-mechanism') {
      lines.push(palette.dim("  VS Code's integrated terminal can't be opened from outside — run this in a new terminal:"));
    } else {
      lines.push(palette.dim('  Continue the fork with:'));
    }
  }
  lines.push(palette.brand(`    ${command}`));
  if (copied) lines.push(palette.dim('  (copied to clipboard)'));
  lines.push('');
  lines.push(palette.meta('  This session continues here, untouched. The fork carries the'));
  lines.push(palette.meta('  conversation only — live subagents and background jobs are not forked.'));
  return lines;
}

export const forkCmd: SlashCommand = {
  name: '/fork',
  aliases: ['/branch'],
  usage: '/fork',
  hint: 'When you want to explore a divergent path without losing this thread — duplicates the conversation into a new resumable session you can continue in parallel.',
  summary: 'Duplicate this conversation into a new, independent session',
  async handler(ctx) {
    if (ctx.stats.totalTurns === 0) {
      ctx.out.warn('Nothing to fork yet — no turns in this session.');
      return 'continue';
    }

    let id: string;
    let path: string;
    try {
      ({ id, path } = forkStoredSession(ctx.stats));
    } catch (err) {
      ctx.out.error(`Could not fork: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    const command = formatResumeCommand(id, ctx.stats.model);
    const cwd = ctx.stats.cwd ?? process.cwd();

    // Best-effort tab spawn AND clipboard fallback. Both are gated on the same
    // local-interactive-REPL check (requestResume is the established marker —
    // absent on Telegram/daemon, see /resume) and a real TTY. Without this
    // gate, a Telegram/daemon-invoked /fork on a host that still has its own
    // TTY (e.g. the bot run directly in a terminal rather than as a service)
    // would fall through to the OSC 52 path and write escape bytes into the
    // *host's* terminal while reporting "(copied to clipboard)" to the remote
    // caller — copying to the wrong machine's clipboard while claiming success.
    // Never blocks or throws; failure falls through to the print path.
    const interactive = typeof ctx.requestResume === 'function' && process.stdout.isTTY === true;
    const spawn = trySpawnTab({ forkId: id, model: ctx.stats.model, cwd, interactive });
    const copied = !spawn.spawned && interactive && copyToClipboard(command);

    ctx.out.success(palette.success('Forked') + palette.dim(`  ${path}`));
    ctx.out.line();
    for (const line of forkSpawnLines(spawn, command, copied)) ctx.out.line(line);
    ctx.out.line();
    return 'continue';
  },
};
