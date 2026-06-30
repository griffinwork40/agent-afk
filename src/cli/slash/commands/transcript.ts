import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { formatCost, formatDuration } from '../../format-utils.js';
import { renderMarkdownToTerminal } from '../../formatter.js';
import type { SlashCommand, TurnRecord } from '../types.js';

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTurnMeta(turn: TurnRecord, index: number): string {
  const parts: string[] = [
    palette.meta(`#${index + 1}`),
    palette.dim(formatTimestamp(turn.timestamp)),
  ];
  if (turn.durationMs !== undefined && turn.durationMs > 0) {
    parts.push(palette.dim(formatDuration(turn.durationMs)));
  }
  if (turn.costUsd !== undefined && turn.costUsd > 0) {
    parts.push(palette.dim(formatCost(turn.costUsd)));
  }
  if (turn.inputTokens !== undefined || turn.outputTokens !== undefined) {
    const inp = turn.inputTokens ?? 0;
    const out = turn.outputTokens ?? 0;
    parts.push(palette.dim(`${Math.round((inp + out) / 1000)}k tok`));
  }
  return parts.join('  ');
}

function formatToolEvents(turn: TurnRecord): string {
  if (!turn.toolEvents || turn.toolEvents.length === 0) return '';
  const lines: string[] = [];
  for (const ev of turn.toolEvents) {
    const glyph = ev.isError ? palette.error('✗') : palette.dim('●');
    const name = palette.chrome(ev.toolName);
    let preview = '';
    if (ev.result) {
      const first = ev.result.trim().split('\n')[0] ?? '';
      preview = first.length > 80 ? first.slice(0, 77) + '...' : first;
    }
    lines.push(`    ${glyph} ${name}${preview ? palette.dim(`  ${preview}`) : ''}`);
  }
  return lines.join('\n') + '\n';
}

function formatTranscript(
  turns: readonly TurnRecord[],
  model: string,
  sessionStart: number,
  totalCost: number,
): string {
  const lines: string[] = [];

  lines.push(divider('Session Transcript'));
  const headerParts = [
    palette.dim(`Started ${new Date(sessionStart).toLocaleString()}`),
    palette.dim(`model: ${model}`),
    palette.dim(`${turns.length} turn${turns.length === 1 ? '' : 's'}`),
  ];
  if (totalCost > 0) headerParts.push(palette.dim(formatCost(totalCost)));
  lines.push(headerParts.join('  ·  '));
  lines.push('');

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;

    lines.push(formatTurnMeta(turn, i));
    lines.push('');

    lines.push(`  ${palette.user('▶')} ${palette.user('User')}`);
    lines.push('');
    const userLines = turn.user.split('\n').map((l) => `  ${l}`);
    lines.push(userLines.join('\n'));
    lines.push('');

    const toolBlock = formatToolEvents(turn);
    if (toolBlock) {
      lines.push(`  ${palette.chrome('Tools')}`);
      lines.push(toolBlock);
    }

    lines.push(`  ${palette.brand('◆')} ${palette.brand('Assistant')}`);
    lines.push('');
    const rendered = renderMarkdownToTerminal(turn.assistant);
    const assistantLines = rendered.split('\n').map((l) => `  ${l}`);
    lines.push(assistantLines.join('\n'));
    lines.push('');

    if (i < turns.length - 1) {
      lines.push(divider());
      lines.push('');
    }
  }

  lines.push(divider());
  return lines.join('\n') + '\n';
}

function resolvePager(): { cmd: string; args: string[] } | null {
  const pager = env.PAGER;
  if (pager) {
    const parts = pager.split(/\s+/);
    return { cmd: parts[0]!, args: parts.slice(1) };
  }
  return { cmd: 'less', args: ['-R'] };
}

export const transcriptCmd: SlashCommand = {
  name: '/transcript',
  aliases: ['/t'],
  summary: 'View full session transcript in $PAGER',
  hint: 'When you want to read the full conversation — all turns, tool calls, costs — in a scrollable pager.',
  async handler(ctx) {
    const { stats, out } = ctx;
    if (stats.turns.length === 0) {
      out.info('No turns yet in this session.');
      return 'continue';
    }

    const formatted = formatTranscript(
      stats.turns,
      String(stats.model),
      stats.sessionStartTime,
      stats.totalCostUsd,
    );

    if (!process.stdout.isTTY) {
      out.raw(formatted);
      return 'continue';
    }

    const pager = resolvePager();
    if (!pager) {
      out.raw(formatted);
      return 'continue';
    }

    const tmpPath = path.join(
      os.tmpdir(),
      `afk-transcript-${Date.now()}.txt`,
    );
    await fs.writeFile(tmpPath, formatted, { mode: 0o600 });

    // Invariant (TTY handoff ordering): the pager inherits stdin (`stdio:
    // 'inherit'`), so it reads the SAME fd 0 the REPL owns. Before spawning we
    // must (1) suspendInput() — drop the compositor's keypress listener, unset
    // raw mode, clear the input overlay — AND (2) pause Node's stdin so the
    // parent stops draining fd 0. Otherwise the REPL reader and the pager both
    // read() the shared fd and split every keystroke between them (the "glitchy"
    // pager navigation). The inverse runs on child exit: resume stdin, then
    // resumeInput() to re-arm raw mode + the listener + repaint. suspendInput
    // alone (the elicitation path) is NOT sufficient here — elicitation keeps
    // the input consumer in-process, so it never needs the stdin.pause() that a
    // cross-process fd handoff additionally requires (arm() left stdin resumed
    // with a persistent emitKeypressEvents 'data' consumer attached).
    const compositor = ctx.getCompositor?.() ?? null;
    let restored = false;
    const restoreInput = (): void => {
      if (restored) return;
      restored = true;
      try { process.stdin.resume(); } catch { /* best-effort */ }
      compositor?.resumeInput();
    };
    compositor?.suspendInput();
    try { process.stdin.pause(); } catch { /* best-effort */ }

    return new Promise<'continue'>((resolve) => {
      const finish = (emitFallback: boolean): void => {
        restoreInput();
        if (emitFallback) out.raw(formatted);
        fs.unlink(tmpPath).catch(() => {});
        resolve('continue');
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(pager.cmd, [...pager.args, tmpPath], { stdio: 'inherit' });
      } catch {
        // Synchronous spawn failure (bad options) — restore the TTY and fall
        // back to inline output rather than leaving stdin suspended/paused.
        finish(true);
        return;
      }
      child.on('error', () => finish(true));
      child.on('exit', () => finish(false));
    });
  },
};
