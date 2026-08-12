/**
 * Outbound request shaping and connection phase for one anthropic-direct round.
 *
 * Owns everything from "we are about to call the model" up to "we hold a live
 * event stream": the wire projection of tool definitions, the prompt-cache
 * breakpoint stamp, the params build, the connection-phase 529/503 retry, and
 * the arming of both stall watchdogs.
 *
 * Invariant: on a successful open, the two watchdog handles are returned LIVE
 * and their disposal becomes the stream consumer's responsibility. Only the
 * failure and TTFB-re-drive paths dispose here — do not add a blanket
 * `finally`, which would disarm the timers the caller still needs.
 *
 * @module agent/providers/anthropic-direct/loop/round-request
 */

import type { ProviderEvent } from '../../../provider.js';
import type {
  AnthropicMessagesCreateParams,
  AnthropicToolDef,
  RunTurnInput,
  WireToolDef,
} from '../types.js';
import { annotateFastError } from '../query/turn-request.js';
import { getCacheTtl, isCacheEnabled, withMessagesBreakpoint } from '../cache-policy.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import {
  armFirstByteTimeout,
  throttleExtensionMs,
  type FirstByteTimeoutHandle,
} from '../../shared/first-byte-timeout.js';
import { armStreamStallWatchdog, type StreamStallHandle } from '../../shared/stream-stall-timeout.js';
import { jitterBackoff } from '../overload-pause.js';
import {
  OVERLOAD_BASE_DELAY_MS,
  OVERLOAD_MAX_RETRIES,
  type RoundRetryBudget,
  isTransientServerError,
} from './retry-budget.js';
import { awaitCreateWithThrottleSignals } from './throttle-signals.js';
import { dumpThinkingDiagnostic } from './thinking-diagnostic.js';
import type { TurnAccumulator } from './turn-accumulator.js';

/**
 * Contract: project an internal {@link AnthropicToolDef} to the wire-safe shape
 * the Anthropic Messages API actually accepts.
 *
 * Strips internal classification metadata (`category`, `concurrencySafe`,
 * `riskClass`) that would otherwise trip a 400
 * `tools.0.custom.<field>: Extra inputs are not permitted` on `messages.create`.
 *
 * The wire boundary type (`AnthropicMessagesCreateParams.tools: WireToolDef[]`)
 * forces every call site to go through a projection like this one — keep it
 * that way.
 */
export function toWireTool(tool: AnthropicToolDef): WireToolDef {
  const { name, description, input_schema } = tool;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    input_schema,
  };
}

/**
 * Sentinel thrown by `createWithRetry` (only) when the connection-phase 529/503
 * budget is exhausted. Distinct from the generic Error so `openRound`'s catch
 * block can route exhausted transient errors to the `overload-exhausted` outcome
 * instead of the fatal error path (M6 — the same gap that #762 fixed for the
 * mid-stream phase).
 */
class ConnectionOverloadExhaustedError extends Error {
  constructor() {
    super('Connection-phase overload budget exhausted');
    this.name = 'ConnectionOverloadExhaustedError';
  }
}

// `requestSignal` is passed to `messages.create` — it is the caller's turn
// signal chained with the per-request TTFB stall timer (see armFirstByteTimeout),
// so aborting it covers BOTH a user interrupt and a first-byte timeout. The
// 529/503 connection-phase backoff sleeps still gate on the caller's `turnSignal`
// so a persistent overload wakes on interrupt but not on the TTFB timer alone.
async function createWithRetry(
  client: { messages: { create(params: unknown, opts: unknown): unknown } },
  params: AnthropicMessagesCreateParams,
  headers: Record<string, string>,
  requestSignal: AbortSignal,
  turnSignal: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      // Jittered (#762): concurrent sessions hitting the same 529 must not
      // retry in lockstep. Additive, so the documented minimum still holds.
      const delay = jitterBackoff(OVERLOAD_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      await sleepWithAbort(delay, turnSignal);
      if (turnSignal.aborted) throw new Error('aborted');
    }
    try {
      return (await Promise.resolve(
        client.messages.create(params, { headers, signal: requestSignal }),
      )) as AsyncIterable<unknown>;
    } catch (err) {
      if (requestSignal.aborted) throw err;
      const e = err instanceof Error ? err : new Error(String(err));
      if (isTransientServerError(e)) {
        if (attempt < OVERLOAD_MAX_RETRIES) continue;
        // Budget exhausted: signal the caller with a typed sentinel so it can
        // route to the CLEAN overload terminal instead of the fatal error path.
        throw new ConnectionOverloadExhaustedError();
      }
      throw e;
    }
  }
}


