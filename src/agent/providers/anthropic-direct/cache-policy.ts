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
 * `clampBreakpoints` enforces the Anthropic 4-breakpoint limit across the
 * full request (system + tools + messages). See its doc comment for the
 * removal priority that applies when the assembled params exceed the limit.
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
 * Anthropic's hard limit on `cache_control` breakpoints across the entire
 * request (tools + system + messages combined). Exceeding this causes a 400.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

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
 * Contract: true exactly when a request will carry a `ttl: '1h'` breakpoint,
 * i.e. when the header layer MUST negotiate `extended-cache-ttl-2025-04-11`
 * for that TTL to be honored. Sole authority for that coupling — header
 * assembly (`buildRequestHeaders`) asks this rather than re-deriving the
 * enablement/TTL pair, so "asks for 1h" and "sends the activating beta" can
 * never diverge.
 *
 * Both branches matter:
 *  - cache disabled (local shim via `baseUrl`, or `AFK_DISABLE_PROMPT_CACHE`)
 *    → no breakpoint is stamped, so the beta must NOT be sent (keeps the
 *    local-mode invariant that no `anthropic-beta` reaches a shim).
 *  - `AFK_PROMPT_CACHE_TTL=5m` → the 5m default needs no beta.
 */
export function isExtendedCacheTtlActive(opts?: { baseUrl?: string }): boolean {
  return isCacheEnabled(opts) && getCacheTtl() === '1h';
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

/**
 * True when a content block carries an active `cache_control` breakpoint.
 * The field can be `null` (API-level opt-out) or absent — only a non-null
 * `{ type: 'ephemeral' }` value counts as a breakpoint.
 */
function blockHasBreakpoint(block: { cache_control?: { type: string } | null }): boolean {
  return block.cache_control != null;
}

/** Strip `cache_control` from a single content block (non-mutating). */
function stripBreakpoint(block: ContentBlockParam): ContentBlockParam {
  if (!('cache_control' in block)) return block;
  const { cache_control: _cc, ...rest } = block as ContentBlockParam & { cache_control?: unknown };
  return rest as ContentBlockParam;
}

/**
 * Count `cache_control` breakpoints across the full request payload
 * (system blocks + tool definitions + message content blocks).
 *
 * Exported for unit tests; callers should use `clampBreakpoints` instead.
 */
export function countBreakpoints(params: {
  system?: readonly ContentBlockParam[];
  tools?: readonly CacheableToolLike[];
  messages: readonly MessageParam[];
}): number {
  let count = 0;
  for (const blk of params.system ?? []) {
    // ThinkingBlockParam and redacted_thinking have no cache_control field.
    if (blk.type !== 'thinking' && blk.type !== 'redacted_thinking' && blockHasBreakpoint(blk as { cache_control?: { type: string } | null })) {
      count++;
    }
  }
  for (const tool of params.tools ?? []) {
    if (blockHasBreakpoint(tool)) count++;
  }
  for (const msg of params.messages) {
    const content = msg.content;
    if (typeof content === 'string') continue;
    if (Array.isArray(content)) {
      for (const blk of content) {
        if (typeof blk === 'object' && blk !== null && blockHasBreakpoint(blk as { cache_control?: { type: string } | null })) {
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Minimal shape required of any tool entry passed to `clampBreakpoints`.
 * The function only reads and strips `cache_control`; all other fields are
 * preserved verbatim via the generic `T` parameter, so callers with a
 * concrete tool type (e.g. `WireToolDef`) receive the same type back without
 * a re-cast.
 */
export interface CacheableToolLike {
  name: string;
  cache_control?: { type: string } | null;
}

/**
 * Guard the Anthropic 4-breakpoint limit across the full request (tools +
 * system + messages). If the assembled params would exceed `MAX_CACHE_BREAKPOINTS`,
 * strips the lowest-value breakpoints deterministically — without throwing —
 * so the request always succeeds.
 *
 * **Removal priority** (highest value → kept first, lowest value → dropped first):
 *
 * 1. `messages` end breakpoint — kept last: it floats to the newest context
 *    every turn and drives prefix-hash matching within the tool-use loop.
 * 2. `system` end breakpoint — kept second: implicitly covers all tool schemas
 *    (Anthropic caches tools → system → messages in order).
 * 3. Earlier `system` breakpoints — kept third: stable-prefix blocks reuse the
 *    most tokens across sessions, subagent forks, and date rollovers.
 * 4. `tools` breakpoints — dropped first: already covered by the system end.
 * 5. Earlier `messages` breakpoints — dropped next: older turns are least likely
 *    to produce a prefix-hash hit on subsequent calls.
 *
 * The generic `T` preserves the caller's tool element type so callers with a
 * concrete wire type (e.g. `WireToolDef`) receive `T[]` back and need no
 * re-cast at the call site.
 *
 * Non-mutating: returns the input unchanged when no clamping is needed.
 */
export function clampBreakpoints<T extends CacheableToolLike>(params: {
  system?: readonly ContentBlockParam[];
  tools?: readonly T[];
  messages: readonly MessageParam[];
}): {
  system?: readonly ContentBlockParam[];
  tools?: readonly T[];
  messages: readonly MessageParam[];
} {
  const total = countBreakpoints(params);
  if (total <= MAX_CACHE_BREAKPOINTS) return params;

  let toRemove = total - MAX_CACHE_BREAKPOINTS;

  // Step 1: strip tool breakpoints (lowest value — covered by system end).
  let tools = params.tools;
  if (toRemove > 0 && tools !== undefined) {
    const stripped: T[] = [];
    for (const t of tools) {
      if (toRemove > 0 && blockHasBreakpoint(t)) {
        const { cache_control: _cc, ...rest } = t;
        stripped.push(rest as T);
        toRemove--;
      } else {
        stripped.push(t);
      }
    }
    tools = stripped;
  }

  // Step 2: strip earlier message content breakpoints (keep only the last one).
  let messages = params.messages;
  if (toRemove > 0) {
    // Collect all (msgIdx, blockIdx) pairs that carry a breakpoint, oldest first.
    const msgMarkers: Array<{ msgIdx: number; blockIdx: number }> = [];
    for (let mi = 0; mi < messages.length; mi++) {
      const content = messages[mi]!.content;
      if (!Array.isArray(content)) continue;
      for (let bi = 0; bi < content.length; bi++) {
        const blk = content[bi]!;
        if (typeof blk === 'object' && blk !== null && blockHasBreakpoint(blk as { cache_control?: { type: string } | null })) {
          msgMarkers.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }
    // Protect the LAST breakpoint (end-of-messages) — strip the rest oldest-first.
    const toStrip = msgMarkers.slice(0, Math.min(toRemove, Math.max(0, msgMarkers.length - 1)));
    if (toStrip.length > 0) {
      const msgsCopy = messages.map((m) => ({ ...m }));
      for (const { msgIdx, blockIdx } of toStrip) {
        const content = msgsCopy[msgIdx]!.content;
        if (!Array.isArray(content)) continue;
        const blk = content[blockIdx];
        if (blk === undefined || typeof blk !== 'object' || blk === null) continue;
        const stripped = stripBreakpoint(blk as ContentBlockParam);
        msgsCopy[msgIdx]!.content = [
          ...content.slice(0, blockIdx),
          stripped,
          ...content.slice(blockIdx + 1),
        ] as typeof content;
        toRemove--;
      }
      messages = msgsCopy;
    }
  }

  // Step 3: strip earlier system breakpoints (keep only the last one).
  let system = params.system;
  if (toRemove > 0 && system !== undefined && system.length > 0) {
    // Find all indices with a breakpoint; protect the last one.
    const sysMarkers: number[] = [];
    for (let i = 0; i < system.length; i++) {
      if (blockHasBreakpoint(system[i]! as { cache_control?: { type: string } | null })) {
        sysMarkers.push(i);
      }
    }
    const toStrip = sysMarkers.slice(0, Math.min(toRemove, Math.max(0, sysMarkers.length - 1)));
    if (toStrip.length > 0) {
      const sysCopy = [...system];
      for (const idx of toStrip) {
        sysCopy[idx] = stripBreakpoint(sysCopy[idx]!);
        toRemove--;
      }
      system = sysCopy;
    }
  }

  return { system, tools, messages };
}
