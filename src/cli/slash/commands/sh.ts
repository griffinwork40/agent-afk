/**
 * /sh — inspect and manage user-typed `!cmd` shell-passthrough jobs.
 *
 * Subcommands:
 *
 *   /sh              — alias for `/sh list`
 *   /sh list         — table of every job in this session (running + done)
 *   /sh show <id>    — print the captured output of a job (raw, ANSI preserved)
 *   /sh kill <id>    — terminate a running job (no-op on already-terminal jobs)
 *
 * The `<id>` form is `sh-N` (zero leading prefix accepted for muscle memory:
 * `/sh show 3` and `/sh show sh-3` are equivalent).
 *
 * Distinct from `/bgsub` (subagent backgrounding). This command operates
 * only on shell processes spawned via the REPL's `!`-prefix dispatch path;
 * the model-side bash tool has its own (non-backgrounded, v1) result
 * delivery and is not surfaced here.
 *
 * @module cli/slash/commands/sh
 */

import { palette } from '../../palette.js';
import type { SlashCommand } from '../types.js';
import type { ShellPassthrough } from '../../commands/interactive/shell-passthrough.js';
import { formatDuration } from '../../format-utils.js';

let passthroughRef: ShellPassthrough | undefined;

/**
 * Wired from `runReplLoop` after the ShellPassthrough is constructed.
 * Mirrors the `setBgsubRegistry` injection seam used by the `/bgsub`
 * commands. Absent on Telegram/daemon surfaces — those handlers
 * short-circuit with an "unavailable" notice.
 */
export function setShellPassthrough(pt: ShellPassthrough): void {
  passthroughRef = pt;
}

/** Resolve `3` or `sh-3` to a canonical `sh-3`. */
function normalizeJobId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('sh-')) return trimmed;
  // Accept bare digits as a shortcut; reject anything else so a typo
  // doesn't accidentally match a real job id.
  if (/^\d+$/.test(trimmed)) return `sh-${trimmed}`;
  return trimmed; // Will fail the lookup below — handler prints "not found".
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'running': return '▶';
    case 'completed': return '✓';
    case 'failed': return '✗';
    case 'killed': return '⊘';
    default: return '?';
  }
}

export const shCmd: SlashCommand = {
  name: '/sh',
  summary: 'Inspect or kill user-typed `!cmd` shell jobs',
  usage: '/sh [list | show <id> | kill <id>]',
  hint:
    'Manages shell processes started with `!cmd` (foreground) or `!&cmd` ' +
    '(background). No args → list. `show <id>` prints captured output, ' +
    '`kill <id>` terminates a running job.',
  async handler(ctx, args) {
    if (!passthroughRef) {
      ctx.out.error('Shell passthrough not available in this session.');
      return 'continue';
    }
    const trimmed = args.trim();
    const [verb, ...rest] = trimmed === '' ? ['list'] : trimmed.split(/\s+/);
    const arg = rest.join(' ');

    switch (verb) {
      case 'list': {
        const jobs = passthroughRef.registry.list();
        if (jobs.length === 0) {
          ctx.out.line(palette.dim('  no shell jobs in this session yet — type !<cmd> to start one'));
          return 'continue';
        }
        ctx.out.line(palette.dim('  id     status     duration     mode  command'));
        for (const job of jobs) {
          const glyph = statusGlyph(job.status);
          const status = job.status.padEnd(10);
          const dur = job.result
            ? formatDuration(job.result.durationMs).padEnd(12)
            : formatDuration(Date.now() - job.startedAt).padEnd(12);
          const mode = job.mode === 'background' ? 'bg' : 'fg';
          const cmd = job.command.length > 60 ? job.command.slice(0, 57) + '...' : job.command;
          ctx.out.line(`  ${glyph} ${job.id.padEnd(5)} ${status} ${dur} ${mode.padEnd(4)} ${cmd}`);
        }
        return 'continue';
      }
      case 'show': {
        if (!arg) {
          ctx.out.info('Usage: /sh show <id>');
          return 'continue';
        }
        const id = normalizeJobId(arg);
        const job = passthroughRef.registry.get(id);
        if (!job) {
          ctx.out.error(`Job ${id} not found.`);
          return 'continue';
        }
        ctx.out.line(palette.dim(`$ ${job.command}`));
        if (!job.result) {
          ctx.out.line(palette.dim('  (still running — output captured so far is not yet flushed)'));
          return 'continue';
        }
        const text = job.result.displayCaptured;
        if (text.length === 0) {
          ctx.out.line(palette.dim('  (no output)'));
        } else {
          // Captured output preserves ANSI; .raw writes verbatim so colors
          // render in the terminal.
          ctx.out.raw(text.endsWith('\n') ? text : text + '\n');
        }
        const exitPart = job.result.errorReason === 'abort'
          ? 'killed'
          : job.result.errorReason === 'timeout'
            ? 'timed out'
            : `exit ${job.result.exitCode ?? 0}`;
        ctx.out.line(palette.dim(`  [${job.id} · ${exitPart} · ${formatDuration(job.result.durationMs)}]`));
        if (job.result.truncated) {
          ctx.out.line(palette.warning('  ⚠ output was truncated — re-run with smaller scope if you need the tail'));
        }
        return 'continue';
      }
      case 'kill': {
        if (!arg) {
          ctx.out.info('Usage: /sh kill <id>');
          return 'continue';
        }
        const id = normalizeJobId(arg);
        const ok = passthroughRef.registry.kill(id);
        if (ok) {
          ctx.out.success(`Killed ${id}.`);
        } else {
          const job = passthroughRef.registry.get(id);
          if (!job) {
            ctx.out.error(`Job ${id} not found.`);
          } else {
            ctx.out.warn(`${id} is not running (status: ${job.status}).`);
          }
        }
        return 'continue';
      }
      default: {
        ctx.out.warn(`Unknown subcommand: ${verb}. Try /sh list, /sh show <id>, or /sh kill <id>.`);
        return 'continue';
      }
    }
  },
};