/** A live model call: the event stream plus the watchdogs guarding it. */
export interface OpenRoundTransport {
  kind: 'opened';
  events: AsyncIterable<unknown>;
  ttfb: FirstByteTimeoutHandle;
  stall: StreamStallHandle;
  /** When `messages.create` was initiated, for the `model_ttfb` duration. */
  requestStartedAt: number;
}

/**
 * Outcome of trying to open one round's model call.
 *
 * - `opened` — a live stream; the caller owns watchdog disposal from here.
 * - `retry-ttfb` — first-byte stall before any content; watchdogs already
 *   disposed, caller should re-drive the round (budget permitting).
 * - `overload-exhausted` — connection-phase 529/503 budget exhausted; the
 *   caller should route to the CLEAN overload terminal rather than the fatal
 *   error path (M6: same structural gap that existed for mid-stream exhaustion
 *   before #762; both should reach the pause machinery).
 * - `terminated` — a terminal event was already yielded; the turn is over.
 */
export type OpenRoundResult =
  | OpenRoundTransport
  | { kind: 'retry-ttfb'; requestStartedAt: number }
  | { kind: 'overload-exhausted' }
  | { kind: 'terminated' };

/** Everything the connection phase needs from the enclosing turn. */
export interface OpenRoundContext {
  input: RunTurnInput;
  turn: TurnAccumulator;
  /** Read-only here: consulted for the counted per-round TTFB allowance. */
  retry: RoundRetryBudget;
  /** Per-ATTEMPT first-byte bound (already divided by TTFB_MAX_ATTEMPTS). */
  ttfbTimeoutMs: number;
  stallTimeoutMs: number;
}

export function buildRoundParams(input: Pick<RunTurnInput, 'model' | 'maxTokens' | 'messages' | 'system' | 'tools' | 'thinking' | 'effort' | 'fastMode'>): AnthropicMessagesCreateParams {
  return {
    model: input.model, max_tokens: input.maxTokens, messages: input.messages, stream: true,
    ...(input.system !== null ? { system: input.system } : {}),
    ...(input.tools !== null && input.tools.length > 0 ? { tools: input.tools.map(toWireTool) } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.effort !== undefined ? { output_config: { effort: input.effort } } : {}),
    ...(input.fastMode === true ? { speed: 'fast' as const } : {}),
  };
}

/**
 * Build this round's request, send it, and hand back a live event stream.
 *
 * Yields any `rate_limit` events surfaced while the create promise is parked.
 */
