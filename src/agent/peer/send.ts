/**
 * High-level send API for peer messaging.
 *
 * Resolves the `to` field against live presence records (exact sessionId,
 * unique ≥6-char prefix, or exact session name), enforces sender-side
 * guards (size, hop limit, rate, duplicate), then writes the envelope to
 * the target's inbox.
 *
 * Resolution rules:
 *   - Exact sessionId match → accepted.
 *   - Unique prefix (≥6 chars) match → accepted; ambiguous → refused.
 *   - Exact `name` field match among live sessions → accepted; ambiguous → refused.
 *   - No match → refused with `'unknown-target'`.
 *   - Self → refused with `'self'`.
 *
 * @module agent/peer/send
 */

import { randomUUID } from 'crypto';
import { readLivePresenceFiles } from '../awareness/presence.js';
import { writeEnvelope } from './inbox-store.js';
import { checkSendGuards } from './guards.js';
import { type PeerEnvelope, PEER_MAX_HOPS } from './envelope.js';
import type { SendResult } from './inbox-store.js';
import type { PresenceRecord } from '../awareness/presence.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for `sendToSession`. */
export interface SendInput {
  from: { id: string; name?: string };
  to: string;
  message: string;
  replyTo?: string;
  hop?: number;
}

/** Extended result including target state and resolved id. */
export type SendToSessionResult = SendResult & {
  targetState?: string;
  resolvedTo?: string;
};

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `to` against a list of live presence records.
 * Returns the matched record or a refusal reason.
 */
function resolveTarget(
  to: string,
  records: PresenceRecord[],
  selfId: string,
): PresenceRecord | 'self' | 'unknown-target' | 'ambiguous-target' | 'dead-target' {
  // 1. Exact sessionId match.
  const exactId = records.find((r) => r.sessionId === to);
  if (exactId) {
    if (exactId.sessionId === selfId) return 'self';
    return exactId;
  }

  // 2. Unique sessionId prefix (≥6 chars).
  if (to.length >= 6) {
    const prefixMatches = records.filter((r) => r.sessionId.startsWith(to));
    if (prefixMatches.length === 1) {
      const m = prefixMatches[0]!;
      if (m.sessionId === selfId) return 'self';
      return m;
    }
    if (prefixMatches.length > 1) return 'ambiguous-target';
  }

  // 3. Exact session name match.
  const nameMatches = records.filter((r) => r.name !== undefined && r.name === to);
  if (nameMatches.length === 1) {
    const m = nameMatches[0]!;
    if (m.sessionId === selfId) return 'self';
    return m;
  }
  if (nameMatches.length > 1) return 'ambiguous-target';

  return 'unknown-target';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a message to another live afk session. Resolves the target, applies
 * sender-side guards, and writes the envelope to the target's inbox.
 *
 * The `hop` field increments through a reply chain. The caller should look up
 * the replied-to envelope's hop count (via `findDeliveredEnvelope`) and pass
 * `hop = (incomingHop) + 1`. When no hop is specified the default is 0.
 */
/**
 * What a sender should expect: `blocked` (waiting on its human), `busy`
 * (mid-turn: delivery at its next turn), `idle` (wakes immediately), or
 * `unknown` (no turnState recorded yet).
 */
export function describeTargetState(target: PresenceRecord): 'blocked' | 'busy' | 'idle' | 'unknown' {
  if (target.blockedSince !== undefined) return 'blocked';
  return target.turnState ?? 'unknown';
}

export async function sendToSession(input: SendInput): Promise<SendToSessionResult> {
  const { from, to, message, replyTo, hop = 0 } = input;

  // Load live sessions for resolution.
  const records = await readLivePresenceFiles();

  // Check if sending to self before any other check.
  if (to === from.id) {
    return { status: 'refused', reason: 'self', detail: 'Cannot send a message to yourself.' };
  }

  const resolved = resolveTarget(to, records, from.id);

  if (resolved === 'self') {
    return { status: 'refused', reason: 'self', detail: 'Cannot send a message to yourself.' };
  }
  if (resolved === 'unknown-target') {
    return { status: 'refused', reason: 'unknown-target', detail: `No live session matches "${to}".` };
  }
  if (resolved === 'ambiguous-target') {
    return { status: 'refused', reason: 'ambiguous-target', detail: `"${to}" matches multiple live sessions — use a full session id.` };
  }
  if (resolved === 'dead-target') {
    return { status: 'refused', reason: 'dead-target', detail: `Session "${to}" exists but is not alive.` };
  }

  const target = resolved;
  const targetState = describeTargetState(target);

  if (target.peerInbox !== true) {
    return {
      status: 'refused',
      reason: 'no-receiver',
      detail: `Session "${to}" is not reading peer messages (only interactive REPL sessions receive in v1, after their first turn).`,
      resolvedTo: target.sessionId,
      targetState,
    };
  }

  if (hop > PEER_MAX_HOPS) {
    return {
      status: 'refused',
      reason: 'hop-limit',
      detail: `Hop limit (${PEER_MAX_HOPS}) exceeded.`,
      resolvedTo: target.sessionId,
      targetState,
    };
  }

  const guardRefusal = await checkSendGuards({
    senderId: from.id,
    targetId: target.sessionId,
    body: message,
    hop,
  });
  if (guardRefusal !== null) {
    return {
      status: 'refused',
      reason: guardRefusal,
      detail: `Message refused: ${guardRefusal}.`,
      resolvedTo: target.sessionId,
      targetState,
    };
  }

  const messageId = randomUUID();
  const ts = new Date().toISOString();

  const envelope: PeerEnvelope = {
    v: 1,
    messageId,
    from,
    to: target.sessionId,
    ...(replyTo !== undefined ? { replyTo } : {}),
    hop,
    ts,
    body: message,
  };

  await writeEnvelope(envelope);

  return {
    status: 'queued',
    messageId,
    resolvedTo: target.sessionId,
    targetState,
  };
}
