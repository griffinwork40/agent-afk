/**
 * Peer inbound mode resolver.
 *
 * Reads `AFK_PEER_INBOUND` to determine how incoming peer messages are handled
 * by this session's receiver loop:
 *
 *   - `accept` (default) — messages are delivered to the model immediately
 *     when the REPL is idle, or at the next turn boundary when busy.
 *   - `hold` — messages are written to the `held/` subdirectory and listed
 *     via `/inbox`; the model is NOT woken until the operator releases them.
 *   - `off` — the receiver loop ignores incoming messages entirely; senders
 *     receive a `'inbound-off'` refusal (checked separately, not here).
 *
 * Invalid values silently fall back to `'accept'` (fail-open: better to
 * deliver than to silently drop messages because of a typo).
 *
 * @module agent/peer/inbound-mode
 */

import { env } from '../../config/env.js';

/** Possible inbound-message handling modes. */
export type PeerInboundMode = 'accept' | 'hold' | 'off';

const VALID_MODES = new Set<string>(['accept', 'hold', 'off']);

/**
 * Resolve the current peer inbound mode from `AFK_PEER_INBOUND`.
 * Invalid or absent values default to `'accept'`.
 */
export function resolvePeerInboundMode(): PeerInboundMode {
  const raw = env.AFK_PEER_INBOUND;
  if (raw !== undefined && VALID_MODES.has(raw.trim().toLowerCase())) {
    return raw.trim().toLowerCase() as PeerInboundMode;
  }
  return 'accept';
}
