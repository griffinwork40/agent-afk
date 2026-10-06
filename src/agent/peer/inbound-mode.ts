/**
 * Peer inbound mode resolver.
 *
 * Reads `AFK_PEER_INBOUND` to determine how incoming peer messages are handled
 * by this session's receiver loop:
 *
 *   - `accept` (default) — messages are delivered to the model immediately
 *     when the REPL is idle, or mid-turn at the next boundary between tool
 *     rounds when busy (next turn if no tool round remains).
 *   - `hold` — messages are written to the `held/` subdirectory and listed
 *     via `/inbox`; the model is NOT woken until the operator releases them.
 *   - `off` — the receiver loop ignores incoming messages entirely; senders
 *     receive a `'inbound-off'` refusal (checked separately, not here).
 *
 * Invalid values fall back to `'accept'` (fail-open: better to deliver than
 * to silently drop messages because of a typo). When an invalid value is set,
 * a one-time warning is emitted via `debugLog` so it is visible under
 * `AFK_DEBUG=1`. Raw `process.stderr.write` is deliberately avoided here:
 * when the REPL input overlay owns the terminal, a raw stderr write would
 * corrupt the display. `debugLog` is the safe surface for this module.
 *
 * @module agent/peer/inbound-mode
 */

import { env } from '../../config/env.js';
import { debugLog } from '../../utils/debug.js';

/** Possible inbound-message handling modes. */
export type PeerInboundMode = 'accept' | 'hold' | 'off';

const VALID_MODES = new Set<string>(['accept', 'hold', 'off']);

// Warn at most once per process for the same invalid value.
let warnedValue: string | undefined;

/**
 * Resolve the current peer inbound mode from `AFK_PEER_INBOUND`.
 * Invalid or absent values default to `'accept'`. A one-time `debugLog`
 * warning is emitted when an unrecognised value is detected.
 */
export function resolvePeerInboundMode(): PeerInboundMode {
  const raw = env.AFK_PEER_INBOUND;
  if (raw !== undefined && VALID_MODES.has(raw.trim().toLowerCase())) {
    return raw.trim().toLowerCase() as PeerInboundMode;
  }
  if (raw !== undefined && raw !== warnedValue) {
    warnedValue = raw;
    debugLog(
      `[afk] Invalid AFK_PEER_INBOUND=${JSON.stringify(raw)}; ` +
        `expected 'accept', 'hold', or 'off'. Falling back to 'accept'.`,
    );
  }
  return 'accept';
}