export async function* openRound({
  input,
  turn,
  retry,
  ttfbTimeoutMs,
  stallTimeoutMs,
}: OpenRoundContext): AsyncGenerator<ProviderEvent, OpenRoundResult, void> {
  // Stamp a prompt-cache breakpoint on the last content block of the last
  // message before sending — non-mutating clone-and-stamp so the marker never
  // accumulates back into stored history. Cache lookup walks back over
  // prefix-hash matches up to a 20-block window, so the moving marker still
  // hits prior writes within the tool-use loop and across consecutive turns.
  const messagesForRequest = isCacheEnabled({ baseUrl: input.baseUrl })
    ? withMessagesBreakpoint(input.messages, getCacheTtl())
    : input.messages;

  const params: AnthropicMessagesCreateParams = buildRoundParams({
    ...input,
    messages: messagesForRequest,
    // Wind-down round: omit tools so the model must produce text.
    tools: turn.windDownReason !== null ? null : input.tools,
  });

  // Witness layer: stamp request-initiation time so the model_ttfb phase can
  // report time-to-first-byte for THIS model API call.
  const requestStartedAt = Date.now();
  // Arm the TTFB stall timer for THIS round. `ttfb.signal` is the request
  // signal (caller's turn signal chained with the stall timer). The stream
  // consumer cancels the timer the instant the first CONTENT token arrives, so
  // a stream that is producing content is never aborted; only a call that fails
  // to stream any content token (text/thinking delta, tool_use, or the
  // end-of-stream turn-result) within the bound trips it. message_start and
  // keep-alive pings yield no translated output, so they do NOT count — a call
  // whose FIRST token is slower than the bound is treated as a stall.
  const ttfb = armFirstByteTimeout(input.signal, ttfbTimeoutMs);
  // Arm the POST-first-byte stall watchdog for THIS round, CHAINED onto
  // `ttfb.signal` so the request signal carries all three abort sources (user
  // interrupt → TTFB stall → mid-stream stall) in one linked signal. It stays
  // DORMANT until the first translated event calls `stall.progress()`, so the
  // pre-first-byte window remains governed solely by the TTFB bound and the two
  // can never both be pending. Every subsequent event re-arms it, so only
  // genuine silence — not slowness — can fire it.
  const stall = armStreamStallWatchdog(ttfb.signal, stallTimeoutMs, (info) => {
    // Witness layer: reuse the `idle_watchdog_fired` phase — the established
    // vocabulary for "a progress-aware watchdog fired on unexplained silence"
    // (subagent/idle-watchdog.ts). `source` distinguishes this provider-stream
    // fire from a forked sub-agent's. Fire-and-forget; a slow trace write must
    // never delay the abort.
    void emitSessionPhase(input.traceWriter, {
      phase: 'idle_watchdog_fired',
      durationMs: info.elapsedSinceLastProgressMs,
      resolvedModel: input.model,
      metadata: {
        source: 'model-stream',
        stallTimeoutMs: info.stallTimeoutMs,
        elapsedSinceLastProgressMs: info.elapsedSinceLastProgressMs,
      },
    });
  });

  try {
    // Race the create await against the out-of-band throttle queue so a
    // 429/503/529 backoff the SDK sleeps out INSIDE this call surfaces as a
    // LIVE `rate_limit` event (see awaitCreateWithThrottleSignals). Without the
    // queue this is a plain `await createWithRetry(...)`. The generator's return
    // value is the resolved stream iterable; a create rejection propagates here
    // exactly as a direct await would.
    const events = yield* awaitCreateWithThrottleSignals(
      createWithRetry(
        input.client,
        params,
        input.headers,
        // `stall.signal` is `ttfb.signal` chained with the mid-stream stall
        // watchdog, so the one request signal covers user interrupt + TTFB
        // stall + post-first-byte stall. When either watchdog is disabled its
        // arm() returns the base signal unchanged, so this degrades cleanly.
        stall.signal,
        input.signal,
      ),
      input,
      // Invariant: the TTFB bound is armed ABOVE this call, so its window spans
      // connect + every 429/503/529 backoff the SDK sleeps out INSIDE
      // messages.create + prefill — not prefill alone. Under sustained
      // throttling the backoff alone can consume most of the default 180s
      // (throttle-signals.ts documents ~140s for two retries), so the bound
      // fires on a request that was never given a chance to stream and the
      // failure is reported as a first-byte stall. Forgive only EXPLAINED
      // waiting: extend by the provider's own retry-after (plus slack), and
      // leave the bound untouched when no window was communicated, so
      // unexplained silence still trips on schedule. Same policy the forked
      // subagent idle watchdog applies via pause-window.ts.
      (retryAfterMs) => {
        const extension = throttleExtensionMs(retryAfterMs);
        if (extension !== undefined) ttfb.extend(extension);
      },
    );
    return { kind: 'opened', events, ttfb, stall, requestStartedAt };
  } catch (err) {
    // A TTFB timeout aborts before the first byte (connection-phase stall).
    // Distinguish it from a user interrupt (input.signal) and, while the
    // round's counted TTFB budget holds allowance, re-drive instead of
    // erroring.
    if (ttfb.timedOut() && !input.signal.aborted && retry.canRetryTtfb()) {
      ttfb.dispose();
      stall.dispose();
      return { kind: 'retry-ttfb', requestStartedAt };
    }
    ttfb.dispose();
    stall.dispose();
    if (input.signal.aborted) {
      yield {
        type: 'turn.completed',
        usage: turn.terminalUsage(),
        sessionId: input.ctx.sessionId,
      };
      return { kind: 'terminated' };
    }
    // M6: connection-phase 529/503 budget exhausted. Route to the CLEAN overload
    // terminal (same path as mid-stream exhaustion) so the pause machinery in
    // `overload-pause-tier.ts` can park-and-probe rather than hard-aborting the
    // session. The sentinel type lets us distinguish this from every other error
    // without modifying `isTransientServerError` or the outer type union.
    if (err instanceof ConnectionOverloadExhaustedError) {
      return { kind: 'overload-exhausted' };
    }
    const e = annotateFastError(err, input.fastMode === true);
    if (e.message.includes('thinking')) {
      dumpThinkingDiagnostic(input.messages, e);
    }
    yield { type: 'error', error: e };
    return { kind: 'terminated' };
  }
}
