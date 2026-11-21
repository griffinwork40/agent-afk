/**
 * Plain-language explanations for failed chat actions, shown as local system
 * lines inside the global chat view.
 *
 * @module cli/commands/interactive/global-chat-messages
 */

import type { ChatActionResult, ChatPostResult, IdentityResult } from '../../../global-chat/client-types.js';
import { MAX_LINKS, MAX_TEXT_CHARS } from '../../../global-chat/protocol.js';

const SECRET_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'an Anthropic API key', openai: 'an OpenAI API key', github: 'a GitHub token',
  slack: 'a Slack token', aws: 'an AWS access key', google: 'a Google API key', stripe: 'a Stripe key',
  npm: 'an npm token', telegram: 'a Telegram bot token', private_key: 'a private key',
  jwt: 'a JWT', bearer: 'a Bearer token',
};

export function formatWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

type Failure = Extract<ChatActionResult, { ok: false }> | Extract<ChatPostResult, { ok: false }>;

export function explainFailure(result: Failure, verb = 'Message'): string {
  switch (result.code) {
    case 'rate_limited':
      return result.retryAfterMs !== undefined
        ? `Slow down: you can post again in ${formatWait(result.retryAfterMs)}.`
        : 'Slow down: you are posting too fast. Try again shortly.';
    case 'too_long': return `${verb} is too long (limit ${MAX_TEXT_CHARS} characters).`;
    case 'too_many_links': return `${verb} has too many links (limit ${MAX_LINKS}).`;
    case 'secret_detected': {
      const spans = 'spans' in result ? result.spans : [];
      const kinds = [...new Set(spans.map((s) => SECRET_LABELS[s.kind] ?? 'a credential'))];
      return kinds.length > 0
        ? `Not sent: it looks like it contains ${kinds.join(', ')}. Remove it and try again.`
        : 'Not sent: the relay thinks it contains a credential. Remove it and try again.';
    }
    case 'readonly': return 'The room is read-only right now. Nothing was sent.';
    case 'closed': return 'The room is closed right now. Nothing was sent.';
    case 'banned': return 'You are banned from this room.';
    case 'not_connected': return 'Not connected to the relay. Nothing was sent; try again when connected.';
    case 'timeout': return 'The relay did not answer in time. It may not have been sent; check before retrying.';
    case 'forbidden': return 'That command is for maintainers only.';
    case 'unknown_target': return 'That message no longer exists on the relay.';
    case 'duplicate': return 'The relay already has that message.';
    case 'stale_timestamp': return 'Your clock looks wrong, so the relay refused this. Check your system time.';
    default: return `${verb} failed (${result.code}).`;
  }
}

export function explainIdentityFailure(result: Extract<IdentityResult, { ok: false }>): string {
  switch (result.code) {
    case 'bad_name': return 'Use 2 to 16 characters: lowercase letters, digits, _ or -.';
    case 'reserved_name': return 'That name is reserved. Pick another.';
    case 'name_change_too_soon':
      return result.retryAfterMs !== undefined
        ? `You can change your name once a day. Try again in ${formatWait(result.retryAfterMs)}.`
        : 'You can change your name once a day. Try again later.';
    case 'not_created': return 'You have no chat identity yet. Run /global to set one up.';
    case 'already_exists': return 'An identity already exists.';
  }
}
