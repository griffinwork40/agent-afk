/**
 * Web-surface lifecycle handlers for /fork, /resume, and /exit.
 *
 * All three run inside the command route's reserveTurn/releaseTurn bracket —
 * admission is never bypassed here.
 *
 * /fork   — writes a sidecar fork via the shared forkStoredSession helper
 *           (same function the REPL uses), creates a new owned session from
 *           the fork's journal/history, and returns { kind:'navigate' }.
 *
 * /resume — with no args: emits a structured list of saved sessions using
 *           the Stage 2 block helpers (returns 'continue').
 *           with an id/name: creates a new owned session resumed from the
 *           stored sidecar and returns { kind:'navigate', sessionId }.
 *
 * /exit   — marks the session ended in its persisted sidecar, removes it
 *           from the owner maps via `SessionOwner.retire`, and returns
 *           { kind:'exit' }. In-flight SSE tails are unaffected because they
 *           tail the ledger file, not the in-memory session object.
 *
 * Clipboard-using and terminal-spawn paths from the REPL fork handler are
 * replaced by the navigate control: the dashboard selects the new session.
 */

import { forkStoredSession, findSession, listSessions, saveSession } from '../cli/session-store.js';
import { forkJournal } from '../agent/journal/index.js';
import { formatCost } from '../cli/format-utils.js';
import { writeKeyValue, writeList } from '../cli/slash/output-blocks.format.js';
import { resumeConfigFor } from '../cli/resume-session.js';
import { readLivePresenceFiles } from '../agent/awareness/presence.js';
import { reseedStatsFromStored } from '../cli/commands/interactive/shared.js';
import { getStats } from './session-owner.slash.js';
import { seedForkLedger } from './fork-ledger.js';
import type { StoredSession as StoredSidecar } from '../cli/session-store.js';
import type { SlashContext } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';
import type { SessionOwner } from './session-owner.js';

// ---------------------------------------------------------------------------
// /exit
// ---------------------------------------------------------------------------

/**
 * Mark an owned session as ended and persist the sidecar so the session
 * appears as completed in the sidebar. Returns the wire exit control.
 */
export async function handleWebExit(
  owner: SessionOwner,
  sessionId: string,
  ctx: SlashContext,
): Promise<CommandControl> {
  // Persist ended state so the sidebar shows the session as completed.
  const stats = ctx.stats;
  saveSession(
    { ...stats, sessionId: ctx.session.current.sessionId ?? sessionId },
    sessionId,
    { closeTime: true, exitReason: 'exit-command' },
  );
  ctx.out.info('Session ended. Start a new session or select one from the sidebar.');
  // Remove the session from all owner maps so prompt/command routes 409 and a
  // later autosave cannot undo the exit. Called AFTER saveSession so the sidecar
  // is durable before the AgentSession is torn down.
  owner.retire(sessionId);
  return { kind: 'exit' };
}

// ---------------------------------------------------------------------------
// /resume
// ---------------------------------------------------------------------------

