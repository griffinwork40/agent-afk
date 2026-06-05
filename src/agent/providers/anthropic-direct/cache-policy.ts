/**
 * Prompt-cache policy for the `anthropic-direct` provider.
 *
 * Stamps `cache_control: { type: 'ephemeral', ttl }` breakpoints on the
 * last block of `system` and on the last content block of the last
 * `messages[]` entry. The Anthropic Messages API caches in order
 * `tools` → `system` → `messages`, so a single end-of-system breakpoint
 * implicitly caches the tool schemas too. The end-of-messages breakpoint
 * floats forward each call; cache lookup walks back over prefix-hash
 * matches up to a 20-block window, so the moving marker still hits prior
 * cache writes within a tool-use loop and across consecutive turns.
 *
 * Both helpers are non-mutating. The marker MUST NOT leak into stored
 * history — `query.ts` keeps a single `messages: MessageParam[]` array
 * across turns, and an accumulating set of `cache_control` markers would
 * break prefix-hash matching on subsequent calls.
 *
 * @module agent/providers/anthropic-direct/cache-policy
 */
import type {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources';
import { env } from '../../../config/env.js';

const TTL_DEFAULT: '5m' | '1h' = '1h';

/**
 * Cache is on by default. Disable for the session by setting
 * `AFK_DISABLE_PROMPT_CACHE` to `1` / `true`.
 *
 * When `opts.baseUrl` is a non-empty string the session is running against a
 * local Anthropic-compatible shim, which rarely honors `cache_control` and
 * may 400 on the unknown field. Caching is force-disabled in that mode
 * regardless of the env var.
 */
export function isCacheEnabled(opts?: { baseUrl?: string }): boolean {
  if (typeof opts?.baseUrl === 'string' && opts.baseUrl.length > 0) {
    return false;
  }
  const raw = env.AFK_DISABLE_PROMPT_CACHE;
  if (raw === undefined || raw.length === 0) return true;
  const v = raw.toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes' || v === 'on');
}

/**
 * Default TTL is `'1h'` (matches `agent-afk`'s daemon and Telegram surfaces
 * which often idle past the 5m window). Override with
 * `AFK_PROMPT_CACHE_TTL=5m`. Any other value falls back to the default.
 */
export function getCacheTtl(): '5m' | '1h' {
  const raw = env.AFK_PROMPT_CACHE_TTL;
  if (raw === '5m') return '5m';
  if (raw === '1h') return '1h';
  return TTL_DEFAULT;
}

/**
 * Return a new array where the last block carries
 * `cache_control: { type: 'ephemeral', ttl }`. Returns the input unchanged
 * when the array is empty or when the tail is a thinking block (the SDK
 * does not accept `cache_control` on thinking/redacted_thinking).
 *
 * Caches `tools + system` together when used on the `system` array.
 */
export function withSystemBreakpoint(
  blocks: ContentBlockParam[],
  ttl: '5m' | '1h',
): ContentBlockParam[] {
  if (blocks.length === 0) return blocks;
  const tail = blocks[blocks.length - 1]!;
  const stamped = stampCacheControl(tail, ttl);
  if (stamped === tail) return blocks;
  return [...blocks.slice(0, -1), stamped];
}

/**
 * Return a new array where the last message has its last content block
 * carrying `cache_control: { type: 'ephemeral', ttl }`. Returns the input
 * unchanged when the array is empty.
 *
 * String-content tails are converted to a single text block carrying the
 * marker (the API accepts both string and content-block forms; the marker
 * lives only on blocks).
 *
 * Critically non-mutating: callers in the tool-use loop hold a reference
 * to the canonical messages array, and any leakage of `cache_control`
 * back into stored history would accumulate markers across iterations and
 * break prefix-hash matching.
 */
export function withMessagesBreakpoint(
  messages: MessageParam[],
  ttl: '5m' | '1h',
): MessageParam[] {
  if (messages.length === 0) return messages;
  const tail = messages[messages.length - 1]!;
  const stampedTail = stampLastContent(tail, ttl);
  if (stampedTail === tail) return messages;
  return [...messages.slice(0, -1), stampedTail];
}

function stampLastContent(
  msg: MessageParam,
  ttl: '5m' | '1h',
): MessageParam {
  const content = msg.content;
  if (typeof content === 'string') {
    if (content.length === 0) return msg;
    return {
      ...msg,
      content: [
        {
          type: 'text',
          text: content,
          cache_control: { type: 'ephemeral', ttl },
        },
      ],
    };
  }
  if (!Array.isArray(content) || content.length === 0) return msg;
  const last = content[content.length - 1]!;
  const stamped = stampCacheControl(last, ttl);
  if (stamped === last) return msg;
  return { ...msg, content: [...content.slice(0, -1), stamped] };
}

/**
 * Stamp `cache_control` on a single block. Returns the block unchanged
 * when its type doesn't accept `cache_control` (thinking variants), so
 * callers can swap-or-keep without an extra check.
 */
function stampCacheControl(
  block: ContentBlockParam,
  ttl: '5m' | '1h',
): ContentBlockParam {
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    return block;
  }
  return { ...block, cache_control: { type: 'ephemeral', ttl } };
}
