/**
 * Peer-message envelope: schema, parser, and renderer.
 *
 * Defines the wire format for messages exchanged between afk peer sessions via
 * the filesystem mailbox. The renderer emits a `<peer-session-message>` XML
 * block whose attribute values AND body content are fully XML-escaped so a
 * forged closing tag inside the body cannot break the wrapper framing.
 *
 * Contract:
 *   - `parseEnvelope` never throws; returns null on any shape/version mismatch.
 *   - `renderPeerMessageBlock` escapes all dynamic content via the shared
 *     {@link escapeXml} helper from `xml-escape.ts` (five replacements: & < > " ').
 *   - Body size is NOT re-validated here — {@link PEER_MAX_BODY_BYTES} is the
 *     sender-side gate enforced in guards.ts and send.ts.
 *
 * @module agent/peer/envelope
 */

/** Current envelope schema version. */
export const PEER_ENVELOPE_VERSION = 1;

/** Maximum body size in bytes. Enforced by the sender before writing. */
export const PEER_MAX_BODY_BYTES = 64 * 1024;

/** Maximum number of hops a message may transit. Prevents ping-pong storms. */
export const PEER_MAX_HOPS = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Wire format for a single peer message, as persisted in the inbox JSON. */
export interface PeerEnvelope {
  /** Schema version — always 1 for current envelopes. */
  v: 1;
  /** Stable UUID identifying this message (used for duplicate detection). */
  messageId: string;
  /** Originating session. */
  from: { id: string; name?: string };
  /** Destination session id. */
  to: string;
  /** messageId of the envelope being replied to, if any. */
  replyTo?: string;
  /** Number of hops this message has traveled (0 = first send). */
  hop: number;
  /** ISO 8601 send timestamp. */
  ts: string;
  /** Message body text. */
  body: string;
}

import { escapeXml } from './xml-escape.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a {@link PeerEnvelope}, validating all
 * required fields and the version discriminant. Returns `null` on any
 * parse or shape error — never throws.
 *
 * Validation rules:
 *   - `v` must be exactly 1.
 *   - `messageId`, `from.id`, `to`, `ts`, `body` must be non-empty strings.
 *   - `hop` must be a non-negative integer.
 *   - `replyTo`, `from.name` are optional strings (omitted or undefined ok).
 *   - Unknown extra fields are silently ignored (forward compat).
 */
export function parseEnvelope(raw: string): PeerEnvelope | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj['v'] !== 1) return null;
    const messageId = obj['messageId'];
    const to = obj['to'];
    const ts = obj['ts'];
    const body = obj['body'];
    const hop = obj['hop'];
    const fromRaw = obj['from'];

    if (
      typeof messageId !== 'string' || messageId.length === 0 ||
      typeof to !== 'string' || to.length === 0 ||
      typeof ts !== 'string' || ts.length === 0 ||
      typeof body !== 'string' ||
      typeof hop !== 'number' || !Number.isInteger(hop) || hop < 0 ||
      typeof fromRaw !== 'object' || fromRaw === null
    ) {
      return null;
    }

    const from = fromRaw as Record<string, unknown>;
    if (typeof from['id'] !== 'string' || from['id'].length === 0) return null;

    const replyToRaw = obj['replyTo'];
    const replyTo =
      replyToRaw === undefined || replyToRaw === null
        ? undefined
        : typeof replyToRaw === 'string'
          ? replyToRaw
          : null;
    if (replyTo === null) return null;

    const namRaw = from['name'];
    const name =
      namRaw === undefined || namRaw === null
        ? undefined
        : typeof namRaw === 'string'
          ? namRaw
          : null;
    if (name === null) return null;

    return {
      v: 1,
      messageId,
      from: { id: from['id'] as string, ...(name !== undefined ? { name } : {}) },
      to,
      ...(replyTo !== undefined ? { replyTo } : {}),
      hop,
      ts,
      body,
    };
  } catch {
    return null;
  }
}

/**
 * Render a {@link PeerEnvelope} as a model-context XML block.
 *
 * Output format:
 * ```
 * <peer-session-message from="<id>" name="<name>" id="<messageId>" reply_to="<replyTo>" hop="N">
 * <escaped body>
 * </peer-session-message>
 * ```
 *
 * All attribute values and the body are XML-escaped with the same five
 * replacements (& < > " ') so a forged `</peer-session-message>` inside
 * the body cannot close the outer wrapper. The `name` and `reply_to`
 * attributes are omitted entirely when absent.
 */
export function renderPeerMessageBlock(env: PeerEnvelope): string {
  const fromAttr = `from="${escapeXml(env.from.id)}"`;
  const nameAttr = env.from.name !== undefined ? ` name="${escapeXml(env.from.name)}"` : '';
  const idAttr = `id="${escapeXml(env.messageId)}"`;
  const replyToAttr = env.replyTo !== undefined ? ` reply_to="${escapeXml(env.replyTo)}"` : '';
  const hopAttr = `hop="${env.hop}"`;

  const openTag = `<peer-session-message ${fromAttr}${nameAttr} ${idAttr}${replyToAttr} ${hopAttr}>`;
  const escapedBody = escapeXml(env.body);
  return `${openTag}\n${escapedBody}\n</peer-session-message>`;
}
