/**
 * Pure event translator for the `anthropic-direct` provider.
 *
 * Converts an Anthropic SDK `RawMessageStreamEvent` async iterable into a
 * stream of {@link TranslateOutput} discriminated-union values. The harness
 * sees `{kind: 'event', ...}` items immediately; the loop consumes the final
 * `{kind: 'turn-result', ...}` to decide whether to dispatch tools and
 * continue or terminate the turn.
 *
 * No I/O, no SDK construction, no random IDs — `sessionId` is threaded in via
 * {@link TranslateCtx}. State lives entirely in the generator's local scope.
 *
 * @module agent/providers/anthropic-direct/translate
 */

import type {
  ContentBlockParam,
  RawMessageStreamEvent,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources';
import type { TranslateCtx, TranslateOutput, TurnResult } from './types.js';
import { env } from '../../../config/env.js';
import { incompleteStreamError, isStreamComplete } from './stream-completeness.js';

/**
 * Per-block accumulator. The block kind dictates which fields are populated
 * — text/thinking blocks accumulate strings, tool_use blocks accumulate a
 * partial JSON buffer that is parsed at `content_block_stop`, and
 * redacted_thinking carries an opaque server-encrypted payload delivered
 * whole at `content_block_start` (it has no deltas).
 */
type BlockAcc =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'tool_use'; id: string; name: string; partialJson: string };

/**
 * Best-effort parse of an accumulated tool-use input JSON buffer. Returns
 * `{}` when the buffer is empty or unparseable so the dispatcher always
 * receives a structurally valid object.
 */