/** Relative timestamp for session listing (same logic as resume.ts). */
function fmtWhen(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  const d = new Date(ts);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()}`;
}

/**
 * /resume with no argument — emit a structured list of saved sessions.
 * Returns 'continue'; no navigation occurs.
 */
export async function handleWebResumeList(ctx: SlashContext): Promise<'continue'> {
  const currentCwd = ctx.stats.cwd ?? process.cwd();
  const all = listSessions();
  if (all.length === 0) {
    ctx.out.info('No saved sessions. Start a session — it autosaves each turn.');
    return 'continue';
  }
  const local = all.filter((e) => e.cwd === currentCwd);
  const entries = local.length > 0 ? local : all;
  const title = local.length > 0
    ? `Saved sessions (${entries.length}) — this directory`
    : `Saved sessions (${entries.length}) — all directories`;

  writeList(
    ctx.out,
    {
      title,
      items: entries.slice(0, 50).map((e) => ({
        text: e.name ?? e.id,
        description: `${fmtWhen(e.savedAt)} · ${e.model} · ${e.totalTurns} turn${e.totalTurns === 1 ? '' : 's'} · ${formatCost(e.totalCostUsd)}`,
      })),
    },
    () => {
      ctx.out.line(title);
      for (const e of entries.slice(0, 50)) {
        ctx.out.line(`  ${(e.name ?? e.id).padEnd(32)}  ${fmtWhen(e.savedAt).padEnd(9)}  ${e.model}`);
      }
    },
  );
  ctx.out.line();
  ctx.out.info('Use /resume <name-or-id> to resume a session.');
  return 'continue';
}

/**
 * /resume <id-or-name> — create a new owned session resumed from the stored
 * sidecar and return a navigate control pointing at it.
 */
export async function handleWebResumeTarget(
  owner: SessionOwner,
  _sessionId: string,
  ctx: SlashContext,
  target: string,
): Promise<CommandControl | 'continue'> {
  const found = findSession(target);
  if (!found) {
    ctx.out.warn(`No saved session: ${target}`);
    return 'continue';
  }

  // Guard: resuming the live session would tear it down and lose unsaved turns.
  const currentSdkId = ctx.session.current.sessionId;
  const targetSdkId = found.data.sessionId;
  const isSame =
    (currentSdkId !== undefined && targetSdkId !== undefined && currentSdkId === targetSdkId) ||
    (currentSdkId !== undefined && currentSdkId === found.id);
  if (isSame) {
    ctx.out.warn(`Already on session ${found.data.name ?? found.id}.`);
    return 'continue';
  }

  const label = found.data.name ?? found.id;
  if (await isLiveElsewhere(found)) {
    ctx.out.warn(`${label} is running in another process. Continue it there, or end it first.`);
    return 'continue';
  }
  ctx.out.info(`Resuming session ${label} …`);

  try {
    const model = String(found.data.model ?? ctx.stats.model);
    const newInfo = await resumeStoredSession(owner, found, {
      model,
      cwd: found.data.cwd ?? ctx.stats.cwd ?? process.cwd(),
    });
    ctx.out.success(`Resumed ${label}  (new session id: ${newInfo.id})`);

    // Emit key-value summary of the resumed session.
    writeKeyValue(
      ctx.out,
      {
        entries: [
          { key: 'session', value: label },
          { key: 'model', value: model },
          { key: 'turns', value: String(found.data.totalTurns) },
          { key: 'cost', value: formatCost(found.data.totalCostUsd) },
        ],
      },
      () => {
        ctx.out.line(`  session  ${label}`);
        ctx.out.line(`  model    ${model}`);
        ctx.out.line(`  turns    ${found.data.totalTurns}`);
      },
    );

    return { kind: 'navigate', sessionId: newInfo.id };
  } catch (err) {
    console.error('[web /resume] failed:', err);
    ctx.out.error('Failed to resume session.');
    return 'continue';
  }
}

/** A stored session as returned by `findSession`. */
type StoredSession = NonNullable<ReturnType<typeof findSession>>;

/**
 * Create a new owned session resumed from a stored sidecar.
 *
 * Contract: shared by `/resume <id>` (inside a command turn) and the
 * dedicated `POST /api/sessions/:id/resume` route (no carrier session).
 * It never reserves a turn itself: the new session is not live until this
 * returns, so there is no concurrent turn to admit against.
 */
export async function resumeStoredSession(
  owner: SessionOwner,
  found: StoredSession,
  fallback: { model?: string; cwd?: string } = {},
): Promise<{ id: string }> {
  const resumeConfig = resumeConfigFor({
    id: found.id,
    resumeId: found.data.sessionId ?? found.id,
    stored: found.data,
  });
  const model = found.data.model !== undefined ? String(found.data.model) : fallback.model;
  const cwd = found.data.cwd ?? fallback.cwd;
  const request: { model?: string; cwd?: string } = {};
  if (model !== undefined) request.model = model;
  if (cwd !== undefined) request.cwd = cwd;
  const info = await owner.create(request, resumeConfig);
  reseedOwnedStats(info.id, found.data, found.data.sessionId ?? found.id);
  return info;
}

/**
 * Contract: a web session created from a stored sidecar (resume or fork)
 * starts with the stored turns, cost and name, exactly as the REPL does on
 * resume (reseedStatsFromStored). Without it the session reports 0 turns, so
 * `/cost` shows $0 and `/fork` refuses with "nothing to fork yet".
 */
function reseedOwnedStats(id: string, stored: StoredSidecar, resumeId: string): void {
  const stats = getStats(id);
  if (stats) reseedStatsFromStored(stats, stored, resumeId);
}

/**
 * True when some live process (REPL, Telegram, daemon, another `afk web`)
 * currently holds this stored session.
 *
 * Invariant: resuming a session that is live elsewhere starts a second
 * writer on the same journal and sidecar, so both resume paths refuse it.
 * Fails closed: if presence cannot be read we cannot rule out a live
 * writer, so the answer is "live".
 */
export async function isLiveElsewhere(found: StoredSession): Promise<boolean> {
  const ids = new Set<string>([found.id]);
  if (found.data.sessionId !== undefined) ids.add(found.data.sessionId);
  try {
    const live = await readLivePresenceFiles();
    return live.some((r) => ids.has(r.sessionId));
  } catch {
    return true;
  }
}

export type ResumeByIdResult =
  | { kind: 'resumed'; id: string }
  | { kind: 'not-found' }
  | { kind: 'live-elsewhere' };

/** Resume by id or name for the route. */
export async function resumeStoredSessionById(
  owner: SessionOwner,
  target: string,
): Promise<ResumeByIdResult> {
  const found = findSession(target);
  if (!found) return { kind: 'not-found' };
  if (await isLiveElsewhere(found)) return { kind: 'live-elsewhere' };
  const info = await resumeStoredSession(owner, found);
  return { kind: 'resumed', id: info.id };
}

// ---------------------------------------------------------------------------
// /fork
// ---------------------------------------------------------------------------

/**
 * /fork — duplicate the current session into a new owned session and return
 * a navigate control pointing at the fork.
 *
 * Reuses forkStoredSession (the same helper the REPL uses) so sidecar
 * semantics are identical. The tab-spawn and clipboard paths from the REPL
 * are replaced by the navigate control: the dashboard selects the fork.
 */
export async function handleWebFork(
  owner: SessionOwner,
  _sessionId: string,
  ctx: SlashContext,
): Promise<CommandControl | 'continue'> {
  if (ctx.stats.totalTurns === 0) {
    ctx.out.warn('Nothing to fork yet — no turns in this session.');
    return 'continue';
  }

  let forkId: string;
  let forkPath: string;
  try {
    ({ id: forkId, path: forkPath } = forkStoredSession(ctx.stats));
  } catch (err) {
    ctx.out.error(`Could not fork: ${err instanceof Error ? err.message : String(err)}`);
    return 'continue';
  }

  // Best-effort journal copy (same as REPL). The journal belongs to the
  // CURRENT provider conversation: after /clear, stats.sessionId is reset to
  // the stable browser id, whose journal holds the cleared history.
  const journalSource = ctx.session.current.sessionId ?? ctx.stats.sessionId;
  if (journalSource) {
    try { await ctx.session.current.messageJournal?.flush(); } catch { /* best-effort */ }
    if (forkJournal(journalSource, forkId)) {
      // NOTE (#4454): `forkedFrom` here is `journalSource` — the provider SDK
      // session id (ctx.session.current.sessionId), which diverges from
      // `ctx.stats.sessionId` (the stable browser id) after /clear. The CLI
      // sidecar store (forkStored.forkedFrom below) uses ctx.stats.sessionId
      // instead. These two ids are each internally consistent within their own
      // store (journal vs. sidecar), but cross-store joins (e.g. sweep-dirs
      // reading forkedFrom from the sidecar and matching it against journal
      // parent ids) will silently mismatch after a /clear. A proper fix
      // requires unifying the id space across stores; tracked in #4454.
      seedForkLedger(forkId, { model: String(ctx.stats.model), ...(ctx.stats.cwd ? { cwd: ctx.stats.cwd } : {}), forkedFrom: journalSource });
    }
  }

  ctx.out.success(`Forked  ${forkPath}`);

  const model = String(ctx.stats.model);
  const cwd = ctx.stats.cwd ?? process.cwd();

  // Build a resume config from the fork sidecar so the new session starts
  // with the forked conversation history.
  const forkStored: StoredSidecar = {
      sessionId: forkId,
      model,
      startedAt: ctx.stats.sessionStartTime,
      savedAt: Date.now(),
      totalTurns: ctx.stats.totalTurns,
      totalCostUsd: ctx.stats.totalCostUsd,
      totalTokens: ctx.stats.totalTokens,
      totalDurationMs: ctx.stats.totalDurationMs,
      turns: [...ctx.stats.turns],
      forkedFrom: ctx.stats.sessionId,
      forkedAt: Date.now(),
      cwd,
      source: 'web',
  };
  const resumeConfig = resumeConfigFor({ id: forkId, resumeId: forkId, stored: forkStored });

  try {
    const newInfo = await owner.create({ model, cwd }, resumeConfig);
    reseedOwnedStats(newInfo.id, forkStored, forkId);
    ctx.out.info('This session continues here, untouched. The fork carries the conversation only.');
    return { kind: 'navigate', sessionId: newInfo.id };
  } catch (err) {
    console.error('[web /fork] failed:', err);
    ctx.out.error('Fork created but could not start new session.');
    // The sidecar fork exists — user can /resume it manually.
    ctx.out.info(`Resume the fork with: /resume ${forkId}`);
    return 'continue';
  }
}
