/**
 * /resume [id] — list saved sessions, or perform a mid-session swap to a
 * stored one.
 *
 * With an id: atomically swaps the current AgentSession for the stored one
 * (tears down the outgoing session, builds a fresh one from the stored
 * config, mutates the shared SessionRef, reseeds stats, and prints a
 * "Resuming…" banner). Falls back to printing the launch command if the
 * requestResume capability is not available in the current context.
 *
 * With no argument: opens an arrow-key picker of recent saves on a TTY (the
 * hint's long-promised interactive path); on non-TTY surfaces (Telegram,
 * daemon, tests) it prints the read-only table and asks for `/resume <name>`.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { findSession, listSessions } from '../../session-store.js';
import { formatCost } from '../../format-utils.js';
import { formatResumeCommand } from '../../resume-command.js';
import { runPicker } from '../../render/picker.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import type { SlashCommand, SlashContext } from '../types.js';

type SessionEntry = ReturnType<typeof listSessions>[number];

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

/** Plain (un-coloured) one-line label for a session, used as a picker option. */
function pickLabel(e: SessionEntry): string {
  const model = e.model.padEnd(7);
  const turns = `${e.totalTurns} turn${e.totalTurns === 1 ? '' : 's'}`.padEnd(9);
  const origin = e.source === 'telegram' ? 'tg' : '  ';
  return `${fmtWhen(e.savedAt)}  ${model}  ${turns}  ${origin}  ${e.name ?? e.id}`;
}

/**
 * Picker option strings for a set of entries, guaranteed unique.
 *
 * Invariant: `runPicker` resolves with the selected *label string*, and the
 * caller maps it back to a row via `options.indexOf(label)`. Two entries can
 * render an identical `pickLabel` — duplicate session names are allowed and
 * `fmtWhen` truncates the timestamp to the minute — in which case `indexOf`
 * would resolve BOTH highlighted rows to the first match and resume the wrong
 * session. Appending the (unique) sidecar id to any colliding label keeps
 * every option distinct so the label→row mapping stays exact.
 */
function uniquePickLabels(entries: readonly SessionEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const l = pickLabel(e);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return entries.map((e) => {
    const l = pickLabel(e);
    return (counts.get(l) ?? 0) > 1 ? `${l}  ${palette.dim(e.id)}` : l;
  });
}

/**
 * Resume a resolved session: guard against resuming into the live session,
 * then swap via requestResume, or (when that capability is absent) print the
 * launch command. Writes all output via ctx.out; never throws.
 */
async function resumeFound(
  ctx: SlashContext,
  found: NonNullable<ReturnType<typeof findSession>>,
): Promise<void> {
  // Prefer the human name over the UUID in all user-facing messages.
  const label = found.data.name ?? found.id;

  if (typeof ctx.requestResume === 'function') {
    // Guard against resuming into the live session (PR #355 C2). The swap would
    // otherwise tear down and rebuild the current session from the last on-disk
    // snapshot, silently dropping any turn data accumulated since the last
    // autosave. Match on the SDK session id when available (canonical), falling
    // back to the saved file id.
    // External constraint: this comparison is the only barrier between /resume
    // and unintended data loss for users who select their current session.
    const currentSdkId = ctx.session.current.sessionId;
    const targetSdkId = found.data.sessionId;
    const isSameSession =
      (currentSdkId !== undefined && targetSdkId !== undefined && currentSdkId === targetSdkId) ||
      (currentSdkId !== undefined && currentSdkId === found.id);
    if (isSameSession) {
      ctx.out.warn(`Already on session ${label}.`);
      return;
    }

    ctx.out.info(`Resuming session ${label} …`);
    const result = await ctx.requestResume(resolveFromFound(found));
    if (result.ok) {
      ctx.out.success(`Resumed ${label}  (sdk id: ${result.sessionId})`);
    } else {
      ctx.out.warn(result.reason);
    }
    return;
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
}

export const resumeCmd: SlashCommand = {
  name: '/resume',
  usage: '/resume [id]',
  hint: 'When you want to continue a previously saved session — runs interactively to pick one if no id is given.',
  summary: 'List saved sessions, or swap the active session for a stored one',
  async handler(ctx, args) {
    const target = args.trim();
    if (target) {
      const found = findSession(target);
      if (!found) {
        ctx.out.warn(`No saved session: ${target}`);
        return 'continue';
      }
      await resumeFound(ctx, found);
      return 'continue';
    }

    const entries = listSessions();
    if (entries.length === 0) {
      ctx.out.info('No saved sessions found.  Start a session — it autosaves each turn.');
      return 'continue';
    }
    const currentCwd = ctx.stats.cwd ?? process.cwd();
    const localEntries = entries.filter((e) => e.cwd === currentCwd);
    const isFiltered = localEntries.length > 0;
    const displayEntries = isFiltered ? localEntries : entries;

    // Interactive picker on a TTY: select a session to resume it directly.
    const compositor = ctx.getCompositor?.() ?? null;
    if (compositor) {
      const shown = displayEntries.slice(0, 20);
      const options = uniquePickLabels(shown);
      const picked = await runPicker(compositor, {
        header: [
          palette.bold(`Resume a session  (${shown.length})`),
          palette.dim(isFiltered ? 'saved in this directory' : 'all directories (none saved here)'),
          '',
        ],
        options,
      });
      const choice = picked?.[0];
      if (choice) {
        const idx = options.indexOf(choice);
        const entry = idx >= 0 ? shown[idx] : undefined;
        if (entry) {
          const found = findSession(entry.id);
          if (found) await resumeFound(ctx, found);
          else ctx.out.warn(`No saved session: ${entry.name ?? entry.id}`);
        }
      }
      return 'continue';
    }

    // Non-TTY fallback: read-only table + the manual resume hint.
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
