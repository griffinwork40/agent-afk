/**
 * Peer-messaging extensions to the presence layer: the optional `name`,
 * `turnState`/`turnStateSince`, and `peerInbox` fields on
 * {@link PresenceFileInfo}, plus a best-effort tmux label probe.
 *
 * Invariant: every mutator routes through `patchPresenceFile`, i.e. through
 * presence.ts's single per-session write queue. A private queue here would let
 * a `turnState` write and a concurrent heartbeat / `/afk` / `blockedSince`
 * write both read the pre-mutation record and silently drop one another.
 * All helpers are best-effort and never throw: presence is non-critical.
 *
 * @module agent/awareness/presence.peer
 */

import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { env } from '../../config/env.js';
import { patchPresenceFile } from './presence.js';

const execFile = promisify(_execFile);

/** Longest accepted session name; longer input is truncated. */
export const PRESENCE_NAME_MAX = 64;

/** Normalize an operator-supplied label: single line, trimmed, bounded. */
export function normalizePresenceName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, PRESENCE_NAME_MAX);
  return name.length > 0 ? name : undefined;
}

/** Set (or, with `undefined`, clear) this session's human-readable name. */
export async function setPresenceName(sessionId: string, name: string | undefined): Promise<void> {
  const normalized = name === undefined ? undefined : normalizePresenceName(name);
  return patchPresenceFile(sessionId, (rec) => {
    if (normalized !== undefined) rec.name = normalized;
    else delete rec.name;
  });
}

/** Set `name` only when the record has none (auto-naming never overrides `/name`). */
export async function setPresenceNameIfUnset(sessionId: string, name: string): Promise<void> {
  const normalized = normalizePresenceName(name);
  if (normalized === undefined) return;
  return patchPresenceFile(sessionId, (rec) => {
    if (rec.name === undefined) rec.name = normalized;
  });
}

/** Record whether the session is idle, mid-turn, or waiting on a human. */
export async function setPresenceTurnState(
  sessionId: string,
  state: 'idle' | 'busy' | 'blocked',
): Promise<void> {
  return patchPresenceFile(sessionId, (rec) => {
    rec.turnState = state;
    rec.turnStateSince = new Date().toISOString();
  });
}

/** Advertise (or withdraw) that this session reads its peer inbox. */
export async function setPresencePeerInbox(sessionId: string, enabled: boolean): Promise<void> {
  return patchPresenceFile(sessionId, (rec) => {
    if (enabled) rec.peerInbox = true;
    else delete rec.peerInbox;
  });
}

/**
 * The tmux `session:window` label (e.g. `research:5`) of this process's pane,
 * or `undefined` outside tmux / on any error. Uses `execFile` on the binary
 * name (no shell; posix-guard R1) with a 1s timeout.
 */
export async function resolveTmuxLabel(): Promise<string | undefined> {
  if (!env.TMUX) return undefined;
  const target = env.TMUX_PANE ? ['-t', env.TMUX_PANE] : [];
  try {
    const { stdout } = await execFile('tmux', ['display-message', '-p', ...target, '#S:#I'], {
      timeout: 1000,
    });
    const label = stdout.trim();
    return label.length > 0 ? label : undefined;
  } catch {
    return undefined;
  }
}
