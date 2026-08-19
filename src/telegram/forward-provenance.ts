/**
 * System-trusted forward-provenance marker for inbound Telegram messages.
 *
 * Invariant: when a user forwards an external message to the bot, Telegram
 * delivers it with `forward_origin` (Bot API 7.0+) or the legacy
 * `forward_from` / `forward_from_chat` / `forward_sender_name` fields. Without
 * provenance annotation the model cannot distinguish forwarded (untrusted,
 * third-party) content from text the user typed directly — a prompt-injection
 * risk where an adversary crafts a message, convinces a legitimate user to
 * forward it, and the model acts on it as if the user authored it.
 *
 * This module detects forwarded messages and prepends
 * `[forwarded from <origin>] ` so the model always knows the content is
 * third-party and should be treated as untrusted.
 *
 * Trust / injection note: all display-name fields are USER-CONTROLLED (a
 * channel title, a user's first_name, a sender_user_name) and are therefore
 * prompt-injection vectors. Every identity field is passed through
 * {@link sanitizeField} (drops `[ ] @ ( )`, maps control chars to space,
 * collapses whitespace, length-caps at 64 code points) so a crafted origin
 * label can never forge or break out of the `[forwarded from …]` marker.
 *
 * Residual (documented, not yet closed): a user can still type bracket text
 * in the message BODY. Fully closing that needs a structured system channel —
 * mirrors the existing posture in sender-attribution.ts and reply-context.ts.
 *
 * @module telegram/forward-provenance
 */

import { sanitizeField } from './sender-attribution.js';
import type { MessageOriginUser, MessageOriginHiddenUser, MessageOriginChat, MessageOriginChannel } from 'telegraf/types';

/**
 * Minimal structural view of the forward_origin variants (Bot API 7.0+).
 * Typed as a discriminated union by `type` so exhaustive narrowing is possible.
 */
export type ForwardOrigin =
  | MessageOriginUser
  | MessageOriginHiddenUser
  | MessageOriginChat
  | MessageOriginChannel;

/**
 * Minimal view of the legacy forward fields (Bot API < 7.0 and still present
 * in many clients for compatibility).
 */
export interface LegacyForwardFields {
  forward_from?: { first_name?: string; last_name?: string; username?: string };
  forward_from_chat?: { title?: string; username?: string };
  forward_sender_name?: string;
}

/** Combined forward metadata supported by this module. */
export interface ForwardMetadata {
  forward_origin?: ForwardOrigin;
  forward_from?: LegacyForwardFields['forward_from'];
  forward_from_chat?: LegacyForwardFields['forward_from_chat'];
  forward_sender_name?: string;
}

/**
 * Derive a sanitized human-readable label for the forward origin from a
 * `MessageOriginUser` (Bot API 7.0+: known user).
 *
 * Returns `''` when nothing identifying survives sanitization.
 */
function labelFromOriginUser(origin: MessageOriginUser): string {
  const { first_name = '', last_name = '', username } = origin.sender_user;
  const name = sanitizeField(`${first_name} ${last_name}`.trim());
  const handle = username ? sanitizeField(username) : '';
  const parts = [name, handle ? `@${handle}` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * Derive a sanitized label from a `MessageOriginHiddenUser` (Bot API 7.0+:
 * user chose to hide their identity — name known but id is absent).
 */
function labelFromOriginHiddenUser(origin: MessageOriginHiddenUser): string {
  return sanitizeField(origin.sender_user_name);
}

/**
 * Derive a sanitized label from a `MessageOriginChat` (Bot API 7.0+: sent on
 * behalf of a chat, e.g. anonymous group admin).
 */
function labelFromOriginChat(origin: MessageOriginChat): string {
  // sender_chat is a discriminated-union Chat type. In practice MessageOriginChat is always
  // a group/supergroup (never private), so title and username are semantically present.
  // Cast to the common titled-chat shape rather than exhaustively narrowing all variants.
  const chat = origin.sender_chat as { title?: string; username?: string };
  const title = sanitizeField(chat.title ?? '');
  const handle = chat.username ? sanitizeField(chat.username) : '';
  const parts = [title, handle ? `@${handle}` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * Derive a sanitized label from a `MessageOriginChannel` (Bot API 7.0+:
 * originally posted to a channel).
 */
function labelFromOriginChannel(origin: MessageOriginChannel): string {
  // chat is a discriminated-union Chat type; MessageOriginChannel is always a channel chat.
  const chat = origin.chat as { title?: string; username?: string };
  const title = sanitizeField(chat.title ?? '');
  const handle = chat.username ? sanitizeField(chat.username) : '';
  const parts = [title, handle ? `@${handle}` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * Derive a sanitized label from the legacy `forward_from` field (a known
 * forwarding user, present before Bot API 7.0 or when privacy allows it).
 */
function labelFromLegacyFrom(from: NonNullable<LegacyForwardFields['forward_from']>): string {
  const name = sanitizeField(`${from.first_name ?? ''} ${from.last_name ?? ''}`.trim());
  const handle = from.username ? sanitizeField(from.username) : '';
  const parts = [name, handle ? `@${handle}` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * Build a system-trusted `[forwarded from <origin>] ` marker for a message
 * that contains forward metadata.
 *
 * Detection order:
 *   1. `forward_origin` (Bot API 7.0+, discriminated by `type`): user /
 *      hidden_user / chat / channel.
 *   2. Legacy `forward_from` (known user, privacy-dependent).
 *   3. Legacy `forward_from_chat` (chat/channel title).
 *   4. Legacy `forward_sender_name` (hidden-user name-only).
 *
 * Returns `''` (byte-identical passthrough) when the message is not a forward
 * or when nothing identifying survives sanitization — the primary session flow
 * stays unchanged for non-forwarded messages. Ready to prepend to the message
 * text or caption (ends with a trailing space).
 */
export function forwardProvenancePrefix(meta: ForwardMetadata): string {
  let label = '';

  if (meta.forward_origin) {
    const origin = meta.forward_origin;
    if (origin.type === 'user') {
      label = labelFromOriginUser(origin);
    } else if (origin.type === 'hidden_user') {
      label = labelFromOriginHiddenUser(origin);
    } else if (origin.type === 'chat') {
      label = labelFromOriginChat(origin);
    } else if (origin.type === 'channel') {
      label = labelFromOriginChannel(origin);
    } else {
      // Unknown future origin type: fall through to legacy fields below.
      // Warn so Bot API drift surfaces in logs rather than silently producing a blank marker.
      console.warn(`[forward-provenance] unknown forward_origin.type "${(origin as { type: string }).type}" — Bot API may have added a new origin type`);
    }
  }

  // Legacy fallback (also covers clients that still send both sets of fields).
  if (!label && meta.forward_from) {
    label = labelFromLegacyFrom(meta.forward_from);
  }
  if (!label && meta.forward_from_chat) {
    const fc = meta.forward_from_chat;
    const title = sanitizeField(fc.title ?? '');
    const handle = fc.username ? sanitizeField(fc.username) : '';
    label = [title, handle ? `@${handle}` : ''].filter(Boolean).join(' ');
  }
  if (!label && meta.forward_sender_name) {
    label = sanitizeField(meta.forward_sender_name);
  }

  if (!label) return '';
  return `[forwarded from ${label}] `;
}