function parseToolInput(partialJson: string): unknown {
  const trimmed = partialJson.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * Build the final {@link TurnResult} from accumulated per-block state.
 *
 * Blocks are emitted in original index order (sparse arrays preserve gaps,
 * which a misbehaving stream might produce; we filter undefined slots out).
 */
function buildTurnResult(
  blocks: Array<BlockAcc | undefined>,
  stopReason: string | null,
  usage: Usage | null,
): TurnResult {
  const assistantBlocks: ContentBlockParam[] = [];
  const textParts: string[] = [];

  for (const acc of blocks) {
    if (!acc) continue;
    if (acc.kind === 'text') {
      assistantBlocks.push({ type: 'text', text: acc.text });
      textParts.push(acc.text);
    } else if (acc.kind === 'thinking') {
      // API rejects thinking blocks with empty thinking or empty/invalid
      // signature. Drop incomplete blocks (e.g. stream ended mid-thinking
      // before signature_delta arrived).
      if (acc.thinking && acc.signature) {
        assistantBlocks.push({
          type: 'thinking',
          thinking: acc.thinking,
          signature: acc.signature,
        });
      }
    } else if (acc.kind === 'redacted_thinking') {
      // Invariant: redacted_thinking must be preserved VERBATIM in the
      // assistant turn. When extended thinking is enabled and the turn
      // contains tool_use, the Messages API requires the assistant message
      // to LEAD with a thinking/redacted_thinking block; dropping it makes
      // the next (continuation) request 400 — and because that malformed
      // turn persists in the session's reused messages array, every later
      // turn re-fails too (a permanent session wedge). The payload is
      // server-encrypted, has no signature to validate, and is always
      // round-trippable, so it is pushed unconditionally.
      assistantBlocks.push({ type: 'redacted_thinking', data: acc.data });
    } else {
      assistantBlocks.push({
        type: 'tool_use',
        id: acc.id,
        name: acc.name,
        input: parseToolInput(acc.partialJson),
      });
    }
  }

  const isToolUse = (b: ContentBlockParam): b is ToolUseBlock =>
    b.type === 'tool_use';
  const toolUseBlocks: ToolUseBlock[] = assistantBlocks.filter(isToolUse);

  return {
    stopReason,
    assistantBlocks,
    toolUseBlocks,
    usage,
    text: textParts.join(''),
  };
}

/**
 * Async generator that translates an Anthropic streaming response into
 * harness-shaped {@link TranslateOutput} items.
 *
 * Contract:
 * - Yields zero or more `{kind: 'event'}` items (delta.text, delta.reasoning,
 *   tool.use) interleaved with stream consumption.
 * - On graceful completion (`message_stop` or stream end), yields exactly one
 *   `{kind: 'turn-result'}` carrying the digested turn state.
 * - On stream throw or inline `error`-typed event, yields a final
 *   `{kind: 'event', event: {type: 'error', ...}}` and returns. Does NOT
 *   re-throw and does NOT emit a turn-result after an error.
 *
 * @param onRawProgress — optional callback invoked for every `content_block_delta`
 *   that this translator consumes WITHOUT yielding anything (`input_json_delta`,
 *   `signature_delta`, `citations_delta`, unknown delta kinds). Those spans are
 *   real provider output but invisible to a consumer watching only the yielded
 *   stream, so a caller enforcing a silence bound needs them; see the invariant
 *   at the `content_block_delta` case below. Deliberately NOT called for pings
 *   or unknown top-level frames — a keep-alive is not progress.
 */
export async function* translateMessageStream(
  events: AsyncIterable<RawMessageStreamEvent>,
  ctx: TranslateCtx,
  onRawProgress?: () => void,
): AsyncIterable<TranslateOutput> {
  const blocks: Array<BlockAcc | undefined> = [];
  let stopReason: string | null = null;
  let usage: Usage | null = null;
  let stopped = false;

  // Hoist the flag once — avoids a getter call on every streaming event.
  const traceEnabled = !!env.AFK_TELEGRAM_TRACE;

  try {
    if (traceEnabled) console.log('[translate] starting SDK event iteration');
    for await (const evt of events) {
      if (traceEnabled) console.log('[translate] SDK evt:', evt.type);
      switch (evt.type) {
        case 'message_start': {
          const startUsage = evt.message?.usage;
          if (startUsage) {
            usage = { ...startUsage };
          }
          break;
        }

        case 'content_block_start': {
          const cb = evt.content_block;
          if (cb.type === 'text') {
            blocks[evt.index] = { kind: 'text', text: '' };
          } else if (cb.type === 'thinking') {
            blocks[evt.index] = {
              kind: 'thinking',
              thinking: '',
              signature: '',
            };
          } else if (cb.type === 'redacted_thinking') {
            // Redacted reasoning is delivered whole here (no deltas), so
            // capture `data` at start. Preserved for round-trip; see
            // buildTurnResult. No visible event — the payload is opaque.
            blocks[evt.index] = { kind: 'redacted_thinking', data: cb.data };
          } else if (cb.type === 'tool_use') {
            blocks[evt.index] = {
              kind: 'tool_use',
              id: cb.id,
              name: cb.name,
              partialJson: '',
            };
            yield {
              kind: 'event' as const,
              event: {
                type: 'tool.use.start' as const,
                toolUseId: cb.id,
                toolName: cb.name,
                toolInput: ' …',
                // Arguments stream in after this frame via `input_json_delta`, so
                // `toolInput` above is a placeholder. `dispatchToolCalls` emits the
                // completed twin before execution; persisting consumers skip this one.
                pending: true,
                sessionId: ctx.sessionId,
              },
            };
          }
          break;
        }

        // Invariant: every branch below either YIELDS a translated event or
        // calls `onRawProgress` — never neither. A consumer bounding silence
        // (the post-first-byte stall watchdog, #762/#763) resets its window on
        // observable progress, and a content delta IS progress even when it
        // produces no visible event. `input_json_delta` in particular streams
        // an entire tool-call argument payload while yielding nothing between
        // `tool.use.start` and `tool.use`, so a large argument emission would
        // otherwise read as dead air and be aborted as a stall. Pings and
        // unknown top-level frames stay excluded on purpose: a wedged stream
        // that emits only keep-alives must still fire the watchdog.
        case 'content_block_delta': {
          const acc = blocks[evt.index];
          const delta = evt.delta;
          if (delta.type === 'text_delta') {
            if (acc && acc.kind === 'text') {
              acc.text += delta.text;
            }
            yield {
              kind: 'event',
              event: {
                type: 'delta.text',
                text: delta.text,
                sessionId: ctx.sessionId,
              },
            };
          } else if (delta.type === 'input_json_delta') {
            if (acc && acc.kind === 'tool_use') {
              acc.partialJson += delta.partial_json;
            }
            onRawProgress?.();
          } else if (delta.type === 'thinking_delta') {
            if (acc && acc.kind === 'thinking') {
              acc.thinking += delta.thinking;
            }
            yield {
              kind: 'event',
              event: {
                type: 'delta.reasoning',
                text: delta.thinking,
                sessionId: ctx.sessionId,
              },
            };
          } else if (delta.type === 'signature_delta') {
            if (acc && acc.kind === 'thinking') {
              acc.signature = delta.signature;
            }
            onRawProgress?.();
          } else {
            // citations_delta and unknown delta kinds: no translated event, but
            // still provider output — count it as progress, never as silence.
            onRawProgress?.();
          }
          break;
        }

        case 'content_block_stop': {
          const acc = blocks[evt.index];
          if (acc && acc.kind === 'tool_use') {
            yield {
              kind: 'event',
              event: {
                type: 'tool.use',
                summary: acc.name,
                toolUseIds: [acc.id],
                sessionId: ctx.sessionId,
              },
            };
          }
          break;
        }

        case 'message_delta': {
          if (evt.delta && evt.delta.stop_reason !== undefined) {
            stopReason = evt.delta.stop_reason;
          }
          const deltaUsage = evt.usage;
          if (deltaUsage) {
            if (usage !== null) {
              usage.output_tokens = deltaUsage.output_tokens;
              if (deltaUsage.cache_creation_input_tokens != null) {
                usage.cache_creation_input_tokens =
                  deltaUsage.cache_creation_input_tokens;
              }
              if (deltaUsage.cache_read_input_tokens != null) {
                usage.cache_read_input_tokens =
                  deltaUsage.cache_read_input_tokens;
              }
              if (deltaUsage.input_tokens != null) {
                usage.input_tokens = deltaUsage.input_tokens;
              }
            } else {
              // No message_start usage captured — synthesize a minimal Usage.
              usage = {
                cache_creation: null,
                cache_creation_input_tokens:
                  deltaUsage.cache_creation_input_tokens ?? null,
                cache_read_input_tokens:
                  deltaUsage.cache_read_input_tokens ?? null,
                inference_geo: null,
                input_tokens: deltaUsage.input_tokens ?? 0,
                output_tokens: deltaUsage.output_tokens,
                server_tool_use: null,
                service_tier: null,
              } as unknown as Usage;
            }
          }
          break;
        }

        case 'message_stop': {
          stopped = true;
          break;
        }

        default:
          // ping / unknown event types: ignore.
          break;
      }

      if (stopped) break;
    }
    if (traceEnabled) console.log('[translate] SDK iteration ended naturally, stopped=', stopped);
  } catch (err) {
    if (traceEnabled) console.log('[translate] SDK iteration threw:', (err as Error).message);
    const error = err instanceof Error ? err : new Error(String(err));
    yield { kind: 'event', event: { type: 'error', error } };
    return;
  }

  // Incomplete stream (no message_stop AND no stop_reason): report, never
  // silently yield the partial as a finished turn. Predicate, rationale, and
  // the deliberate absence of a cause claim all live in stream-completeness.ts.
  if (!isStreamComplete(stopped, stopReason)) {
    yield { kind: 'event', event: { type: 'error', error: incompleteStreamError() } };
    return;
  }

  if (traceEnabled) console.log('[translate] yielding turn-result');
  yield {
    kind: 'turn-result',
    result: buildTurnResult(blocks, stopReason, usage),
  };
}
