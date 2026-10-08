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

/** Maximum length of the raw `AFK_PEER_INBOUND` value echoed in diagnostics. */
export const RAW_VALUE_CAP = 20;

/**
 * Structured result from {@link getPeerInboundModeConfig}.
 *
 * Callers that only need the resolved mode should prefer
 * {@link resolvePeerInboundMode}. Use this struct when you also need to
 * surface a warning about an invalid raw value (e.g. in `/inbox` header).
 */
export interface PeerInboundModeConfig {
  /** Resolved mode (always a valid `PeerInboundMode`). */
  mode: PeerInboundMode;
  /**
   * Whether the raw `AFK_PEER_INBOUND` value was set but unrecognised.
   * When `true`, `rawTruncated` contains the (capped) raw value for display.
   */
  invalid: boolean;
  /**
   * The raw `AFK_PEER_INBOUND` value truncated to {@link RAW_VALUE_CAP}
   * characters. `undefined` when the env var was absent or valid.
   */
  rawTruncated?: string;
}

/**
 * Resolve the current peer inbound mode from `AFK_PEER_INBOUND`.
 * Invalid or absent values default to `'accept'`. A one-time `debugLog`
 * warning is emitted when an unrecognised value is detected.
 */
export function resolvePeerInboundMode(): PeerInboundMode {
  return getPeerInboundModeConfig().mode;
}

/**
 * Like {@link resolvePeerInboundMode} but also returns structured information
 * about whether the raw `AFK_PEER_INBOUND` value was invalid, so callers
 * (e.g. `/inbox` list) can surface a TUI-safe warning without re-reading the
 * env themselves.
 *
 * The raw value is capped at {@link RAW_VALUE_CAP} characters to prevent an
 * arbitrarily long env value from disrupting the display.
 */
export function getPeerInboundModeConfig(): PeerInboundModeConfig {
  const raw = env.AFK_PEER_INBOUND;
  if (raw !== undefined && VALID_MODES.has(raw.trim().toLowerCase())) {
    return { mode: raw.trim().toLowerCase() as PeerInboundMode, invalid: false };
  }
  if (raw !== undefined && raw !== warnedValue) {
    warnedValue = raw;
    debugLog(
      `[afk] Invalid AFK_PEER_INBOUND=${JSON.stringify(raw)}; ` +
        `expected 'accept', 'hold', or 'off'. Falling back to 'accept'.`,
    );
  }
  const rawTruncated =
    raw !== undefined
      ? raw.length > RAW_VALUE_CAP
        ? raw.slice(0, RAW_VALUE_CAP) + '…'
        : raw
      : undefined;
  return { mode: 'accept', invalid: raw !== undefined, rawTruncated };
}
