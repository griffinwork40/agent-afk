/**
 * /resume [id] — list saved sessions, or perform a mid-session swap to a
 * stored one.
 *
 * With no argument: lists recent saves and their metadata.
 * With an id: atomically swaps the current AgentSession for the stored one
 * (tears down the outgoing session, builds a fresh one from the stored
 * config, mutates the shared SessionRef, reseeds stats, and prints a
 * "Resuming…" banner). Falls back to printing the launch command if the
 * requestResume capability is not available in the current context.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { findSession, listSessions } from '../../session-store.js';
import { formatCost } from '../../format-utils.js';
import { formatResumeCommand } from '../../resume-command.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import type { SlashCommand } from '../types.js';

function fmtWhen(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '      —       ';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '      —       ';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** Convert a found session entry into a ResolvedResumeTarget. */
function resolveFromFound(found: NonNullable<ReturnType<typeof findSession>>): ResolvedResumeTarget {
  return {
    id: found.id,
    resumeId: found.data.sessionId ?? found.id,
    stored: found.data,
  };
}

export const resumeCmd: SlashCommand = {
  name: '/resume',
  usage: '/resume [id]',
  hint: 'When you want to continue a previously /saved session — runs interactively to pick one if no id is given.',
  summary: 'List saved sessions, or swap the active session for a stored one',
  async handler(ctx, args) {
    const target = args.trim();
    if (target) {
      const found = findSession(target);
      if (!found) {
        ctx.out.warn(`No saved session: ${target}`);
        return 'continue';
      }
      // Prefer the human name over the UUID in all user-facing messages.
      const label = found.data.name ?? found.id;

      if (typeof ctx.requestResume === 'function') {
        // Guard against resuming into the live session (PR #355 C2).
        // The 12-step swap would otherwise tear down and rebuild the current
        // session from the last on-disk snapshot, silently dropping any turn
        // data accumulated since the last /save. Match on the SDK session id
        // when available (canonical), falling back to the saved file id.
        // External constraint: this comparison is the only barrier between
        // /resume and unintended data loss for users who type their current
        // session id by accident.
        const currentSdkId = ctx.session.current.sessionId;
        const targetSdkId = found.data.sessionId;
        const isSameSession =
          (currentSdkId !== undefined && targetSdkId !== undefined && currentSdkId === targetSdkId) ||
          (currentSdkId !== undefined && currentSdkId === found.id);
        if (isSameSession) {
          ctx.out.warn(`Already on session ${label}.`);
          return 'continue';
        }

        // Mid-session swap path.
        ctx.out.info(`Resuming session ${label} …`);
        const result = await ctx.requestResume(resolveFromFound(found));
        if (result.ok) {
          ctx.out.success(`Resumed ${label}  (sdk id: ${result.sessionId})`);
        } else {
          ctx.out.warn(result.reason);
        }
        return 'continue';
      }

      // Fallback: requestResume not available (e.g. daemon, Telegram).
      // Print the launch command so the user knows how to resume manually.
      const loaded = found.data;
      const resumeTarget = loaded.name ?? loaded.sessionId ?? found.id;
      ctx.out.line();
      ctx.out.line(palette.bold(`Session ${loaded.name ?? found.id}`));
      ctx.out.line(divider());
      ctx.out.line(`  name        ${palette.brand(loaded.name ?? '—')}`);
      ctx.out.line(`  source      ${palette.brand(loaded.source ?? 'cli')}`);
      ctx.out.line(`  model       ${palette.brand(loaded.model)}`);
      ctx.out.line(`  turns       ${palette.meta(String(loaded.totalTurns))}`);
      ctx.out.line(`  cost        ${palette.meta(formatCost(loaded.totalCostUsd))}`);
      ctx.out.line(`  sdk id      ${palette.meta(loaded.sessionId ?? '—')}`);
      ctx.out.line();
      ctx.out.line(palette.dim('  Resume with:'));
      ctx.out.line(palette.brand(`    ${formatResumeCommand(resumeTarget, loaded.model)}`));
      ctx.out.line();
      return 'continue';
    }

    const entries = listSessions();
    if (entries.length === 0) {
      ctx.out.info('No saved sessions found.  Use /save first.');
      return 'continue';
    }
    const currentCwd = ctx.stats.cwd ?? process.cwd();
    const localEntries = entries.filter((e) => e.cwd === currentCwd);
    const isFiltered = localEntries.length > 0;
    const displayEntries = isFiltered ? localEntries : entries;
    const header = isFiltered
      ? palette.bold(`Saved sessions  (${displayEntries.length})`)
      : palette.bold(`Saved sessions — all (none in this directory)`);
    ctx.out.line();
    ctx.out.line(header);
    ctx.out.line(divider());
    for (const e of displayEntries.slice(0, 20)) {
      const when = fmtWhen(e.savedAt);
      const model = palette.brand(e.model.padEnd(7));
      const turns = palette.meta(`${e.totalTurns} turn${e.totalTurns === 1 ? '' : 's'}`.padEnd(9));
      const cost = palette.meta(formatCost(e.totalCostUsd).padStart(8));
      // Origin marker: 'tg' for sessions that started in Telegram, blank for CLI.
      const origin = e.source === 'telegram' ? palette.brand('tg') : '  ';
      // Prefer the human name; fall back to the sidecar id (UUID) for legacy
      // sessions saved before naming existed.
      const label = palette.warning(e.name ?? e.id);
      ctx.out.line(`  ${when}  ${model}  ${turns}  ${cost}  ${origin}  ${label}`);
    }
    ctx.out.line();
    ctx.out.line(palette.dim('  Resume with:  /resume <name>'));
    ctx.out.line();
    return 'continue';
  },
};
